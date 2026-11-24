'use strict';
const express=require('express');
const rateLimit=require('express-rate-limit');
const {createAuthMiddleware}=require('../auth/middleware');
const {scheduleAppointmentReminders}=require('../messaging/reminders');
function createBookingAssistantRouter(pool,tokens){
 const r=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokens),customer=[authenticate,requireRole('CUSTOMER')];
 const limit=rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
 r.get('/ai/booking-assistant/:shopId/catalog',limit,async(q,s,n)=>{try{const shop=Number(q.params.shopId);if(!Number.isSafeInteger(shop)||shop<1)return s.status(400).json({error:'Invalid shop.'});const out=await pool.query('SELECT id,name,description,duration_minutes,price FROM services WHERE shop_id=$1 AND is_active=TRUE ORDER BY name',[shop]);s.json({services:out.rows})}catch(e){n(e)}});
 r.get('/ai/booking-assistant/:shopId/availability',limit,async(q,s,n)=>{try{const shop=Number(q.params.shopId),service=Number(q.query.serviceId),day=q.query.date;if(!Number.isSafeInteger(shop)||!Number.isSafeInteger(service)||!/^\d{4}-\d{2}-\d{2}$/.test(day||''))return s.status(400).json({error:'Shop, service and date are required.'});
 const out=await pool.query(`WITH ctx AS(SELECT sh.id shop_id,sh.timezone,sv.id service_id,sv.duration_minutes FROM shops sh JOIN services sv ON sv.shop_id=sh.id WHERE sh.id=$1 AND sh.is_active=TRUE AND sv.id=$2 AND sv.is_active=TRUE),slots AS(
 SELECT st.id staff_id,st.display_name,slot starts_at,slot+make_interval(mins=>c.duration_minutes) ends_at FROM ctx c JOIN shop_staff st ON st.shop_id=c.shop_id AND st.is_active=TRUE JOIN staff_working_hours wh ON wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM $3::date)::int AND wh.is_active=TRUE CROSS JOIN LATERAL generate_series((($3::date+wh.opens_at) AT TIME ZONE c.timezone),((($3::date+wh.closes_at)-make_interval(mins=>c.duration_minutes)) AT TIME ZONE c.timezone),INTERVAL '15 minutes') slot WHERE NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=c.service_id))
 SELECT staff_id,display_name,starts_at FROM slots x WHERE starts_at>NOW() AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=x.staff_id AND a.status IN('BOOKED','CONFIRMED') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange(x.starts_at,x.ends_at,'[)')) AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=x.staff_id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange(x.starts_at,x.ends_at,'[)')) ORDER BY starts_at LIMIT 100`,[shop,service,day]);s.json({slots:out.rows})}catch(e){n(e)}});
 r.post('/ai/booking-assistant/book',...customer,async(q,s,n)=>{const b=q.body||{},shop=Number(b.shopId),service=Number(b.serviceId),staff=Number(b.staffId),start=new Date(b.startsAt);if(![shop,service,staff].every(Number.isSafeInteger)||Number.isNaN(start.getTime()))return s.status(400).json({error:'Choose a valid shop, service, barber and available time.'});try{
 const out=await pool.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,deposit_due_paise)
 SELECT sh.id,st.id,sv.id,$4,$5,$5+make_interval(mins=>sv.duration_minutes),'BOOKED',CASE WHEN COALESCE(bp.deposit_enabled,FALSE) THEN LEAST(ROUND(sv.price*100)::bigint,CASE WHEN bp.deposit_type='PERCENT' THEN ROUND(sv.price*100*bp.deposit_value/10000)::bigint ELSE bp.deposit_value END) ELSE 0 END FROM shops sh JOIN shop_staff st ON st.shop_id=sh.id JOIN services sv ON sv.shop_id=sh.id LEFT JOIN shop_booking_policies bp ON bp.shop_id=sh.id
 WHERE sh.id=$1 AND sh.is_active=TRUE AND st.id=$3 AND st.is_active=TRUE AND sv.id=$2 AND sv.is_active=TRUE AND $5>NOW() AND EXTRACT(MINUTE FROM ($5 AT TIME ZONE sh.timezone))::int % 15=0 AND EXTRACT(SECOND FROM ($5 AT TIME ZONE sh.timezone))=0
 AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id))
 AND EXISTS(SELECT 1 FROM staff_working_hours wh WHERE wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM ($5 AT TIME ZONE sh.timezone))::int AND wh.is_active=TRUE AND ($5 AT TIME ZONE sh.timezone)::time>=wh.opens_at AND (($5 AT TIME ZONE sh.timezone)::time+make_interval(mins=>sv.duration_minutes))<=wh.closes_at)
 AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=st.id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$5+make_interval(mins=>sv.duration_minutes),'[)'))
 RETURNING id,shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,deposit_due_paise`,[shop,service,staff,q.user.id,start.toISOString()]);
 if(!out.rowCount)return s.status(409).json({error:'The selected barber or service is unavailable. Refresh availability and try again.'});await scheduleAppointmentReminders(pool,{...out.rows[0],customer_id:q.user.id});s.status(201).json({appointment:out.rows[0],message:'Booking request created. The shop can confirm it in BarberPro.'});
 }catch(e){if(e.code==='23P01')return s.status(409).json({error:'That time was just booked. Please choose another slot.'});n(e)}});

 r.post('/ai/booking-assistant/proposals',...customer,async(q,s,n)=>{const b=q.body||{},shop=Number(b.shopId),service=Number(b.serviceId),staff=Number(b.staffId),start=new Date(b.startsAt);if(![shop,service,staff].every(Number.isSafeInteger)||Number.isNaN(start.getTime()))return s.status(400).json({error:'Choose a valid shop, service, barber and time.'});try{
  const proposal=await pool.query(`INSERT INTO shop_ai_booking_proposals(shop_id,customer_id,service_id,staff_id,starts_at,ends_at,expires_at)
   SELECT sh.id,$4,sv.id,st.id,$5,$5+make_interval(mins=>sv.duration_minutes),NOW()+INTERVAL '10 minutes'
   FROM shops sh JOIN services sv ON sv.shop_id=sh.id JOIN shop_staff st ON st.shop_id=sh.id
   WHERE sh.id=$1 AND sh.is_active=TRUE AND sv.id=$2 AND sv.is_active=TRUE AND st.id=$3 AND st.is_active=TRUE AND $5>NOW()
    AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id))
    AND EXISTS(SELECT 1 FROM staff_working_hours wh WHERE wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM ($5 AT TIME ZONE sh.timezone))::int AND wh.is_active=TRUE AND ($5 AT TIME ZONE sh.timezone)::time>=wh.opens_at AND (($5 AT TIME ZONE sh.timezone)::time+make_interval(mins=>sv.duration_minutes))<=wh.closes_at)
    AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=st.id AND a.status IN('BOOKED','CONFIRMED','IN_PROGRESS') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange($5,$5+make_interval(mins=>sv.duration_minutes),'[)'))
    AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=st.id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$5+make_interval(mins=>sv.duration_minutes),'[)'))
   RETURNING id,shop_id,service_id,staff_id,starts_at,ends_at,expires_at`,[shop,service,staff,q.user.id,start.toISOString()]);
  if(!proposal.rowCount)return s.status(409).json({error:'That slot is no longer available. Refresh live availability.'});
  s.status(201).json({proposal:proposal.rows[0],requiresCustomerConfirmation:true});
 }catch(e){if(e.code==='23P01')return s.status(409).json({error:'That slot was just taken.'});n(e)}});
 r.post('/ai/booking-assistant/proposals/:proposalId/confirm',...customer,async(q,s,n)=>{const proposalId=String(q.params.proposalId||'');if(q.body?.confirmed!==true)return s.status(400).json({error:'Customer confirmation is required before creating a booking.'});if(!/^[0-9a-f-]{36}$/i.test(proposalId))return s.status(400).json({error:'Invalid booking proposal.'});const client=await pool.connect();try{
  await client.query('BEGIN');
  const proposal=await client.query("SELECT * FROM shop_ai_booking_proposals WHERE id=$1 AND customer_id=$2 AND status='PROPOSED' AND expires_at>NOW() FOR UPDATE",[proposalId,q.user.id]);
  if(!proposal.rowCount){await client.query('ROLLBACK');return s.status(404).json({error:'This proposal expired. Please choose another live slot.'});}
  const p=proposal.rows[0];
  const booked=await client.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status)
   SELECT sh.id,st.id,sv.id,$4,$5,$6,'BOOKED'
   FROM shops sh JOIN shop_staff st ON st.shop_id=sh.id JOIN services sv ON sv.shop_id=sh.id
   WHERE sh.id=$1 AND sh.is_active=TRUE AND st.id=$2 AND st.is_active=TRUE AND sv.id=$3 AND sv.is_active=TRUE AND $5>NOW()
    AND EXISTS(SELECT 1 FROM staff_working_hours wh WHERE wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM ($5 AT TIME ZONE sh.timezone))::int AND wh.is_active=TRUE AND ($5 AT TIME ZONE sh.timezone)::time>=wh.opens_at AND (($5 AT TIME ZONE sh.timezone)::time+make_interval(mins=>sv.duration_minutes))<=wh.closes_at)
    AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id))
    AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=st.id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$6,'[)'))
    AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=st.id AND a.status IN('BOOKED','CONFIRMED','IN_PROGRESS') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange($5,$6,'[)'))
   RETURNING id,shop_id,staff_id,service_id,starts_at,ends_at,status`,[p.shop_id,p.staff_id,p.service_id,q.user.id,p.starts_at,p.ends_at]);
  if(!booked.rowCount){await client.query("UPDATE shop_ai_booking_proposals SET status='EXPIRED' WHERE id=$1",[proposalId]);await client.query('COMMIT');return s.status(409).json({error:'That slot was just booked. Please choose another.'});}
  await client.query("UPDATE shop_ai_booking_proposals SET status='CONFIRMED',appointment_id=$2 WHERE id=$1",[proposalId,booked.rows[0].id]);
  const policy=await client.query('SELECT p.deposits_enabled,p.deposit_type,p.deposit_value,sv.price FROM shop_appointment_policies p JOIN services sv ON sv.shop_id=p.shop_id WHERE p.shop_id=$1 AND sv.id=$2',[p.shop_id,p.service_id]);
  let deposit=null;
  if(policy.rowCount&&policy.rows[0].deposits_enabled){
   const cfg=policy.rows[0],amount=cfg.deposit_type==='FIXED'?Number(cfg.deposit_value):Math.round(Number(cfg.price)*100*Number(cfg.deposit_value)/100);
   if(!Number.isSafeInteger(amount)||amount<100)throw Object.assign(new Error('The shop deposit policy is invalid. Contact the shop.'),{status:400});
   const saved=await client.query("INSERT INTO appointment_extra_payments(appointment_id,customer_id,payment_type,amount_paise) VALUES($1,$2,'DEPOSIT',$3) RETURNING id,amount_paise,status",[booked.rows[0].id,q.user.id,amount]);deposit=saved.rows[0];
  }
  await client.query('COMMIT');
  await scheduleAppointmentReminders(pool,{...booked.rows[0],customer_id:q.user.id});
  s.status(201).json({appointment:booked.rows[0],depositRequired:Boolean(deposit),deposit,message:'Booking request created after your confirmation. The shop can confirm it.'});
 }catch(e){await client.query('ROLLBACK');if(e.code==='23P01')return s.status(409).json({error:'That slot was just taken.'});n(e)}finally{client.release()}});
 return r;
}
module.exports={createBookingAssistantRouter};
