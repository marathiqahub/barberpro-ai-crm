'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { createAuthMiddleware } = require('../auth/middleware');
const { scheduleAppointmentReminders } = require('../messaging/reminders');

function createCustomerExperienceRouter(pool, tokenService, options = {}) {
  const router = express.Router();
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || global.fetch;
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const customer = [authenticate, requireRole('CUSTOMER')];
  const admin = [authenticate, requireRole('ADMIN')];
  const frontDesk = [authenticate, requireRole('ADMIN', 'FRONT_DESK')];
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
  const id = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const validUrl = value => { try { const u=new URL(value); return u.protocol==='https:' && u.username==='' && u.password===''; } catch { return false; } };
  async function shopAccess(user, shopId) {
    if (user.role === 'ADMIN') return true;
    const r = await pool.query('SELECT 1 FROM shop_front_desk WHERE shop_id=$1 AND user_id=$2 AND is_active=TRUE',[shopId,user.id]);
    return r.rowCount > 0;
  }
  async function razorpay(path, method, body) {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw Object.assign(new Error('Razorpay is not configured.'),{status:503});
    const response=await fetchImpl('https://api.razorpay.com/v1'+path,{method,headers:{Authorization:'Basic '+Buffer.from(env.RAZORPAY_KEY_ID+':'+env.RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error?.description||'Razorpay request failed.'),{status:502});
    return data;
  }
  async function createExtraOrder(payment, customerId) {
    if (payment.customer_id !== customerId) throw Object.assign(new Error('Payment not found.'),{status:404});
    if (payment.status === 'PAID') throw Object.assign(new Error('This payment is already paid.'),{status:409});
    if (payment.provider_order_id) {
      const order=payment.provider_payload?.order;
      if(order)return {payment,order,keyId:env.RAZORPAY_KEY_ID};
    }
    const order=await razorpay('/orders','POST',{amount:Number(payment.amount_paise),currency:'INR',receipt:'extra_'+payment.id,notes:{extraPaymentId:String(payment.id),appointmentId:String(payment.appointment_id),type:payment.payment_type}});
    const saved=await pool.query('UPDATE appointment_extra_payments SET provider_order_id=$2,provider_payload=$3::jsonb,status=\'CREATED\',updated_at=NOW() WHERE id=$1 AND customer_id=$4 RETURNING *',[payment.id,order.id,JSON.stringify({order}),customerId]);
    return {payment:saved.rows[0],order,keyId:env.RAZORPAY_KEY_ID};
  }

  router.put('/admin/shops/:shopId/appointment-policy',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),b=req.body||{};
    if(!shopId||typeof b.depositsEnabled!=='boolean'||!['FIXED','PERCENT'].includes(b.depositType)||!Number.isInteger(b.depositValue)||b.depositValue<0||b.depositValue>(b.depositType==='PERCENT'?100:100000000)||!Number.isInteger(b.cancellationWindowHours)||b.cancellationWindowHours<0||b.cancellationWindowHours>720||!Number.isSafeInteger(b.cancellationFeePaise)||b.cancellationFeePaise<0||!Number.isSafeInteger(b.noShowFeePaise)||b.noShowFeePaise<0||(b.googleReviewUrl!==undefined&&b.googleReviewUrl!==null&&(!validUrl(b.googleReviewUrl)||b.googleReviewUrl.length>1000)))return res.status(400).json({error:'Invalid deposit, cancellation, no-show or review policy.'});
    const out=await pool.query(`INSERT INTO shop_appointment_policies(shop_id,deposits_enabled,deposit_type,deposit_value,cancellation_window_hours,cancellation_fee_paise,no_show_fee_paise,google_review_url,updated_by,updated_at)
      SELECT id,$2,$3,$4,$5,$6,$7,$8,$9,NOW() FROM shops WHERE id=$1 AND is_active=TRUE
      ON CONFLICT(shop_id) DO UPDATE SET deposits_enabled=EXCLUDED.deposits_enabled,deposit_type=EXCLUDED.deposit_type,deposit_value=EXCLUDED.deposit_value,cancellation_window_hours=EXCLUDED.cancellation_window_hours,cancellation_fee_paise=EXCLUDED.cancellation_fee_paise,no_show_fee_paise=EXCLUDED.no_show_fee_paise,google_review_url=EXCLUDED.google_review_url,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING *`,[shopId,b.depositsEnabled,b.depositType,b.depositValue,b.cancellationWindowHours,b.cancellationFeePaise,b.noShowFeePaise,b.googleReviewUrl||null,req.user.id]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.json({policy:out.rows[0]});
  }));
  router.get('/admin/shops/:shopId/appointment-policy',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop.'});
    const out=await pool.query('SELECT * FROM shop_appointment_policies WHERE shop_id=$1',[shopId]);
    res.json({policy:out.rows[0]||{shop_id:shopId,deposits_enabled:false,deposit_type:'PERCENT',deposit_value:0,cancellation_window_hours:24,cancellation_fee_paise:0,no_show_fee_paise:0}});
  }));

  router.post('/payments/deposits/orders',...customer,wrap(async(req,res)=>{
    const appointmentId=id(req.body?.appointmentId);if(!appointmentId)return res.status(400).json({error:'Valid appointmentId is required.'});
    const found=await pool.query(`SELECT a.id,a.shop_id,a.customer_id,a.status,sv.price,p.deposits_enabled,p.deposit_type,p.deposit_value
      FROM appointments a JOIN services sv ON sv.id=a.service_id JOIN shop_appointment_policies p ON p.shop_id=a.shop_id
      WHERE a.id=$1 AND a.customer_id=$2 AND a.status IN ('BOOKED','CONFIRMED')`,[appointmentId,req.user.id]);
    if(!found.rowCount||!found.rows[0].deposits_enabled)return res.status(404).json({error:'Deposit is not enabled for this appointment.'});
    const a=found.rows[0];
    const amountPaise=a.deposit_type==='FIXED'?Number(a.deposit_value):Math.round(Number(a.price)*100*Number(a.deposit_value)/100);
    if(!Number.isSafeInteger(amountPaise)||amountPaise<100)return res.status(400).json({error:'Configured deposit must be at least INR 1.'});
    let saved=await pool.query(`INSERT INTO appointment_extra_payments(appointment_id,customer_id,payment_type,amount_paise)
      VALUES($1,$2,'DEPOSIT',$3) ON CONFLICT(appointment_id,payment_type) DO UPDATE SET amount_paise=EXCLUDED.amount_paise
      WHERE appointment_extra_payments.status IN ('CREATED','FAILED') RETURNING *`,[appointmentId,req.user.id,amountPaise]);
    if(!saved.rowCount){const prior=await pool.query("SELECT * FROM appointment_extra_payments WHERE appointment_id=$1 AND payment_type='DEPOSIT'",[appointmentId]);if(prior.rows[0]?.status==='PAID')return res.status(409).json({error:'Deposit is already paid.'});return res.status(409).json({error:'A deposit payment is already being processed.'});}
    const result=await createExtraOrder(saved.rows[0],req.user.id);
    res.status(201).json(result);
  }));
  router.post('/payments/extra/:paymentId/orders',...customer,wrap(async(req,res)=>{
    const paymentId=id(req.params.paymentId);if(!paymentId)return res.status(400).json({error:'Invalid payment id.'});
    const found=await pool.query('SELECT * FROM appointment_extra_payments WHERE id=$1 AND customer_id=$2',[paymentId,req.user.id]);
    if(!found.rowCount)return res.status(404).json({error:'Payment not found.'});
    res.json(await createExtraOrder(found.rows[0],req.user.id));
  }));
  router.post('/payments/extra/:paymentId/verify',...customer,wrap(async(req,res)=>{
    const paymentId=id(req.params.paymentId),b=req.body||{};
    if(!paymentId||![b.razorpay_order_id,b.razorpay_payment_id,b.razorpay_signature].every(x=>typeof x==='string'&&x.length<200))return res.status(400).json({error:'Payment verification fields are required.'});
    const found=await pool.query('SELECT * FROM appointment_extra_payments WHERE id=$1 AND customer_id=$2',[paymentId,req.user.id]);
    if(!found.rowCount||found.rows[0].provider_order_id!==b.razorpay_order_id)return res.status(404).json({error:'Payment order not found.'});
    const expected=crypto.createHmac('sha256',env.RAZORPAY_KEY_SECRET||'').update(b.razorpay_order_id+'|'+b.razorpay_payment_id).digest('hex');
    const left=Buffer.from(expected,'hex'),right=Buffer.from(b.razorpay_signature,'hex');
    if(!left.length||left.length!==right.length||!crypto.timingSafeEqual(left,right))return res.status(400).json({error:'Invalid Razorpay signature.'});
    const provider=await razorpay('/payments/'+encodeURIComponent(b.razorpay_payment_id),'GET');
    if(provider.order_id!==b.razorpay_order_id||Number(provider.amount)!==Number(found.rows[0].amount_paise)||provider.currency!=='INR')return res.status(400).json({error:'Provider payment does not match this order.'});
    if(!['captured','authorized'].includes(provider.status))return res.status(409).json({error:'Payment is not yet captured or authorized.'});
    const finalStatus=provider.status==='captured'?'PAID':'AUTHORIZED';const out=await pool.query("UPDATE appointment_extra_payments SET provider_payment_id=$2,status=$3,updated_at=NOW() WHERE id=$1 AND customer_id=$4 RETURNING id,appointment_id,payment_type,amount_paise,status",[paymentId,b.razorpay_payment_id,finalStatus,req.user.id]);
    res.json({payment:out.rows[0]});
  }));
  router.post('/admin/shops/:shopId/appointments/:appointmentId/no-show-fee',...frontDesk,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),appointmentId=id(req.params.appointmentId);if(!shopId||!appointmentId||!await shopAccess(req.user,shopId))return res.status(404).json({error:'Shop not found.'});
    const out=await pool.query(`INSERT INTO appointment_extra_payments(appointment_id,customer_id,payment_type,amount_paise)
      SELECT a.id,a.customer_id,'NO_SHOW_FEE',p.no_show_fee_paise FROM appointments a JOIN shop_appointment_policies p ON p.shop_id=a.shop_id
      WHERE a.id=$1 AND a.shop_id=$2 AND a.status='NO_SHOW' AND p.no_show_fee_paise>0
      ON CONFLICT(appointment_id,payment_type) DO NOTHING RETURNING id,appointment_id,customer_id,payment_type,amount_paise,status`,[appointmentId,shopId]);
    if(!out.rowCount)return res.status(409).json({error:'No fee configured, appointment is not a no-show, or fee was already assessed.'});
    res.status(201).json({fee:out.rows[0],message:'Fee assessed for customer review; it is not auto-charged. Customer must open checkout and pay.'});
  }));

  router.post('/customer/shops/:shopId/waitlist',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),serviceId=id(req.body?.serviceId),staffId=req.body?.preferredStaffId==null?null:id(req.body.preferredStaffId),date=req.body?.preferredDate;
    if(!shopId||!serviceId||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return res.status(400).json({error:'Provide a shop, service and preferred date.'});
    const out=await pool.query(`INSERT INTO shop_waitlist_entries(shop_id,customer_id,service_id,preferred_staff_id,preferred_date,preferred_from,preferred_to)
      SELECT sh.id,$2,sv.id,$4,$5,$6,$7 FROM shops sh JOIN services sv ON sv.shop_id=sh.id
      WHERE sh.id=$1 AND sh.is_active=TRUE AND sv.id=$3 AND sv.is_active=TRUE
      RETURNING *`,[shopId,req.user.id,serviceId,staffId,date,req.body.preferredFrom||null,req.body.preferredTo||null]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop or service not found.'});
    res.status(201).json({waitlistEntry:out.rows[0]});
  }));
  router.get('/customer/payments/extra',...customer,wrap(async(req,res)=>{const out=await pool.query('SELECT id,appointment_id,payment_type,amount_paise,status,created_at FROM appointment_extra_payments WHERE customer_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json({payments:out.rows});}));
  router.get('/customer/waitlist',...customer,wrap(async(req,res)=>{
    const out=await pool.query('SELECT e.*,s.name shop_name,sv.name service_name FROM shop_waitlist_entries e JOIN shops s ON s.id=e.shop_id JOIN services sv ON sv.id=e.service_id WHERE e.customer_id=$1 ORDER BY e.created_at DESC',[req.user.id]);
    res.json({entries:out.rows});
  }));
  router.post('/customer/waitlist-offers/:offerId/accept',...customer,wrap(async(req,res)=>{
    const offerId=id(req.params.offerId);if(!offerId)return res.status(400).json({error:'Invalid offer.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const offer=await client.query("SELECT * FROM shop_waitlist_offers WHERE id=$1 AND customer_id=$2 AND status='OFFERED' AND expires_at>NOW() FOR UPDATE",[offerId,req.user.id]);
      if(!offer.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'This waitlist offer has expired or is no longer available.'});}
      const o=offer.rows[0];
      const booked=await client.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status)
        SELECT $1,$2,$3,$4,$5,$6,'BOOKED'
        WHERE NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=$2 AND a.status IN('BOOKED','CONFIRMED','IN_PROGRESS') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange($5,$6,'[)'))
        RETURNING *`,[o.shop_id,o.staff_id,o.service_id,req.user.id,o.starts_at,o.ends_at]);
      if(!booked.rowCount){await client.query("UPDATE shop_waitlist_offers SET status='EXPIRED' WHERE id=$1",[offerId]);await client.query("UPDATE shop_waitlist_entries SET status='WAITING' WHERE id=$1",[o.waitlist_entry_id]);await client.query('COMMIT');return res.status(409).json({error:'That slot was just taken. Your waitlist request is active again.'});}
      await client.query("UPDATE shop_waitlist_offers SET status='ACCEPTED',appointment_id=$2 WHERE id=$1",[offerId,booked.rows[0].id]);
      await client.query("UPDATE shop_waitlist_entries SET status='BOOKED',updated_at=NOW() WHERE id=$1",[o.waitlist_entry_id]);
      await client.query('COMMIT');
      await scheduleAppointmentReminders(pool,{...booked.rows[0],customer_id:req.user.id});
      res.status(201).json({appointment:booked.rows[0]});
    }catch(e){await client.query('ROLLBACK');if(e.code==='23P01')return res.status(409).json({error:'That slot was just taken.'});throw e;}finally{client.release();}
  }));

  router.get('/admin/shops/:shopId/waitlist',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop.'});
    const out=await pool.query('SELECT e.*,u.name customer_name,u.phone,sv.name service_name FROM shop_waitlist_entries e JOIN users u ON u.id=e.customer_id JOIN services sv ON sv.id=e.service_id WHERE e.shop_id=$1 AND e.status IN (\'WAITING\',\'OFFERED\') ORDER BY e.preferred_date,e.created_at',[shopId]);
    res.json({entries:out.rows});
  }));

  router.put('/customer/shops/:shopId/profile/preferences',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),b=req.body||{},staffId=b.preferredStaffId==null?null:id(b.preferredStaffId),serviceId=b.preferredServiceId==null?null:id(b.preferredServiceId);
    if(!shopId||(b.careNotes!==undefined&&(typeof b.careNotes!=='string'||b.careNotes.length>2000))||typeof b.photoConsent!=='boolean')return res.status(400).json({error:'Provide valid preferences, care notes and explicit photo consent.'});
    const out=await pool.query(`INSERT INTO shop_customer_profiles(shop_id,customer_id,preferred_staff_id,preferred_service_id,care_notes,photo_consent,photo_consent_at)
      SELECT sh.id,$2,$3,$4,$5,$6,CASE WHEN $6 THEN NOW() ELSE NULL END FROM shops sh WHERE sh.id=$1 AND sh.is_active=TRUE
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET preferred_staff_id=EXCLUDED.preferred_staff_id,preferred_service_id=EXCLUDED.preferred_service_id,care_notes=EXCLUDED.care_notes,photo_consent=EXCLUDED.photo_consent,photo_consent_at=EXCLUDED.photo_consent_at,updated_at=NOW()
      RETURNING shop_id,customer_id,preferred_staff_id,preferred_service_id,care_notes,photo_consent,photo_consent_at`,[shopId,req.user.id,staffId,serviceId,b.careNotes||null,b.photoConsent]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.json({profile:out.rows[0]});
  }));
  router.post('/admin/shops/:shopId/customers/:customerId/photos',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),customerId=id(req.params.customerId),appointmentId=req.body?.appointmentId==null?null:id(req.body.appointmentId),kind=req.body?.kind,url=req.body?.privateAssetUrl;
    if(!shopId||!customerId||!['BEFORE','AFTER'].includes(kind)||!validUrl(url)||url.length>2000)return res.status(400).json({error:'Provide a private HTTPS asset URL and BEFORE/AFTER type.'});
    const consent=await pool.query('SELECT photo_consent FROM shop_customer_profiles WHERE shop_id=$1 AND customer_id=$2',[shopId,customerId]);
    if(!consent.rowCount||!consent.rows[0].photo_consent)return res.status(403).json({error:'Customer has not consented to before/after photo storage.'});
    const out=await pool.query('INSERT INTO shop_customer_photos(shop_id,customer_id,appointment_id,photo_kind,private_asset_url,consent_recorded_at,uploaded_by) VALUES($1,$2,$3,$4,$5,NOW(),$6) RETURNING id,shop_id,customer_id,appointment_id,photo_kind,created_at',[shopId,customerId,appointmentId,kind,url,req.user.id]);
    res.status(201).json({photo:out.rows[0]});
  }));
  router.get('/admin/shops/:shopId/customers/:customerId/photos',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),customerId=id(req.params.customerId);if(!shopId||!customerId)return res.status(400).json({error:'Invalid shop or customer.'});
    const out=await pool.query('SELECT id,appointment_id,photo_kind,private_asset_url,created_at FROM shop_customer_photos WHERE shop_id=$1 AND customer_id=$2 ORDER BY created_at DESC',[shopId,customerId]);
    res.json({photos:out.rows});
  }));

  router.post('/customer/shops/:shopId/appointments/:appointmentId/feedback',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),appointmentId=id(req.params.appointmentId),rating=Number(req.body?.rating),comment=typeof req.body?.comment==='string'?req.body.comment.trim():null;
    if(!shopId||!appointmentId||!Number.isInteger(rating)||rating<1||rating>5||(comment&&comment.length>1500))return res.status(400).json({error:'Provide a 1–5 rating and optional feedback.'});
    const appt=await pool.query("SELECT id,customer_id FROM appointments WHERE id=$1 AND shop_id=$2 AND customer_id=$3 AND status='COMPLETED'",[appointmentId,shopId,req.user.id]);
    if(!appt.rowCount)return res.status(404).json({error:'Completed appointment not found.'});
    const saved=await pool.query('INSERT INTO shop_customer_feedback(shop_id,customer_id,appointment_id,rating,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(appointment_id,customer_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment RETURNING id,rating,comment,created_at',[shopId,req.user.id,appointmentId,rating,comment]);
    let nextAction='PRIVATE_FEEDBACK';
    if(rating>=4){
      const review=await pool.query('SELECT google_review_url FROM shop_appointment_policies WHERE shop_id=$1',[shopId]);
      const link=review.rows[0]?.google_review_url;
      if(link){nextAction='GOOGLE_REVIEW';const consents=await pool.query("SELECT channel,destination FROM shop_message_consents WHERE shop_id=$1 AND customer_id=$2 AND consent=TRUE AND revoked_at IS NULL AND channel='WHATSAPP' LIMIT 1",[shopId,req.user.id]);if(consents.rowCount)await pool.query("INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at) VALUES($1,$2,$3,$4,'GOOGLE_REVIEW_REQUEST',NOW()) ON CONFLICT DO NOTHING",[shopId,req.user.id,appointmentId,consents.rows[0].channel]);}
    }
    res.status(201).json({feedback:saved.rows[0],nextAction,reviewUrl:nextAction==='GOOGLE_REVIEW'?(await pool.query('SELECT google_review_url FROM shop_appointment_policies WHERE shop_id=$1',[shopId])).rows[0]?.google_review_url||null:null});
  }));

  router.put('/customer/shops/:shopId/rebooking-preference',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),days=req.body?.intervalDays,enabled=req.body?.enabled;
    if(!shopId||!Number.isInteger(days)||days<7||days>365||typeof enabled!=='boolean')return res.status(400).json({error:'Provide an interval from 7 to 365 days and enabled preference.'});
    const out=await pool.query(`INSERT INTO shop_customer_rebooking_profiles(shop_id,customer_id,interval_days,enabled)
      SELECT id,$2,$3,$4 FROM shops WHERE id=$1 AND is_active=TRUE
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET interval_days=EXCLUDED.interval_days,interval_source='MANUAL',enabled=EXCLUDED.enabled,updated_at=NOW()
      RETURNING *`,[shopId,req.user.id,days,enabled]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.json({preference:out.rows[0]});
  }));

  router.post('/admin/shops/:shopId/queue-displays',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),label=typeof req.body?.label==='string'?req.body.label.trim().slice(0,80):'Live queue';
    if(!shopId)return res.status(400).json({error:'Invalid shop.'});
    const token=crypto.randomBytes(32).toString('base64url');
    const out=await pool.query('INSERT INTO shop_queue_displays(shop_id,token_hash,label,created_by) SELECT id,$2,$3,$4 FROM shops WHERE id=$1 AND is_active=TRUE RETURNING id,shop_id,label,created_at',[shopId,hash(token),label,req.user.id]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.status(201).json({display:out.rows[0],displayUrl:'/queue.html?token='+encodeURIComponent(token),token,message:'Copy the display URL now. The token is shown once.'});
  }));
  router.get('/public/queue/:token',wrap(async(req,res)=>{
    const token=typeof req.params.token==='string'?req.params.token:'';
    if(token.length<32||token.length>100)return res.status(404).json({error:'Queue not found.'});
    const display=await pool.query('SELECT d.shop_id,d.label,s.name shop_name,s.timezone FROM shop_queue_displays d JOIN shops s ON s.id=d.shop_id WHERE d.token_hash=$1 AND d.is_active=TRUE AND s.is_active=TRUE',[hash(token)]);
    if(!display.rowCount)return res.status(404).json({error:'Queue not found.'});
    const d=display.rows[0];
    const rows=await pool.query(`SELECT a.id,a.status,a.starts_at,sv.name service_name,st.display_name,
      CASE WHEN POSITION(' ' IN u.name)>0 THEN LEFT(u.name,1)||' '||LEFT(SPLIT_PART(u.name,' ',2),1)||'.' ELSE LEFT(u.name,1)||'.' END customer_label
      FROM appointments a JOIN users u ON u.id=a.customer_id JOIN services sv ON sv.id=a.service_id JOIN shop_staff st ON st.id=a.staff_id
      WHERE a.shop_id=$1 AND (a.starts_at AT TIME ZONE $2)::date=(NOW() AT TIME ZONE $2)::date
        AND a.status IN ('CONFIRMED','IN_PROGRESS','READY_TO_BILL')
      ORDER BY CASE a.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'READY_TO_BILL' THEN 1 ELSE 2 END,a.starts_at LIMIT 12`,[d.shop_id,d.timezone]);
    const current=rows.rows.find(x=>x.status==='IN_PROGRESS')||null;
    const next=rows.rows.filter(x=>x.status!=='IN_PROGRESS').slice(0,5);
    res.set('Cache-Control','no-store').json({shopName:d.shop_name,label:d.label,nowServing:current,nextUp:next,updatedAt:new Date().toISOString()});
  }));

  router.post('/customer/shops/:shopId/privacy-consents',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),b=req.body||{};
    if(!shopId||typeof b.purpose!=='string'||!['SERVICE_NOTES','PHOTO_STORAGE','MARKETING','WHATSAPP_REMINDERS','SMS_REMINDERS','EMAIL_REMINDERS'].includes(b.purpose)||typeof b.consent!=='boolean'||typeof b.noticeVersion!=='string'||!b.noticeVersion.trim()||b.noticeVersion.length>40)return res.status(400).json({error:'Provide a valid consent purpose, decision and notice version.'});
    const out=await pool.query('INSERT INTO shop_privacy_consent_events(shop_id,customer_id,purpose,consent,notice_version,source) SELECT id,$2,$3,$4,$5,\'CUSTOMER_SETTINGS\' FROM shops WHERE id=$1 AND is_active=TRUE RETURNING *',[shopId,req.user.id,b.purpose,b.consent,b.noticeVersion.trim()]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.status(201).json({consent:out.rows[0]});
  }));
  router.get('/customer/shops/:shopId/data-export',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop.'});
    const [profile,appointments,payments,feedback,consents,photos,reminders]=await Promise.all([
      pool.query('SELECT id,name,email,phone,created_at FROM users WHERE id=$1',[req.user.id]),
      pool.query('SELECT id,shop_id,service_id,staff_id,starts_at,ends_at,status,customer_notes,created_at FROM appointments WHERE shop_id=$1 AND customer_id=$2 ORDER BY starts_at DESC',[shopId,req.user.id]),
      pool.query('SELECT p.id,p.appointment_id,p.amount_paise,p.currency,p.status,p.created_at FROM payments p JOIN appointments a ON a.id=p.appointment_id WHERE a.shop_id=$1 AND p.customer_id=$2',[shopId,req.user.id]),
      pool.query('SELECT rating,comment,created_at FROM shop_customer_feedback WHERE shop_id=$1 AND customer_id=$2',[shopId,req.user.id]),
      pool.query('SELECT purpose,consent,notice_version,source,recorded_at FROM shop_privacy_consent_events WHERE shop_id=$1 AND customer_id=$2 ORDER BY recorded_at',[shopId,req.user.id]),
      pool.query('SELECT id,appointment_id,photo_kind,created_at FROM shop_customer_photos WHERE shop_id=$1 AND customer_id=$2',[shopId,req.user.id]),
      pool.query('SELECT channel,template_key,scheduled_at,status,sent_at FROM shop_customer_reminders WHERE shop_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 500',[shopId,req.user.id])
    ]);
    res.set('Content-Disposition','attachment; filename="barberpro-data-export.json"').json({exportedAt:new Date().toISOString(),profile:profile.rows[0],appointments:appointments.rows,payments:payments.rows,feedback:feedback.rows,consents:consents.rows,photos:photos.rows,reminders:reminders.rows});
  }));
  router.post('/customer/shops/:shopId/data-rights-requests',...customer,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId),type=req.body?.requestType,reason=typeof req.body?.reason==='string'?req.body.reason.trim():null;
    if(!shopId||!['EXPORT','ERASURE'].includes(type)||(reason&&reason.length>1000))return res.status(400).json({error:'Request type must be EXPORT or ERASURE.'});
    const out=await pool.query('INSERT INTO shop_data_rights_requests(shop_id,customer_id,request_type,reason) SELECT id,$2,$3,$4 FROM shops WHERE id=$1 AND is_active=TRUE RETURNING id,request_type,status,created_at',[shopId,req.user.id,type,reason]);
    if(!out.rowCount)return res.status(404).json({error:'Active shop not found.'});
    res.status(201).json({request:out.rows[0],message:type==='ERASURE'?'Erasure request received. Identity and statutory retention review is required; data is not immediately deleted.':'Export request received. You can also download the current self-service export endpoint.'});
  }));
  router.get('/admin/shops/:shopId/data-rights-requests',...admin,wrap(async(req,res)=>{
    const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop.'});
    const out=await pool.query('SELECT r.*,u.name customer_name,u.email FROM shop_data_rights_requests r JOIN users u ON u.id=r.customer_id WHERE r.shop_id=$1 ORDER BY r.created_at DESC',[shopId]);
    res.json({requests:out.rows});
  }));
  router.patch('/admin/data-rights-requests/:requestId',...admin,wrap(async(req,res)=>{
    const requestId=id(req.params.requestId),status=req.body?.status,note=typeof req.body?.resolutionNote==='string'?req.body.resolutionNote.trim():null;
    if(!requestId||!['IDENTITY_REVIEW','IN_PROGRESS','COMPLETED','DECLINED'].includes(status)||(note&&note.length>2000))return res.status(400).json({error:'Invalid request status or resolution note.'});
    const out=await pool.query('UPDATE shop_data_rights_requests SET status=$2,resolution_note=$3,reviewed_by=$4,reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *',[requestId,status,note,req.user.id]);
    if(!out.rowCount)return res.status(404).json({error:'Data rights request not found.'});
    res.json({request:out.rows[0]});
  }));

  return router;
}
module.exports={createCustomerExperienceRouter};
