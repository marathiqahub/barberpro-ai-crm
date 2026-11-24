'use strict';
const express=require('express');
const rateLimit=require('express-rate-limit');
const crypto=require('node:crypto');
const argon2=require('argon2');
const ExcelJS=require('exceljs');
const {createAuthMiddleware}=require('../auth/middleware');
const {generateSecret,encryptSecret,decryptSecret,matchingTotpStep,verifyTotp,otpauthUri}=require('../advanced/totp');
const {toCsv,parseCsv}=require('../advanced/csv');
const {scheduleAppointmentReminders}=require('../messaging/reminders');

function createAdvancedRouter(pool,tokenService){
 const r=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokenService);
 const customer=[authenticate,requireRole('CUSTOMER')],barber=[authenticate,requireRole('BARBER')],admin=[authenticate,requireRole('ADMIN')];
 const wrap=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
 const enrollmentLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many authenticator verification attempts. Try again later.'}});
 const id=v=>/^[1-9]\d*$/.test(String(v))?Number(v):null;
 const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 const hmac=(secret,value)=>crypto.createHmac('sha256',secret).update(value).digest('hex');
 const safeEqual=(a,b)=>{const x=Buffer.from(String(a||''),'hex'),y=Buffer.from(String(b||''),'hex');return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);};
 async function shopAccess(user,shopId){if(user.role==='ADMIN')return true;const q=await pool.query('SELECT 1 FROM shop_staff WHERE shop_id=$1 AND user_id=$2 AND is_active=TRUE',[shopId,user.id]);return q.rowCount>0;}
 async function featureEnabled(shopId,feature){
  const sub=await pool.query(`SELECT p.feature_entitlements FROM shop_subscriptions ss JOIN barberpro_subscription_plans p ON p.id=ss.plan_id
   WHERE ss.shop_id=$1 AND ss.status='ACTIVE' ORDER BY ss.created_at DESC LIMIT 1`,[shopId]);
  if(!sub.rowCount)return true; // Existing shops remain in legacy/trial mode until subscription activation.
  return sub.rows[0].feature_entitlements?.[feature]===true;
 }
 async function barberStaff(user,staffId){const q=await pool.query('SELECT id,shop_id,display_name FROM shop_staff WHERE id=$1 AND user_id=$2 AND is_active=TRUE',[staffId,user.id]);return q.rows[0]||null;}
 async function razorpay(path,method,body){const key=process.env.RAZORPAY_KEY_ID,secret=process.env.RAZORPAY_KEY_SECRET;if(!key||!secret)throw Object.assign(new Error('Razorpay credentials are not configured.'),{status:503});const response=await fetch('https://api.razorpay.com/v1'+path,{method,headers:{Authorization:'Basic '+Buffer.from(key+':'+secret).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error?.description||'Razorpay request failed.'),{status:502});return data;}

 // Customer-selected locale is persisted on the account and used as the messaging fallback.
 r.get('/customer/preferences',...customer,wrap(async(q,s)=>{const out=await pool.query('SELECT preferred_locale FROM users WHERE id=$1',[q.user.id]);s.json({preferredLocale:out.rows[0]?.preferred_locale||'en'});}));
 r.put('/customer/preferences',...customer,wrap(async(q,s)=>{const locale=q.body?.preferredLocale;if(!['en','hi','mr'].includes(locale))return s.status(400).json({error:'preferredLocale must be en, hi or mr.'});await pool.query('UPDATE users SET preferred_locale=$2,updated_at=NOW() WHERE id=$1',[q.user.id,locale]);s.json({preferredLocale:locale});}));

 // Reschedule in place: same shop, service and barber; free only outside the shop's cutoff window.
 r.post('/appointments/:appointmentId/reschedule',...customer,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId),start=new Date(q.body?.startsAt);
  if(!appointmentId||!q.body?.startsAt||!Number.isFinite(start.getTime())||start<=new Date())return s.status(400).json({error:'Provide a valid future startsAt timestamp.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const found=await c.query(`SELECT a.*,sv.duration_minutes,sv.cleanup_minutes,sh.timezone,COALESCE(p.free_reschedule_before_hours,4) free_hours
    FROM appointments a JOIN services sv ON sv.id=a.service_id JOIN shops sh ON sh.id=a.shop_id
    LEFT JOIN shop_reschedule_policies p ON p.shop_id=a.shop_id
    WHERE a.id=$1 AND a.customer_id=$2 FOR UPDATE OF a`,[appointmentId,q.user.id]);
   if(!found.rowCount){await c.query('ROLLBACK');return s.status(404).json({error:'Appointment not found.'});}
   const a=found.rows[0];if(!['BOOKED','CONFIRMED'].includes(a.status)){await c.query('ROLLBACK');return s.status(409).json({error:'Only booked or confirmed appointments can be rescheduled.'});}
   if(new Date(a.starts_at)<=new Date(Date.now()+Number(a.free_hours)*3600000)){await c.query('ROLLBACK');return s.status(409).json({error:'Free rescheduling is available only before the shop cutoff window.',freeRescheduleBeforeHours:Number(a.free_hours)});}
   const newEnd=new Date(start.getTime()+Number(a.duration_minutes)*60000),bufferEnd=new Date(newEnd.getTime()+Number(a.cleanup_minutes)*60000);
   const work=await c.query(`SELECT COALESCE(o.is_working_day,wh.is_active) active,
      COALESCE(o.opens_at,wh.opens_at) opens_at,COALESCE(o.closes_at,wh.closes_at) closes_at
     FROM staff_working_hours wh LEFT JOIN shop_staff_shift_overrides o ON o.staff_id=wh.staff_id AND o.work_date=($2::timestamptz AT TIME ZONE $3)::date
     WHERE wh.staff_id=$1 AND wh.day_of_week=EXTRACT(DOW FROM ($2::timestamptz AT TIME ZONE $3))::int`,
    [a.staff_id,start.toISOString(),a.timezone]);
   if(!work.rowCount||!work.rows[0].active){await c.query('ROLLBACK');return s.status(409).json({error:'The same barber is not working on the selected date.'});}
   const local=await c.query(`SELECT ($1::timestamptz AT TIME ZONE $2)::time AS starts,($3::timestamptz AT TIME ZONE $2)::time AS ends,EXTRACT(MINUTE FROM ($1::timestamptz AT TIME ZONE $2))::int minute,EXTRACT(SECOND FROM ($1::timestamptz AT TIME ZONE $2))::int second`,[start.toISOString(),a.timezone,bufferEnd.toISOString()]);
   if(local.rows[0].minute%15!==0||local.rows[0].second!==0||local.rows[0].starts<work.rows[0].opens_at||local.rows[0].ends>work.rows[0].closes_at){await c.query('ROLLBACK');return s.status(409).json({error:'The selected time is outside the barber\'s working hours, including cleanup buffer.'});}
   const blocked=await c.query(`SELECT 1 FROM staff_time_off t WHERE t.staff_id=$1 AND tstzrange(t.starts_at,t.ends_at,'[)') && tstzrange($2,$3,'[)')
    UNION ALL SELECT 1 FROM appointments x WHERE x.staff_id=$1 AND x.id<>$4 AND x.status IN('BOOKED','CONFIRMED')
      AND tstzrange(x.starts_at,x.buffer_ends_at,'[)') && tstzrange($2,$3,'[)') LIMIT 1`,[a.staff_id,start.toISOString(),bufferEnd.toISOString(),appointmentId]);
   if(blocked.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'That time is no longer available for the same barber.'});}
   const updated=await c.query('UPDATE appointments SET starts_at=$2,ends_at=$3,updated_at=NOW() WHERE id=$1 RETURNING id,starts_at,ends_at,status',[appointmentId,start.toISOString(),newEnd.toISOString()]);
   await c.query("UPDATE shop_customer_reminders SET status='CANCELLED',processing_at=NULL WHERE appointment_id=$1 AND template_key IN('APPOINTMENT_REMINDER_24H','APPOINTMENT_REMINDER_2H') AND status IN('PENDING','PROCESSING')",[appointmentId]);
   await scheduleAppointmentReminders(c,{id:appointmentId,shop_id:a.shop_id,customer_id:a.customer_id,starts_at:start.toISOString()},{transactional:true});
   await c.query('INSERT INTO shop_appointment_reschedules(appointment_id,shop_id,customer_id,old_starts_at,new_starts_at,free_of_charge) VALUES($1,$2,$3,$4,$5,TRUE)',[appointmentId,a.shop_id,q.user.id,a.starts_at,start.toISOString()]);
   await c.query(`INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,$2,'APPOINTMENT_RESCHEDULED','APPOINTMENT',$3,$4::jsonb)`,[a.shop_id,q.user.id,String(appointmentId),JSON.stringify({from:a.starts_at,to:start.toISOString(),staffId:a.staff_id})]);
   await c.query('COMMIT');s.json({appointment:updated.rows[0],staffId:a.staff_id,freeOfCharge:true});
  }catch(e){await c.query('ROLLBACK');if(e.code==='23P01')return s.status(409).json({error:'That barber already has an appointment at the selected time.'});throw e;}finally{c.release();}
 }));

 // Small, private, consent-backed booking reference images are stored as BYTEA and purged after 90 days.
 r.post('/appointments/:appointmentId/reference-photo',...customer,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId),type=q.body?.contentType,data=q.body?.imageBase64;
  if(!appointmentId||q.body?.consent!==true||!['image/jpeg','image/png','image/webp'].includes(type)||typeof data!=='string')return s.status(400).json({error:'Appointment, supported image type, imageBase64 and explicit consent are required.'});
  const encoded=data.replace(/^data:image\/(?:jpeg|png|webp);base64,/i,'');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return s.status(400).json({error:'Reference photo is not valid base64 data.'});
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>524288)return s.status(413).json({error:'Reference photos must be 512 KB or smaller.'});
  const validImage=type==='image/jpeg'?bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff:
   type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])):
   bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!validImage)return s.status(400).json({error:'Image bytes do not match the selected content type.'});
  const a=await pool.query(`SELECT id,shop_id,customer_id,status FROM appointments WHERE id=$1 AND customer_id=$2 AND status IN('BOOKED','CONFIRMED')`,[appointmentId,q.user.id]);
  if(!a.rowCount)return s.status(404).json({error:'Upcoming appointment not found.'});
  if(!await featureEnabled(a.rows[0].shop_id,'REFERENCE_PHOTOS'))return s.status(403).json({error:'Reference photos are not included in this shop subscription.'});
  await pool.query('DELETE FROM shop_appointment_reference_photos WHERE appointment_id=$1',[appointmentId]);
  const saved=await pool.query(`INSERT INTO shop_appointment_reference_photos(appointment_id,shop_id,customer_id,content_type,image_bytes,consent_version)
    VALUES($1,$2,$3,$4,$5,'booking-reference-v1') RETURNING id,retention_until,uploaded_at`,[appointmentId,a.rows[0].shop_id,q.user.id,type,bytes]);
  s.status(201).json({photo:saved.rows[0],retentionDays:90});
 }));
 r.get('/appointments/:appointmentId/reference-photo',authenticate,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId);if(!appointmentId)return s.sendStatus(400);
  const found=await pool.query(`SELECT p.content_type,p.image_bytes,p.retention_until,a.customer_id,a.staff_id,st.user_id AS barber_user_id
   FROM shop_appointment_reference_photos p JOIN appointments a ON a.id=p.appointment_id JOIN shop_staff st ON st.id=a.staff_id
   WHERE p.appointment_id=$1 AND p.retention_until>NOW() ORDER BY p.uploaded_at DESC LIMIT 1`,[appointmentId]);
  if(!found.rowCount)return s.sendStatus(404);const p=found.rows[0];
  if(q.user.role!=='ADMIN'&&String(q.user.id)!==String(p.customer_id)&&String(q.user.id)!==String(p.barber_user_id))return s.sendStatus(404);
  s.set('Cache-Control','private, no-store').type(p.content_type).send(p.image_bytes);
 }));

 // Digital chemical-service consent. Completion is blocked by a database trigger until this signed record exists.
 r.post('/appointments/:appointmentId/chemical-consent',...customer,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId),b=q.body||{},answers=b.answers||{};
  if(!appointmentId||typeof b.signatureName!=='string'||b.signatureName.trim().toLowerCase()!==q.user.name.trim().toLowerCase()||b.consent!==true||
    typeof answers.allergyDetails!=='string'||answers.allergyDetails.length>1000||typeof answers.patchTestCompleted!=='boolean'||typeof answers.scalpCondition!=='string'||answers.scalpCondition.length>500)
    return s.status(400).json({error:'Complete the allergy, scalp condition and patch-test fields, explicitly consent, and sign using your account name.'});
  const a=await pool.query(`SELECT a.id,a.shop_id,a.customer_id,a.service_id,sv.chemical_consent_required,a.status
    FROM appointments a JOIN services sv ON sv.id=a.service_id WHERE a.id=$1 AND a.customer_id=$2`,[appointmentId,q.user.id]);
  if(!a.rowCount||!a.rows[0].chemical_consent_required||!['BOOKED','CONFIRMED'].includes(a.rows[0].status))return s.status(404).json({error:'A matching upcoming chemical-service appointment was not found.'});
  if(!await featureEnabled(a.rows[0].shop_id,'CHEMICAL_CONSENT'))return s.status(403).json({error:'Digital chemical consent is not included in this shop subscription.'});
  const saved=await pool.query(`INSERT INTO shop_chemical_service_consents(appointment_id,shop_id,customer_id,service_id,answers,signature_name,notice_version,signer_ip)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,'chemical-consent-v1',$7::inet)
    ON CONFLICT(appointment_id,customer_id) DO UPDATE SET answers=EXCLUDED.answers,signature_name=EXCLUDED.signature_name,notice_version=EXCLUDED.notice_version,signed_at=NOW(),signer_ip=EXCLUDED.signer_ip
    RETURNING id,signed_at,signature_name`,[appointmentId,a.rows[0].shop_id,q.user.id,a.rows[0].service_id,JSON.stringify(answers),b.signatureName.trim(),q.ip||null]);
  s.status(201).json({consent:saved.rows[0]});
 }));
 r.get('/barber/appointments/:appointmentId/chemical-consent',...barber,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId);
  const out=await pool.query(`SELECT c.id,c.answers,c.signature_name,c.notice_version,c.signed_at
   FROM shop_chemical_service_consents c JOIN appointments a ON a.id=c.appointment_id JOIN shop_staff st ON st.id=a.staff_id
   WHERE a.id=$1 AND st.user_id=$2`,[appointmentId,q.user.id]);
  if(!out.rowCount)return s.sendStatus(404);s.json({consent:out.rows[0]});
 }));

 // Barber-created Razorpay Payment Links. Paid tips are included in payroll tip earnings.
 r.post('/barber/appointments/:appointmentId/tip-link',...barber,wrap(async(q,s)=>{
  const appointmentId=id(q.params.appointmentId),amount=Number(q.body?.amountPaise);
  if(!appointmentId||!Number.isSafeInteger(amount)||amount<100||amount>10000000)return s.status(400).json({error:'Provide an appointment and tip between ₹1 and ₹100,000.'});
  const found=await pool.query(`SELECT a.id,a.shop_id,a.customer_id,a.status,u.name,u.email,u.phone,st.id staff_id
   FROM appointments a JOIN shop_staff st ON st.id=a.staff_id JOIN users u ON u.id=a.customer_id
   WHERE a.id=$1 AND st.user_id=$2`,[appointmentId,q.user.id]);
  if(!found.rowCount||found.rows[0].status!=='COMPLETED')return s.status(404).json({error:'Completed appointment assigned to you was not found.'});
  const a=found.rows[0];if(!await featureEnabled(a.shop_id,'TIPS'))return s.status(403).json({error:'Digital tip links are not included in this shop subscription.'});
  const link=await razorpay('/payment_links','POST',{amount,currency:'INR',accept_partial:false,description:'BarberPro tip for appointment #'+appointmentId,customer:{name:a.name,email:a.email,contact:a.phone||undefined},notify:{sms:false,email:false},reminder_enable:false,reference_id:'tip_'+appointmentId+'_'+Date.now(),notes:{appointmentId:String(appointmentId),shopId:String(a.shop_id),barberStaffId:String(a.staff_id),customerId:String(a.customer_id),type:'BARBER_TIP'}});
  const saved=await pool.query(`INSERT INTO shop_barber_tips(shop_id,appointment_id,customer_id,staff_id,amount_paise,razorpay_payment_link_id,short_url,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,amount_paise,short_url,status,created_at`,[a.shop_id,appointmentId,a.customer_id,a.staff_id,amount,link.id,link.short_url,q.user.id]);
  await pool.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key,metadata)
   SELECT $1,$2,$3,c.channel,'TIP_PAYMENT_LINK',NOW(),'tip:'||$4::text||':'||c.channel,jsonb_build_object('tipPaymentLink',$5)
   FROM shop_message_consents c JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND c.channel=ANY(m.enabled_channels)
   JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key='TIP_PAYMENT_LINK' AND t.is_active=TRUE
   WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.consent=TRUE AND c.revoked_at IS NULL
   ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,[a.shop_id,a.customer_id,appointmentId,saved.rows[0].id,link.short_url]);
  s.status(201).json({tip:saved.rows[0],paymentLink:link.short_url,provider:'RAZORPAY',message:'Payment link queued for opted-in channels with an active TIP_PAYMENT_LINK template; share the URL directly if no template is configured. Payment is confirmed only by the Razorpay webhook.'});
 }));
 r.get('/barber/tips',...barber,wrap(async(q,s)=>{
  const staff=await pool.query('SELECT id,shop_id FROM shop_staff WHERE user_id=$1 AND is_active=TRUE',[q.user.id]);
  if(!staff.rowCount)return s.json({tips:[],totalPaidPaise:0});
  const out=await pool.query(`SELECT t.id,t.appointment_id,t.amount_paise,t.status,t.paid_at,t.created_at,st.display_name
   FROM shop_barber_tips t JOIN shop_staff st ON st.id=t.staff_id WHERE t.staff_id=ANY($1::bigint[]) ORDER BY t.created_at DESC LIMIT 200`,[staff.rows.map(x=>x.id)]);
  s.json({tips:out.rows,totalPaidPaise:out.rows.filter(x=>x.status==='PAID').reduce((n,x)=>n+Number(x.amount_paise),0)});
 }));

 // Barber shift changes are requests only. Admin approval writes dated overrides or time-off records and an audit event.
 r.post('/barber/shift-requests',...barber,wrap(async(q,s)=>{
  const staffId=id(q.body?.staffId),targetId=q.body?.targetStaffId? id(q.body.targetStaffId):null,type=q.body?.requestType,workDate=q.body?.workDate,reason=String(q.body?.reason||'').slice(0,500);
  if(!staffId||!['TIME_OFF','SWAP'].includes(type)||!validDate(workDate)||workDate<new Date().toISOString().slice(0,10)||(type==='SWAP'&&!targetId)||(type==='TIME_OFF'&&targetId))return s.status(400).json({error:'Provide staffId, requestType, workDate and a targetStaffId only for swaps.'});
  const staff=await barberStaff(q.user,staffId);if(!staff)return s.sendStatus(404);
  if(!await featureEnabled(staff.shop_id,'WORKFORCE'))return s.status(403).json({error:'Shift management is not included in this shop subscription.'});
  if(targetId){const target=await pool.query('SELECT id FROM shop_staff WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[targetId,staff.shop_id]);if(!target.rowCount)return s.status(400).json({error:'Target barber must be active in the same shop.'});}
  const start=workDate+'T00:00:00+05:30',end=new Date(new Date(start).getTime()+86400000).toISOString();
  const out=await pool.query(`INSERT INTO shop_staff_shift_requests(shop_id,staff_id,request_type,target_staff_id,starts_at,ends_at,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[staff.shop_id,staffId,type,targetId,start,end,reason||null]);
  s.status(201).json({request:out.rows[0]});
 }));
 r.get('/barber/shift-requests',...barber,wrap(async(q,s)=>{
  const out=await pool.query(`SELECT r.*,st.display_name,target.display_name target_staff_name FROM shop_staff_shift_requests r
   JOIN shop_staff st ON st.id=r.staff_id LEFT JOIN shop_staff target ON target.id=r.target_staff_id
   WHERE st.user_id=$1 ORDER BY r.created_at DESC LIMIT 100`,[q.user.id]);s.json({requests:out.rows});
 }));
 r.get('/admin/shift-requests',...admin,wrap(async(q,s)=>{
  const status=['REQUESTED','APPROVED','DECLINED','CANCELLED'].includes(q.query.status)?q.query.status:'REQUESTED';
  const out=await pool.query(`SELECT r.*,sh.name shop_name,st.display_name staff_name,target.display_name target_staff_name
   FROM shop_staff_shift_requests r JOIN shops sh ON sh.id=r.shop_id JOIN shop_staff st ON st.id=r.staff_id
   LEFT JOIN shop_staff target ON target.id=r.target_staff_id WHERE r.status=$1 ORDER BY r.created_at`,[status]);s.json({requests:out.rows});
 }));
 r.post('/admin/shift-requests/:requestId/review',...admin,wrap(async(q,s)=>{
  const requestId=id(q.params.requestId),decision=q.body?.decision,note=String(q.body?.note||'').slice(0,500);
  if(!requestId||!['APPROVED','DECLINED'].includes(decision))return s.status(400).json({error:'decision must be APPROVED or DECLINED.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const req=await c.query('SELECT * FROM shop_staff_shift_requests WHERE id=$1 AND status=\'REQUESTED\' FOR UPDATE',[requestId]);
   if(!req.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'Pending shift request not found.'});}
   const x=req.rows[0];
   if(decision==='APPROVED'&&x.request_type==='TIME_OFF'){
    const conflict=await c.query(`SELECT 1 FROM appointments WHERE staff_id=$1 AND status IN('BOOKED','CONFIRMED')
     AND tstzrange(starts_at,buffer_ends_at,'[)') && tstzrange($2,$3,'[)') LIMIT 1`,[x.staff_id,x.starts_at,x.ends_at]);
    if(conflict.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'Cannot approve time off while the barber has booked appointments in that period.'});}
    await c.query('INSERT INTO staff_time_off(staff_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4)',[x.staff_id,x.starts_at,x.ends_at,x.reason||'Approved time off']);
   }
   if(decision==='APPROVED'&&x.request_type==='SWAP'){
    const date=new Date(new Date(x.starts_at).getTime()+19800000).toISOString().slice(0,10);
    const day=Number((await c.query('SELECT EXTRACT(DOW FROM $1::date)::int d',[date])).rows[0].d);
    const hours=await c.query('SELECT staff_id,opens_at,closes_at,is_active FROM staff_working_hours WHERE staff_id=ANY($1::bigint[]) AND day_of_week=$2',[ [x.staff_id,x.target_staff_id],day]);
    const a=hours.rows.find(h=>String(h.staff_id)===String(x.staff_id)),b=hours.rows.find(h=>String(h.staff_id)===String(x.target_staff_id));
    if(!a?.is_active||!b?.is_active){await c.query('ROLLBACK');return s.status(409).json({error:'Both barbers must have a scheduled shift on the requested date to swap.'});}
    const conflicts=await c.query(`SELECT 1 FROM appointments WHERE status IN('BOOKED','CONFIRMED') AND
      ((staff_id=$1 AND tstzrange(starts_at,buffer_ends_at,'[)') && tstzrange(($2::date+a.opens_at) AT TIME ZONE 'Asia/Kolkata',($2::date+a.closes_at) AT TIME ZONE 'Asia/Kolkata','[)'))
       OR (staff_id=$3 AND tstzrange(starts_at,buffer_ends_at,'[)') && tstzrange(($2::date+b.opens_at) AT TIME ZONE 'Asia/Kolkata',($2::date+b.closes_at) AT TIME ZONE 'Asia/Kolkata','[)'))) LIMIT 1`,[x.staff_id,date,x.target_staff_id]);
    if(conflicts.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'A booked appointment conflicts with the proposed swapped shift.'});}
    await c.query(`INSERT INTO shop_staff_shift_overrides(shop_id,staff_id,work_date,opens_at,closes_at,is_working_day,source_request_id)
      VALUES($1,$2,$3,$4,$5,TRUE,$6),($1,$7,$3,$8,$9,TRUE,$6)
      ON CONFLICT(staff_id,work_date) DO UPDATE SET opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,is_working_day=TRUE,source_request_id=EXCLUDED.source_request_id`,
      [x.shop_id,x.staff_id,date,b.opens_at,b.closes_at,requestId,x.target_staff_id,a.opens_at,a.closes_at]);
   }
   const saved=await c.query('UPDATE shop_staff_shift_requests SET status=$2,reviewed_by=$3,reviewed_at=NOW(),review_note=$4 WHERE id=$1 RETURNING *',[requestId,decision,q.user.id,note||null]);
   await c.query(`INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'SHIFT_REQUEST_'+$3,'SHIFT_REQUEST',$4,$5::jsonb)`,[x.shop_id,q.user.id,decision,String(requestId),JSON.stringify({staffId:x.staff_id,targetStaffId:x.target_staff_id})]);
   await c.query('COMMIT');s.json({request:saved.rows[0]});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));

 // Admin configures cleanup buffers and which services require signed chemical consent.
 r.patch('/admin/services/:serviceId/operations',...admin,wrap(async(q,s)=>{
  const serviceId=id(q.params.serviceId),cleanup=Number(q.body?.cleanupMinutes),chemical=q.body?.chemicalConsentRequired;
  if(!serviceId||!Number.isInteger(cleanup)||cleanup<0||cleanup>120||typeof chemical!=='boolean')return s.status(400).json({error:'Provide cleanupMinutes (0–120) and chemicalConsentRequired boolean.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const out=await c.query('UPDATE services SET cleanup_minutes=$2,chemical_consent_required=$3,updated_at=NOW() WHERE id=$1 RETURNING id,shop_id,name,cleanup_minutes,chemical_consent_required',[serviceId,cleanup,chemical]);
   if(!out.rowCount){await c.query('ROLLBACK');return s.sendStatus(404);}
   await c.query("UPDATE appointments SET ends_at=ends_at WHERE service_id=$1 AND status IN('BOOKED','CONFIRMED') AND starts_at>NOW()",[serviceId]);
   await c.query('COMMIT');s.json({service:out.rows[0]});
  }catch(e){await c.query('ROLLBACK');if(e.code==='23P01')return s.status(409).json({error:'The new cleanup buffer conflicts with existing bookings. Adjust the buffer or reschedule the affected appointments.'});throw e;}finally{c.release();}
 }));

 // CSV/Tally-oriented sales export. Tax mapping remains subject to the shop accountant's review.
 r.get('/admin/shops/:shopId/accounting-export.csv',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId),from=q.query.from,to=q.query.to;
  if(!shopId||!validDate(from)||!validDate(to)||from>to||(new Date(to)-new Date(from))/86400000>366)return s.status(400).json({error:'Provide shopId and a valid date range of at most one year.'});
  if(!await featureEnabled(shopId,'ACCOUNTING_EXPORT'))return s.status(403).json({error:'Accounting export is not included in this shop subscription.'});
  const invoices=await pool.query(`SELECT i.invoice_number,i.issue_date,i.document_type,i.customer_name,i.subtotal_paise,i.discount_paise,i.taxable_paise,i.cgst_paise,i.sgst_paise,i.igst_paise,i.total_paise,
   COALESCE((SELECT string_agg(p.method||':'||(p.amount_paise::text),';' ORDER BY p.method) FROM sales_invoice_payments p WHERE p.invoice_id=i.id),'UNPAID') payment_allocations
   FROM sales_invoices i WHERE i.shop_id=$1 AND i.issue_date BETWEEN $2::date AND $3::date AND i.status='ISSUED' ORDER BY i.issue_date,i.invoice_number`,[shopId,from,to]);
  if(!await shopAccess(q.user,shopId))return s.sendStatus(404);
  const rows=invoices.rows.map(i=>({'Voucher Date':i.issue_date,'Voucher Type':i.document_type,'Voucher Number':i.invoice_number,'Party Name':i.customer_name,'Sales Ledger':'Sales','Subtotal (INR)':(Number(i.subtotal_paise)/100).toFixed(2),'Discount (INR)':(Number(i.discount_paise)/100).toFixed(2),'Taxable Value (INR)':(Number(i.taxable_paise)/100).toFixed(2),'CGST (INR)':(Number(i.cgst_paise)/100).toFixed(2),'SGST (INR)':(Number(i.sgst_paise)/100).toFixed(2),'IGST (INR)':(Number(i.igst_paise)/100).toFixed(2),'Total (INR)':(Number(i.total_paise)/100).toFixed(2),'Payment Allocations':i.payment_allocations}));
  const headers=['Voucher Date','Voucher Type','Voucher Number','Party Name','Sales Ledger','Subtotal (INR)','Discount (INR)','Taxable Value (INR)','CGST (INR)','SGST (INR)','IGST (INR)','Total (INR)','Payment Allocations'];
  const csv=toCsv(rows,headers);s.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="barberpro-accounting-'+shopId+'-'+from+'-'+to+'.csv"').send('\uFEFF'+csv);
 }));

 // Bulk customer import. Imported records cannot sign in until they claim the account with their email and a password.
 r.post('/admin/shops/:shopId/customers/import',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId),file=q.body?.fileBase64,filename=String(q.body?.filename||'customers.csv');
  if(!shopId||typeof file!=='string'||file.length>4*1024*1024||!await shopAccess(q.user,shopId))return s.status(400).json({error:'Provide an authorized shop and a CSV/XLSX file up to 3 MB.'});
  if(!await featureEnabled(shopId,'CUSTOMER_IMPORT'))return s.status(403).json({error:'Bulk customer import is not included in this shop subscription.'});
  const bytes=Buffer.from(file,'base64');let rows;
  if(/\.csv$/i.test(filename))rows=parseCsv(bytes.toString('utf8').replace(/^\uFEFF/,''));
  else if(/\.xlsx$/i.test(filename)){
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const sheet=wb.worksheets[0];if(!sheet)return s.status(400).json({error:'Workbook has no worksheet.'});
   const headers=[];sheet.getRow(1).eachCell((cell,col)=>headers[col-1]=String(cell.text||'').trim());
   rows=[];sheet.eachRow((row,index)=>{if(index===1)return;const item={};headers.forEach((h,i)=>{item[h]=row.getCell(i+1).text||''});if(Object.values(item).some(v=>String(v).trim()))rows.push(item);});
  }else return s.status(400).json({error:'Only .csv and .xlsx files are supported.'});
  if(!rows.length||rows.length>5000)return s.status(400).json({error:'Import must contain between 1 and 5,000 customer rows.'});
  const map=q.body?.columnMapping||{},keys=Object.keys(rows[0]),findKey=(kind)=>map[kind]||keys.find(k=>k.toLowerCase().replace(/[^a-z]/g,'')===kind)||({name:keys.find(k=>/name/i.test(k)),email:keys.find(k=>/email/i.test(k)),phone:keys.find(k=>/phone|mobile/i.test(k))}[kind]);
  const nk=findKey('name'),ek=findKey('email'),pk=findKey('phone');if(!nk||!ek)return s.status(400).json({error:'Map at least name and email columns; phone is optional.'});
  let created=0,matched=0,skipped=0;const errors=[];const c=await pool.connect();
  try{await c.query('BEGIN');
   for(let i=0;i<rows.length;i++){const name=String(rows[i][nk]||'').trim().slice(0,120),email=String(rows[i][ek]||'').trim().toLowerCase(),phone=pk?String(rows[i][pk]||'').trim().slice(0,30):'';
    if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){skipped++;errors.push({row:i+2,error:'Valid name and email are required.'});continue;}
    const existing=await c.query(`SELECT id,role FROM users WHERE lower(email)=$1 OR ($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) ORDER BY id LIMIT 1 FOR UPDATE`,[email,phone]);
    let userId;
    if(existing.rowCount){if(existing.rows[0].role!=='CUSTOMER'){skipped++;errors.push({row:i+2,error:'Email or phone belongs to a non-customer account.'});continue;}userId=existing.rows[0].id;matched++;await c.query('UPDATE users SET name=$2,phone=COALESCE(NULLIF($3,\'\'),phone) WHERE id=$1',[userId,name,phone]);}
    else{const hash=await argon2.hash(crypto.randomBytes(32).toString('base64url'));const inserted=await c.query(`INSERT INTO users(name,email,phone,password_hash,role,is_active,imported_pending_activation) VALUES($1,$2,NULLIF($3,''),$4,'CUSTOMER',TRUE,TRUE) RETURNING id`,[name,email,phone,hash]);userId=inserted.rows[0].id;created++;}
    await c.query('INSERT INTO shop_customer_profiles(shop_id,customer_id) VALUES($1,$2) ON CONFLICT(shop_id,customer_id) DO NOTHING',[shopId,userId]);
   }
   await c.query('COMMIT');s.status(201).json({created,matched,skipped,errors:errors.slice(0,100),total:rows.length,claimAccountRequired:true});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));

 // TOTP authenticator enrollment for admins and barbers. Login requires a code once enabled.
 r.get('/auth/totp/status',authenticate,wrap(async(q,s)=>{if(!['ADMIN','BARBER'].includes(q.user.role))return s.sendStatus(403);const out=await pool.query('SELECT enabled FROM user_totp WHERE user_id=$1',[q.user.id]);s.json({enabled:Boolean(out.rows[0]?.enabled),requiredForPrivilegedLogin:process.env.TOTP_REQUIRED_FOR_PRIVILEGED==='true'});}));
 r.post('/auth/totp/enroll',authenticate,wrap(async(q,s)=>{
  if(!['ADMIN','BARBER'].includes(q.user.role))return s.sendStatus(403);
  const existing=await pool.query('SELECT enabled FROM user_totp WHERE user_id=$1',[q.user.id]);
  if(existing.rows[0]?.enabled)return s.status(409).json({error:'Authenticator is already enabled. Disable it with a current code before rotating the secret.'});
  const secret=generateSecret(),encrypted=encryptSecret(secret),enrollmentToken=crypto.randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO user_totp(user_id,pending_secret_encrypted,enrollment_token_hash,enrollment_expires_at,updated_at)
   VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes',NOW())
   ON CONFLICT(user_id) DO UPDATE SET pending_secret_encrypted=EXCLUDED.pending_secret_encrypted,
    enrollment_token_hash=EXCLUDED.enrollment_token_hash,enrollment_expires_at=EXCLUDED.enrollment_expires_at,updated_at=NOW()`,
   [q.user.id,encrypted,crypto.createHash('sha256').update(enrollmentToken).digest('hex')]);
  s.json({secret,enrollmentToken,otpauthUri:otpauthUri(secret,q.user.email),message:'Add this account to an authenticator app, then verify a current six-digit code.'});
 }));
 // One-time enrollment token is issued only after password verification; it cannot access any other API.
 r.post('/auth/totp/verify-enrollment',enrollmentLimiter,wrap(async(q,s)=>{
  const token=q.body?.enrollmentToken,code=q.body?.code;
  if(typeof token!=='string'||token.length<32||!/^[0-9]{6}$/.test(String(code||'')))return s.status(400).json({error:'A valid enrollment token and six-digit authenticator code are required.'});
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex'),c=await pool.connect();
  try{await c.query('BEGIN');
   const found=await c.query(`SELECT t.user_id,t.pending_secret_encrypted,u.name,u.email,u.role
    FROM user_totp t JOIN users u ON u.id=t.user_id
    WHERE t.enrollment_token_hash=$1 AND t.enrollment_expires_at>NOW() AND u.is_active=TRUE
    FOR UPDATE OF t`,[tokenHash]);
   if(!found.rowCount){await c.query('ROLLBACK');return s.status(401).json({error:'Authenticator enrollment token expired. Sign in again.'});}
   const x=found.rows[0],secret=decryptSecret(x.pending_secret_encrypted),step=matchingTotpStep(secret,code);
   if(step===null){await c.query('ROLLBACK');return s.status(400).json({error:'Authenticator code is invalid or expired.'});}
   await c.query(`UPDATE user_totp SET secret_encrypted=pending_secret_encrypted,pending_secret_encrypted=NULL,
    enrollment_token_hash=NULL,enrollment_expires_at=NULL,enabled=TRUE,last_verified_step=$2,updated_at=NOW() WHERE user_id=$1`,[x.user_id,step]);
   const user={id:x.user_id,name:x.name,email:x.email,role:x.role},pair=tokenService.issueTokenPair(user);
   await c.query('INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
    [pair.refreshId,user.id,pair.familyId,pair.refreshTokenHash,pair.refreshExpiresAt]);
   await c.query('COMMIT');
   s.json({enabled:true,user,tokens:{accessToken:pair.accessToken,refreshToken:pair.refreshToken,tokenType:'Bearer',expiresIn:900,refreshExpiresAt:pair.refreshExpiresAt.toISOString()}});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 r.post('/auth/totp/disable',authenticate,wrap(async(q,s)=>{
  if(!['ADMIN','BARBER'].includes(q.user.role))return s.sendStatus(403);
  const out=await pool.query('SELECT secret_encrypted,enabled,last_verified_step FROM user_totp WHERE user_id=$1',[q.user.id]);
  if(!out.rows[0]?.enabled)return s.status(400).json({error:'Authenticator is not enabled.'});
  const step=matchingTotpStep(decryptSecret(out.rows[0].secret_encrypted),q.body?.code);
  if(step===null||out.rows[0].last_verified_step!==null&&Number(out.rows[0].last_verified_step)>=step)return s.status(400).json({error:'A fresh, unused authenticator code is required to disable 2FA.'});
  if(process.env.TOTP_REQUIRED_FOR_PRIVILEGED==='true')return s.status(403).json({error:'Two-factor authentication is required by platform policy and cannot be disabled here.'});
  await pool.query('UPDATE user_totp SET secret_encrypted=NULL,pending_secret_encrypted=NULL,enabled=FALSE,last_verified_step=$2,updated_at=NOW() WHERE user_id=$1',[q.user.id,step]);s.json({enabled:false});
 }));

 // Plan catalog and Razorpay Subscriptions for BarberPro shop billing.
 r.get('/subscription-plans',authenticate,wrap(async(q,s)=>{const out=await pool.query('SELECT id,code,name,billing_period,amount_paise,feature_entitlements FROM barberpro_subscription_plans WHERE is_active=TRUE ORDER BY amount_paise');s.json({plans:out.rows});}));
 r.post('/admin/subscription-plans',...admin,wrap(async(q,s)=>{
  const b=q.body||{},code=String(b.code||'').toLowerCase(),name=String(b.name||'').trim(),period=b.billingPeriod,amount=Number(b.amountPaise),features=b.featureEntitlements||{};
  if(!features||typeof features!=='object'||Array.isArray(features))return s.status(400).json({error:'featureEntitlements must be a JSON object of boolean feature flags.'});
  if(Object.values(features).some(value=>typeof value!=='boolean'))return s.status(400).json({error:'Every feature entitlement must be a boolean.'});
  if(!/^[a-z0-9_-]{2,40}$/.test(code)||!name||name.length>120||!['MONTHLY','YEARLY'].includes(period)||!Number.isSafeInteger(amount)||amount<100)return s.status(400).json({error:'Provide plan code, name, MONTHLY/YEARLY period and amountPaise.'});
  if((await pool.query('SELECT 1 FROM barberpro_subscription_plans WHERE code=$1',[code])).rowCount)return s.status(409).json({error:'A plan with this code already exists.'});
  const plan=await razorpay('/plans','POST',{period:period==='MONTHLY'?'monthly':'yearly',interval:1,item:{name,amount,currency:'INR',description:'BarberPro '+name}});
  const saved=await pool.query(`INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise,razorpay_plan_id,feature_entitlements)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[code,name,period,amount,plan.id,JSON.stringify(features)]);
  s.status(201).json({plan:saved.rows[0]});
 }));
 r.post('/admin/shops/:shopId/subscription',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId),planId=id(q.body?.planId);if(!shopId||!planId)return s.status(400).json({error:'Valid shopId and planId are required.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const shop=await c.query('SELECT id,name FROM shops WHERE id=$1 AND is_active=TRUE FOR UPDATE',[shopId]);
   if(!shop.rowCount){await c.query('ROLLBACK');return s.status(404).json({error:'Active shop not found.'});}
   const existing=await c.query("SELECT 1 FROM shop_subscriptions WHERE shop_id=$1 AND status IN('CREATED','AUTHENTICATED','ACTIVE','PENDING') LIMIT 1",[shopId]);
   if(existing.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'This shop already has a pending or active subscription.'});}
   const plan=await c.query('SELECT * FROM barberpro_subscription_plans WHERE id=$1 AND is_active=TRUE',[planId]);
   if(!plan.rowCount||!plan.rows[0].razorpay_plan_id){await c.query('ROLLBACK');return s.status(404).json({error:'Configured Razorpay plan not found.'});}
   const sub=await razorpay('/subscriptions','POST',{plan_id:plan.rows[0].razorpay_plan_id,total_count:plan.rows[0].billing_period==='YEARLY'?5:60,quantity:1,customer_notify:0,notes:{shopId:String(shopId),planId:String(planId),shopName:shop.rows[0].name}});
   const saved=await c.query(`INSERT INTO shop_subscriptions(shop_id,plan_id,razorpay_subscription_id,status,short_url,provider_payload,created_by)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,[shopId,planId,sub.id,sub.status?.toUpperCase()||'CREATED',sub.short_url,JSON.stringify(sub),q.user.id]);
   await c.query('COMMIT');s.status(201).json({subscription:saved.rows[0],checkoutUrl:sub.short_url});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 r.get('/admin/shops/:shopId/subscription',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId);if(!shopId)return s.sendStatus(400);
  const out=await pool.query(`SELECT ss.id,ss.status,ss.current_start,ss.current_end,ss.next_charge_at,ss.short_url,p.code plan_code,p.name plan_name,p.billing_period,p.feature_entitlements
   FROM shop_subscriptions ss JOIN barberpro_subscription_plans p ON p.id=ss.plan_id WHERE ss.shop_id=$1 ORDER BY ss.created_at DESC LIMIT 1`,[shopId]);s.json({subscription:out.rows[0]||null});
 }));
 r.get('/shops/:shopId/feature-entitlements',authenticate,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId);if(!shopId||!await shopAccess(q.user,shopId))return s.sendStatus(404);
  const out=await pool.query(`SELECT p.feature_entitlements,ss.status FROM shop_subscriptions ss JOIN barberpro_subscription_plans p ON p.id=ss.plan_id
   WHERE ss.shop_id=$1 AND ss.status IN('ACTIVE','AUTHENTICATED') ORDER BY ss.created_at DESC LIMIT 1`,[shopId]);
  s.json({active:Boolean(out.rowCount),status:out.rows[0]?.status||'UNSUBSCRIBED',features:out.rows[0]?.feature_entitlements||{}});
 }));
 r.post('/subscriptions/webhook',wrap(async(q,s)=>{
  const secret=process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET||process.env.RAZORPAY_WEBHOOK_SECRET;if(!secret)return s.status(503).send('Subscription webhook secret is not configured.');
  const sig=q.get('x-razorpay-signature')||'',raw=q.rawBody||Buffer.from(JSON.stringify(q.body||{}));if(!safeEqual(hmac(secret,raw),sig))return s.sendStatus(400);
  const event=q.body||{},entity=event.payload?.subscription?.entity;if(!entity?.id)return s.json({received:true,ignored:true});
  const map={'subscription.activated':'ACTIVE','subscription.authenticated':'AUTHENTICATED','subscription.pending':'PENDING','subscription.halted':'HALTED','subscription.cancelled':'CANCELLED','subscription.completed':'COMPLETED','subscription.charged':'ACTIVE'};
  const status=map[event.event];if(status)await pool.query(`UPDATE shop_subscriptions SET status=$2,current_start=to_timestamp(NULLIF($3,0)),current_end=to_timestamp(NULLIF($4,0)),next_charge_at=to_timestamp(NULLIF($5,0)),provider_payload=provider_payload||$6::jsonb,updated_at=NOW() WHERE razorpay_subscription_id=$1`,[entity.id,status,Number(entity.current_start||0),Number(entity.current_end||0),Number(entity.charge_at||0),JSON.stringify({lastWebhook:event.event})]);
  s.json({received:true});
 }));

 // Admin policy and localized provider templates; a locale fallback is used until its template is approved.
 r.put('/admin/shops/:shopId/reschedule-policy',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId),hours=Number(q.body?.freeRescheduleBeforeHours);
  if(!shopId||!Number.isInteger(hours)||hours<0||hours>720)return s.status(400).json({error:'freeRescheduleBeforeHours must be an integer from 0 to 720.'});
  const out=await pool.query(`INSERT INTO shop_reschedule_policies(shop_id,free_reschedule_before_hours,updated_by)
   VALUES($1,$2,$3) ON CONFLICT(shop_id) DO UPDATE SET free_reschedule_before_hours=EXCLUDED.free_reschedule_before_hours,updated_by=EXCLUDED.updated_by,updated_at=NOW()
   RETURNING shop_id,free_reschedule_before_hours`,[shopId,hours,q.user.id]);s.json({policy:out.rows[0]});
 }));
 r.put('/admin/shops/:shopId/message-templates/:templateKey/translations/:locale',...admin,wrap(async(q,s)=>{
  const shopId=id(q.params.shopId),locale=q.params.locale,key=String(q.params.templateKey||''),b=q.body||{};
  if(!shopId||!['en','hi','mr'].includes(locale)||!/^([A-Z0-9_]{2,40})$/.test(key)||!['EMAIL','SMS','WHATSAPP'].includes(b.channel)||typeof b.body!=='string'||!b.body.trim()||b.body.length>5000)
   return s.status(400).json({error:'Provide a valid shop, template key, locale, channel and body.'});
  if(!await featureEnabled(shopId,'MESSAGING_LOCALIZATION'))return s.status(403).json({error:'Localized messaging is not included in this shop subscription.'});
  const status=['PENDING','APPROVED','REJECTED'].includes(b.providerTemplateStatus)?b.providerTemplateStatus:'PENDING';
  if(b.channel==='WHATSAPP'&&(!b.providerTemplateName||!b.providerTemplateLanguage))return s.status(400).json({error:'WhatsApp translations need the exact Meta template name and language code.'});
  const out=await pool.query(`INSERT INTO shop_message_template_translations(shop_id,channel,template_key,locale,subject,body,provider_template_name,provider_template_language,provider_template_status,provider_approval_reference,updated_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
   ON CONFLICT(shop_id,channel,template_key,locale) DO UPDATE SET subject=EXCLUDED.subject,body=EXCLUDED.body,provider_template_name=EXCLUDED.provider_template_name,
    provider_template_language=EXCLUDED.provider_template_language,provider_template_status=EXCLUDED.provider_template_status,
    provider_approval_reference=EXCLUDED.provider_approval_reference,updated_by=EXCLUDED.updated_by,updated_at=NOW()
   RETURNING id,shop_id,channel,template_key,locale,provider_template_name,provider_template_language,provider_template_status`,
   [shopId,b.channel,key,locale,b.subject||null,b.body,b.providerTemplateName||null,b.providerTemplateLanguage||locale,status,b.providerApprovalReference||null,q.user.id]);
  s.json({translation:out.rows[0]});
 }));
 return r;
}
module.exports={createAdvancedRouter};
