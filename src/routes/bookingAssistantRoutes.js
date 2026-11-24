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
 const out=await pool.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status)
 SELECT sh.id,st.id,sv.id,$4,$5,$5+make_interval(mins=>sv.duration_minutes),'BOOKED' FROM shops sh JOIN shop_staff st ON st.shop_id=sh.id JOIN services sv ON sv.shop_id=sh.id
 WHERE sh.id=$1 AND sh.is_active=TRUE AND st.id=$3 AND st.is_active=TRUE AND sv.id=$2 AND sv.is_active=TRUE AND $5>NOW()
 AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id))
 AND EXISTS(SELECT 1 FROM staff_working_hours wh WHERE wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM ($5 AT TIME ZONE sh.timezone))::int AND wh.is_active=TRUE AND ($5 AT TIME ZONE sh.timezone)::time>=wh.opens_at AND (($5 AT TIME ZONE sh.timezone)::time+make_interval(mins=>sv.duration_minutes))<=wh.closes_at)
 AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=st.id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$5+make_interval(mins=>sv.duration_minutes),'[)'))
 RETURNING id,shop_id,staff_id,service_id,starts_at,ends_at,status`,[shop,service,staff,q.user.id,start.toISOString()]);
 if(!out.rowCount)return s.status(409).json({error:'The selected barber or service is unavailable. Refresh availability and try again.'});await scheduleAppointmentReminders(pool,{...out.rows[0],customer_id:q.user.id});s.status(201).json({appointment:out.rows[0],message:'Booking request created. The shop can confirm it in BarberPro.'});
 }catch(e){if(e.code==='23P01')return s.status(409).json({error:'That time was just booked. Please choose another slot.'});n(e)}});
 return r;
}
module.exports={createBookingAssistantRouter};
