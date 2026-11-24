'use strict';
const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');
const { scheduleAppointmentReminders } = require('../messaging/reminders');

function createRetentionRouter(pool, tokens) {
  const r = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokens);
  const customer = [authenticate, requireRole('CUSTOMER')];
  const admin = [authenticate, requireRole('ADMIN')];
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
  const id = v => /^[1-9]\\d*$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
  const validHttps = v => v == null || v === '' || (typeof v === 'string' && v.length <= 2048 && /^https:\/\//i.test(v));
  const audit = (db,shopId,actor,action,type,entityId,metadata={}) => db.query(
    'INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [shopId,actor,action,type,String(entityId),JSON.stringify(metadata)]);

  r.get('/shops/:shopId/booking-policy',wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT deposit_enabled,deposit_type,deposit_value,cancellation_notice_hours,policy_text
      FROM shop_booking_policies WHERE shop_id=$1`,[shop]);
    s.json({policy:x.rows[0]||{deposit_enabled:false,deposit_type:'FIXED',deposit_value:0,cancellation_notice_hours:24,policy_text:null}});
  }));
  r.get('/admin/shops/:shopId/booking-policy',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId); if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query('SELECT * FROM shop_booking_policies WHERE shop_id=$1',[shop]);
    s.json({policy:x.rows[0]||{shop_id:shop,deposit_enabled:false,deposit_type:'FIXED',deposit_value:0,cancellation_notice_hours:24,no_show_fee_paise:0,review_requests_enabled:false}});
  }));
  r.put('/admin/shops/:shopId/booking-policy',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),b=q.body||{};
    if(!shop||typeof b.depositEnabled!=='boolean'||!['FIXED','PERCENT'].includes(b.depositType||'FIXED')||
      !Number.isSafeInteger(b.depositValue??0)||(b.depositValue??0)<0||(b.depositEnabled&&(b.depositValue??0)<100)||
      !Number.isInteger(b.cancellationNoticeHours??24)||(b.cancellationNoticeHours??24)<0||(b.cancellationNoticeHours??24)>720||
      !Number.isSafeInteger(b.noShowFeePaise??0)||(b.noShowFeePaise??0)<0||
      typeof (b.reviewRequestsEnabled??false)!=='boolean'||!validHttps(b.googleReviewUrl)||
      (b.depositType==='PERCENT'&&(b.depositValue??0)>10000))
      return s.status(400).json({error:'Invalid deposit, cancellation, no-show or review policy values.'});
    const x=await pool.query(`INSERT INTO shop_booking_policies(shop_id,deposit_enabled,deposit_type,deposit_value,cancellation_notice_hours,no_show_fee_paise,policy_text,google_review_url,review_requests_enabled,updated_by,updated_at)
      SELECT id,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW() FROM shops WHERE id=$1 AND is_active=TRUE
      ON CONFLICT(shop_id) DO UPDATE SET deposit_enabled=EXCLUDED.deposit_enabled,deposit_type=EXCLUDED.deposit_type,deposit_value=EXCLUDED.deposit_value,
      cancellation_notice_hours=EXCLUDED.cancellation_notice_hours,no_show_fee_paise=EXCLUDED.no_show_fee_paise,policy_text=EXCLUDED.policy_text,
      google_review_url=EXCLUDED.google_review_url,review_requests_enabled=EXCLUDED.review_requests_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING *`,[shop,b.depositEnabled,b.depositType||'FIXED',b.depositValue??0,b.cancellationNoticeHours??24,b.noShowFeePaise??0,
      typeof b.policyText==='string'?b.policyText.slice(0,2000):null,b.googleReviewUrl||null,b.reviewRequestsEnabled??false,q.user.id]);
    if(!x.rowCount)return s.status(404).json({error:'Active shop not found.'});
    await audit(pool,shop,q.user.id,'BOOKING_POLICY_UPDATED','booking_policy',shop);
    s.json({policy:x.rows[0]});
  }));

  r.post('/shops/:shopId/waitlist',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),service=id(q.body?.serviceId),staff=q.body?.preferredStaffId==null?null:id(q.body.preferredStaffId),day=q.body?.requestedDate;
    const start=q.body?.preferredTimeStart||null,end=q.body?.preferredTimeEnd||null;
    if(!shop||!service||!/^\\d{4}-\\d{2}-\\d{2}$/.test(day||'')||(q.body?.preferredStaffId!=null&&!staff)||
      (start!==null&&!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(start))||(end!==null&&!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(end))||
      (start&&end&&start>=end))return s.status(400).json({error:'Provide a service, date and optional valid barber/time window.'});
    const x=await pool.query(`INSERT INTO shop_waitlist_entries(shop_id,customer_id,service_id,preferred_staff_id,requested_date,preferred_time_start,preferred_time_end)
      SELECT sh.id,$2,sv.id,$4,$5,$6,$7 FROM shops sh JOIN services sv ON sv.shop_id=sh.id
      WHERE sh.id=$1 AND sh.is_active=TRUE AND sv.id=$3 AND sv.is_active=TRUE AND $5::date >= (NOW() AT TIME ZONE sh.timezone)::date
      RETURNING id,shop_id,service_id,preferred_staff_id,requested_date,status,created_at`,
      [shop,q.user.id,service,staff,day,start,end]);
    if(!x.rowCount)return s.status(404).json({error:'Active shop or service not found.'});
    s.status(201).json({entry:x.rows[0],message:'You are on the waitlist. We will contact you if a matching slot opens.'});
  }));
  r.get('/customer/waitlist',...customer,wrap(async(q,s)=>{
    const x=await pool.query(`SELECT w.id,w.shop_id,sh.name shop_name,w.service_id,sv.name service_name,w.requested_date,w.status,
      w.offered_starts_at,w.offer_expires_at,st.display_name offered_barber
      FROM shop_waitlist_entries w JOIN shops sh ON sh.id=w.shop_id JOIN services sv ON sv.id=w.service_id
      LEFT JOIN shop_staff st ON st.id=w.offered_staff_id
      WHERE w.customer_id=$1 AND w.status IN('WAITING','OFFERED','BOOKED') ORDER BY w.created_at DESC LIMIT 100`,[q.user.id]);
    s.json({entries:x.rows});
  }));
  r.get('/admin/shops/:shopId/reminders/failed',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT r.id,r.customer_id,u.name customer_name,r.channel,r.template_key,r.attempt_count,r.scheduled_at,
      latest.error_code,latest.attempted_at
      FROM shop_customer_reminders r JOIN users u ON u.id=r.customer_id
      LEFT JOIN LATERAL(SELECT error_code,attempted_at FROM shop_message_delivery_attempts d WHERE d.reminder_id=r.id ORDER BY attempted_at DESC LIMIT 1) latest ON TRUE
      WHERE r.shop_id=$1 AND r.status='FAILED' ORDER BY r.scheduled_at DESC LIMIT 200`,[shop]);s.json({reminders:x.rows});
  }));
  r.post('/admin/shops/:shopId/reminders/:reminderId/retry',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),reminder=id(q.params.reminderId);if(!shop||!reminder)return s.status(400).json({error:'Invalid shop or reminder id.'});
    const x=await pool.query(`UPDATE shop_customer_reminders r SET status='PENDING',scheduled_at=NOW(),processing_at=NULL,attempt_count=0
      WHERE r.id=$1 AND r.shop_id=$2 AND r.status='FAILED'
      AND EXISTS(SELECT 1 FROM shop_message_templates t WHERE t.shop_id=r.shop_id AND t.channel=r.channel AND t.template_key=r.template_key AND t.is_active=TRUE)
      RETURNING r.id,r.status,r.channel,r.template_key`,[reminder,shop]);
    if(!x.rowCount)return s.status(409).json({error:'Failed reminder not found or its active template is missing.'});s.json({reminder:x.rows[0]});
  }));
  r.get('/admin/shops/:shopId/waitlist',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT w.*,u.name customer_name,u.phone,u.email,v.name service_name,st.display_name preferred_barber
      FROM shop_waitlist_entries w JOIN users u ON u.id=w.customer_id JOIN services v ON v.id=w.service_id
      LEFT JOIN shop_staff st ON st.id=w.preferred_staff_id WHERE w.shop_id=$1 AND w.status IN('WAITING','OFFERED')
      ORDER BY w.created_at LIMIT 300`,[shop]);s.json({entries:x.rows});
  }));
  r.post('/admin/shops/:shopId/waitlist/:entryId/offer',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),entry=id(q.params.entryId),appointment=id(q.body?.cancelledAppointmentId);
    if(!shop||!entry||!appointment)return s.status(400).json({error:'Provide shop, waitlist entry and cancelled appointment.'});
    const x=await offerWaitlistEntry(pool,shop,entry,appointment);
    if(!x)return s.status(409).json({error:'No matching open slot or the waitlist entry is no longer eligible.'});
    s.json({offer:x});
  }));
  r.post('/customer/waitlist/:entryId/accept',...customer,wrap(async(q,s)=>{
    const entry=id(q.params.entryId);if(!entry)return s.status(400).json({error:'Invalid waitlist entry.'});
    const c=await pool.connect();try{
      await c.query('BEGIN');
      const w=await c.query(`SELECT * FROM shop_waitlist_entries WHERE id=$1 AND customer_id=$2 AND status='OFFERED' AND offer_expires_at>NOW() FOR UPDATE`,[entry,q.user.id]);
      if(!w.rowCount){await c.query('ROLLBACK');return s.status(404).json({error:'This waitlist offer has expired or is no longer available.'});}
      const v=w.rows[0];
      const inserted=await c.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,deposit_due_paise)
       SELECT $1,$2,$3,$4,$5,$6,'BOOKED',CASE WHEN COALESCE(bp.deposit_enabled,FALSE) THEN LEAST(ROUND(sv.price*100)::bigint,CASE WHEN bp.deposit_type='PERCENT' THEN ROUND(sv.price*100*bp.deposit_value/10000)::bigint ELSE bp.deposit_value END) ELSE 0 END
       FROM services sv LEFT JOIN shop_booking_policies bp ON bp.shop_id=$1
       WHERE sv.id=$3 AND sv.shop_id=$1 AND $5>NOW()
       AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=$2 AND a.status IN('BOOKED','CONFIRMED','IN_PROGRESS','READY_TO_BILL') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange($5,$6,'[)'))
       AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=$2 AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$6,'[)')) RETURNING *`,
       [v.shop_id,v.offered_staff_id,v.service_id,q.user.id,v.offered_starts_at,v.offered_ends_at]);
      if(!inserted.rowCount){await c.query("UPDATE shop_waitlist_entries SET status='EXPIRED',updated_at=NOW() WHERE id=$1",[entry]);await c.query('COMMIT');if(v.offered_from_appointment_id)try{await offerWaitlistEntry(pool,v.shop_id,null,v.offered_from_appointment_id)}catch(e){console.error('Waitlist auto-refill after conflict failed',e.message)}return s.status(409).json({error:'The slot has just been taken. Please rejoin the waitlist.'});}
      await c.query("UPDATE shop_waitlist_entries SET status='BOOKED',accepted_appointment_id=$2,updated_at=NOW() WHERE id=$1",[entry,inserted.rows[0].id]);
      await scheduleAppointmentReminders(c,inserted.rows[0],{transactional:true});
      await c.query('COMMIT');s.status(201).json({appointment:inserted.rows[0]});
    }catch(e){await c.query('ROLLBACK');if(e.code==='23P01')return s.status(409).json({error:'The slot has just been taken.'});throw e;}finally{c.release();}
  }));
  r.post('/customer/waitlist/:entryId/decline',...customer,wrap(async(q,s)=>{
    const entry=id(q.params.entryId);if(!entry)return s.status(400).json({error:'Invalid waitlist entry.'});
    const x=await pool.query("UPDATE shop_waitlist_entries SET status='CANCELLED',updated_at=NOW() WHERE id=$1 AND customer_id=$2 AND status IN('WAITING','OFFERED') RETURNING id,status,shop_id,offered_from_appointment_id",[entry,q.user.id]);
    if(!x.rowCount)return s.status(404).json({error:'Waitlist entry not found.'});if(x.rows[0].offered_from_appointment_id){try{await offerWaitlistEntry(pool,x.rows[0].shop_id,null,x.rows[0].offered_from_appointment_id)}catch(e){console.error('Waitlist refill after decline failed',e.message)}}s.json({entry:x.rows[0]});
  }));

  r.get('/public/shops/:shopId/queue',wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT a.id,a.status,a.starts_at,sv.name service_name,st.display_name barber_name
      FROM appointments a JOIN services sv ON sv.id=a.service_id JOIN shop_staff st ON st.id=a.staff_id
      JOIN shops sh ON sh.id=a.shop_id WHERE a.shop_id=$1 AND sh.is_active=TRUE
      AND a.starts_at >= (NOW() AT TIME ZONE sh.timezone)::date AT TIME ZONE sh.timezone
      AND a.status IN('IN_PROGRESS','READY_TO_BILL','CONFIRMED','BOOKED')
      ORDER BY CASE a.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'READY_TO_BILL' THEN 1 ELSE 2 END,a.starts_at LIMIT 12`,[shop]);
    const serving=x.rows.filter(x=>['IN_PROGRESS','READY_TO_BILL'].includes(x.status)).slice(0,3);
    const next=x.rows.filter(x=>!['IN_PROGRESS','READY_TO_BILL'].includes(x.status)).slice(0,6);
    s.set('Cache-Control','no-store');s.json({nowServing:serving.map(x=>({ticket:'#'+x.id,service:x.service_name,barber:x.barber_name,status:x.status})),
      nextUp:next.map(x=>({ticket:'#'+x.id,service:x.service_name,barber:x.barber_name,startsAt:x.starts_at}))});
  }));

  r.get('/customer/shops/:shopId/preferences',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const [profile,messaging,events,contact,rebooking]=await Promise.all([
      pool.query(`SELECT p.*,st.display_name preferred_staff_name,sv.name preferred_service_name,
        COALESCE((SELECT e.consent FROM shop_customer_consent_events e WHERE e.shop_id=$1 AND e.customer_id=$2 AND e.purpose='PROFILE_NOTES' ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),FALSE) profile_notes_consent
        FROM shop_customer_profiles p LEFT JOIN shop_staff st ON st.id=p.preferred_staff_id AND st.shop_id=p.shop_id
        LEFT JOIN services sv ON sv.id=p.preferred_service_id AND sv.shop_id=p.shop_id WHERE p.shop_id=$1 AND p.customer_id=$2`,[shop,q.user.id]),
      pool.query('SELECT channel,destination,consent,revoked_at FROM shop_message_consents WHERE shop_id=$1 AND customer_id=$2',[shop,q.user.id]),
      pool.query(`SELECT DISTINCT ON(purpose) purpose,consent FROM shop_customer_consent_events WHERE shop_id=$1 AND customer_id=$2 AND purpose IN('MARKETING','PHOTO_STORAGE') ORDER BY purpose,recorded_at DESC,id DESC`,[shop,q.user.id]),
      pool.query('SELECT email,phone FROM users WHERE id=$1',[q.user.id]),
      pool.query('SELECT interval_days,enabled FROM shop_customer_rebooking_profiles WHERE shop_id=$1 AND customer_id=$2',[shop,q.user.id])
    ]);
    const p=profile.rows[0]||null,byPurpose=Object.fromEntries(events.rows.map(x=>[x.purpose,x.consent]));
    const byChannel=Object.fromEntries(messaging.rows.map(x=>[x.channel,{consent:x.consent&&!x.revoked_at,destination:x.destination}]));
    s.set('Cache-Control','no-store').json({profile:p,contact:contact.rows[0]||{},messaging:byChannel,rebooking:rebooking.rows[0]||{interval_days:21,enabled:false},consents:{
      profileNotes:!!p?.profile_notes_consent,photoStorage:byPurpose.PHOTO_STORAGE??!!p?.photo_consent,
      marketing:byPurpose.MARKETING??false,whatsapp:!!byChannel.WHATSAPP?.consent,sms:!!byChannel.SMS?.consent
    }});
  }));
  r.put('/customer/shops/:shopId/preferences',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),b=q.body||{},staff=b.preferredStaffId==null?null:id(b.preferredStaffId),service=b.preferredServiceId==null?null:id(b.preferredServiceId);
    if(!shop||(b.preferredStaffId!=null&&!staff)||(b.preferredServiceId!=null&&!service)||
      (b.preferredIntervalDays!=null&&(!Number.isInteger(b.preferredIntervalDays)||b.preferredIntervalDays<7||b.preferredIntervalDays>180))||
      (b.skinNotes!=null&&(typeof b.skinNotes!=='string'||b.skinNotes.length>1000))||
      (b.allergyNotes!=null&&(typeof b.allergyNotes!=='string'||b.allergyNotes.length>1000))||
      typeof b.photoConsent!=='boolean'||typeof b.profileNotesConsent!=='boolean'||(!b.profileNotesConsent&&Boolean(b.skinNotes||b.allergyNotes))||!validHttps(b.beforePhotoUrl)||!validHttps(b.afterPhotoUrl))
      return s.status(400).json({error:'Invalid customer preferences or photo consent details.'});
    const x=await pool.query(`INSERT INTO shop_customer_profiles(shop_id,customer_id,preferred_staff_id,preferred_service_id,preferred_interval_days,skin_notes,allergy_notes,photo_consent,photo_consent_at,before_photo_url,after_photo_url)
      SELECT sh.id,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN NOW() ELSE NULL END,CASE WHEN $8 THEN $9 ELSE NULL END,CASE WHEN $8 THEN $10 ELSE NULL END
      FROM shops sh WHERE sh.id=$1 AND sh.is_active=TRUE
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET preferred_staff_id=EXCLUDED.preferred_staff_id,preferred_service_id=EXCLUDED.preferred_service_id,
      preferred_interval_days=EXCLUDED.preferred_interval_days,skin_notes=EXCLUDED.skin_notes,allergy_notes=EXCLUDED.allergy_notes,
      photo_consent=EXCLUDED.photo_consent,photo_consent_at=CASE WHEN EXCLUDED.photo_consent THEN NOW() ELSE NULL END,
      before_photo_url=EXCLUDED.before_photo_url,after_photo_url=EXCLUDED.after_photo_url,updated_at=NOW()
      RETURNING shop_id,customer_id,preferred_staff_id,preferred_service_id,preferred_interval_days,skin_notes,allergy_notes,photo_consent,photo_consent_at,before_photo_url,after_photo_url`,
      [shop,q.user.id,staff,service,b.preferredIntervalDays??21,b.profileNotesConsent?(b.skinNotes??null):null,b.profileNotesConsent?(b.allergyNotes??null):null,b.photoConsent,b.beforePhotoUrl||null,b.afterPhotoUrl||null]);
    if(!x.rowCount)return s.status(404).json({error:'Active shop not found.'});
    await pool.query(`INSERT INTO shop_customer_consent_events(shop_id,customer_id,purpose,consent,notice_version)
      VALUES($1,$2,'PROFILE_NOTES',$3,$4),($1,$2,'PHOTO_STORAGE',$5,$4)`,
      [shop,q.user.id,b.profileNotesConsent,b.noticeVersion||'v1',b.photoConsent]);
    s.json({profile:x.rows[0]});
  }));

  r.get('/customer/data-export',...customer,wrap(async(q,s)=>{
    const [user,appointments,payments,consents,profiles,consentEvents,feedback,rights,reminders,waitlist]=await Promise.all([
      pool.query('SELECT id,name,email,phone,created_at FROM users WHERE id=$1',[q.user.id]),
      pool.query(`SELECT a.id,a.shop_id,sh.name shop_name,a.starts_at,a.ends_at,a.status,a.customer_notes,a.deposit_due_paise,a.deposit_paid_paise,a.no_show_fee_due_paise,a.no_show_fee_status,sv.name service_name,st.display_name barber_name
        FROM appointments a JOIN shops sh ON sh.id=a.shop_id JOIN services sv ON sv.id=a.service_id JOIN shop_staff st ON st.id=a.staff_id
        WHERE a.customer_id=$1 ORDER BY a.starts_at DESC LIMIT 2000`,[q.user.id]),
      pool.query(`SELECT p.id,p.appointment_id,p.amount_paise,p.currency,p.status,p.payment_purpose,p.created_at,
        COALESCE((SELECT SUM(r.amount_paise) FROM payment_refunds r WHERE r.payment_id=p.id AND r.status='PROCESSED'),0)::bigint refunded_amount_paise
        FROM payments p WHERE p.customer_id=$1 ORDER BY p.created_at DESC LIMIT 2000`,[q.user.id]),
      pool.query('SELECT shop_id,channel,destination,consent,consented_at,revoked_at FROM shop_message_consents WHERE customer_id=$1 ORDER BY shop_id,channel',[q.user.id]),
      pool.query('SELECT shop_id,preferred_staff_id,preferred_service_id,preferred_interval_days,skin_notes,allergy_notes,photo_consent,photo_consent_at,before_photo_url,after_photo_url,notes FROM shop_customer_profiles WHERE customer_id=$1',[q.user.id]),
      pool.query('SELECT shop_id,purpose,channel,consent,notice_version,source,recorded_at FROM shop_customer_consent_events WHERE customer_id=$1 ORDER BY recorded_at',[q.user.id]),
      pool.query('SELECT shop_id,appointment_id,rating,comment,created_at FROM shop_customer_feedback WHERE customer_id=$1 ORDER BY created_at DESC',[q.user.id]),
      pool.query('SELECT id,request_type,status,reason,requested_at,resolved_at FROM shop_data_rights_requests WHERE customer_id=$1 ORDER BY requested_at DESC',[q.user.id]),
      pool.query('SELECT shop_id,appointment_id,channel,template_key,status,scheduled_at,sent_at,created_at FROM shop_customer_reminders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 2000',[q.user.id]),
      pool.query(`SELECT w.id,w.shop_id,sh.name shop_name,sv.name service_name,w.requested_date,w.status,w.offered_starts_at,w.offer_expires_at,w.created_at
        FROM shop_waitlist_entries w JOIN shops sh ON sh.id=w.shop_id JOIN services sv ON sv.id=w.service_id
        WHERE w.customer_id=$1 ORDER BY w.created_at DESC LIMIT 1000`,[q.user.id])
    ]);
    s.set('Content-Disposition','attachment; filename="barberpro-personal-data.json"');
    s.json({exportedAt:new Date().toISOString(),account:user.rows[0]||null,appointments:appointments.rows,payments:payments.rows,consents:consents.rows,profiles:profiles.rows,consentEvents:consentEvents.rows,feedback:feedback.rows,rightsRequests:rights.rows,reminders:reminders.rows,waitlist:waitlist.rows});
  }));
  r.post('/customer/shops/:shopId/consent-events',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),b=q.body||{};
    if(!shop||!['APPOINTMENT_REMINDERS','MARKETING','PROFILE_NOTES','PHOTO_STORAGE'].includes(b.purpose)||
      typeof b.consent!=='boolean'||(b.channel!=null&&!['EMAIL','SMS','WHATSAPP'].includes(b.channel))||
      (b.noticeVersion!=null&&(typeof b.noticeVersion!=='string'||b.noticeVersion.length>64)))
      return s.status(400).json({error:'Provide a valid consent purpose, choice, optional channel and notice version.'});
    const x=await pool.query(`INSERT INTO shop_customer_consent_events(shop_id,customer_id,purpose,channel,consent,notice_version)
      SELECT id,$2,$3,$4,$5,$6 FROM shops WHERE id=$1 AND is_active=TRUE RETURNING *`,
      [shop,q.user.id,b.purpose,b.channel||null,b.consent,b.noticeVersion||'v1']);
    if(!x.rowCount)return s.status(404).json({error:'Active shop not found.'});s.status(201).json({consentEvent:x.rows[0]});
  }));
  r.get('/admin/shops/:shopId/consent-events',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT e.id,e.customer_id,u.name customer_name,e.purpose,e.channel,e.consent,e.notice_version,e.source,e.recorded_at
      FROM shop_customer_consent_events e JOIN users u ON u.id=e.customer_id
      WHERE e.shop_id=$1 ORDER BY e.recorded_at DESC LIMIT 1000`,[shop]);s.json({events:x.rows});
  }));
  r.get('/customer/shops/:shopId/rebooking-preference',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query('SELECT interval_days,enabled FROM shop_customer_rebooking_profiles WHERE shop_id=$1 AND customer_id=$2',[shop,q.user.id]);
    s.json({preference:x.rows[0]||{interval_days:21,enabled:false}});
  }));
  r.put('/customer/shops/:shopId/rebooking-preference',...customer,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),days=q.body?.intervalDays,enabled=q.body?.enabled;
    if(!shop||!Number.isInteger(days)||days<7||days>365||typeof enabled!=='boolean')return s.status(400).json({error:'Provide an interval from 7 to 365 days and an explicit reminder choice.'});
    const x=await pool.query(`INSERT INTO shop_customer_rebooking_profiles(shop_id,customer_id,interval_days,enabled,interval_source)
      SELECT id,$2,$3,$4,'MANUAL' FROM shops WHERE id=$1 AND is_active=TRUE
      ON CONFLICT(shop_id,customer_id) DO UPDATE SET interval_days=EXCLUDED.interval_days,interval_source='MANUAL',enabled=EXCLUDED.enabled,updated_at=NOW()
      RETURNING interval_days,enabled`,[shop,q.user.id,days,enabled]);
    if(!x.rowCount)return s.status(404).json({error:'Active shop not found.'});s.json({preference:x.rows[0]});
  }));

  r.post('/customer/data-rights-requests',...customer,wrap(async(q,s)=>{
    const type=q.body?.type,reason=typeof q.body?.reason==='string'?q.body.reason.trim():null;
    if(!['EXPORT','DELETE'].includes(type)||(reason&&reason.length>1000))return s.status(400).json({error:'Request type must be EXPORT or DELETE; optional reason is limited to 1000 characters.'});
    const x=await pool.query(`INSERT INTO shop_data_rights_requests(customer_id,request_type,reason)
      VALUES($1,$2,$3) RETURNING id,request_type,status,requested_at`,[q.user.id,type,reason]);
    s.status(201).json({request:x.rows[0],message:type==='DELETE'?'Deletion request received. Records may need to be retained for legal, tax, payment or dispute obligations; an administrator will review it.':'Your data export is available from the customer data export endpoint.'});
  }));
  r.get('/admin/shops/:shopId/data-rights-requests',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`SELECT d.*,u.name customer_name,u.email FROM shop_data_rights_requests d
      JOIN users u ON u.id=d.customer_id WHERE d.shop_id=$1 OR (d.shop_id IS NULL AND EXISTS(SELECT 1 FROM appointments a WHERE a.shop_id=$1 AND a.customer_id=d.customer_id)) ORDER BY d.requested_at DESC LIMIT 300`,[shop]);s.json({requests:x.rows});
  }));
  r.patch('/admin/data-rights-requests/:requestId',...admin,wrap(async(q,s)=>{
    const request=id(q.params.requestId),status=q.body?.status,note=typeof q.body?.resolutionNote==='string'?q.body.resolutionNote.trim():null;
    if(!request||!['IN_REVIEW','COMPLETED','REJECTED'].includes(status)||(note&&note.length>1000))return s.status(400).json({error:'Invalid request status or resolution note.'});
    const x=await pool.query(`UPDATE shop_data_rights_requests SET status=$2,resolution_note=$3,reviewed_by=$4,resolved_at=CASE WHEN $2 IN('COMPLETED','REJECTED') THEN NOW() ELSE NULL END
      WHERE id=$1 RETURNING id,request_type,status,resolution_note,requested_at,resolved_at`,[request,status,note,q.user.id]);
    if(!x.rowCount)return s.status(404).json({error:'Data-rights request not found.'});s.json({request:x.rows[0],dataDeleted:false});
  }));

  r.post('/admin/shops/:shopId/appointments/:appointmentId/mark-no-show',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId),appointment=id(q.params.appointmentId);if(!shop||!appointment)return s.status(400).json({error:'Invalid shop or appointment id.'});
    const x=await pool.query(`UPDATE appointments a SET status='NO_SHOW',no_show_fee_due_paise=COALESCE((SELECT p.no_show_fee_paise FROM shop_booking_policies p WHERE p.shop_id=a.shop_id),0),
      no_show_fee_status=CASE WHEN COALESCE((SELECT p.no_show_fee_paise FROM shop_booking_policies p WHERE p.shop_id=a.shop_id),0)>0 THEN 'DUE' ELSE 'NOT_DUE' END,updated_at=NOW()
      WHERE a.id=$1 AND a.shop_id=$2 AND a.status IN('BOOKED','CONFIRMED') AND a.ends_at<NOW()
      RETURNING a.id,a.status,a.no_show_fee_due_paise,a.no_show_fee_status`,[appointment,shop]);
    if(!x.rowCount)return s.status(409).json({error:'Appointment is not eligible for no-show marking or the shop has no booking policy configured.'});
    await audit(pool,shop,q.user.id,'APPOINTMENT_MARKED_NO_SHOW','appointment',appointment,{feePaise:x.rows[0].no_show_fee_due_paise});
    s.json({appointment:x.rows[0],automaticCharge:false,message:'No-show fee recorded as due; collect it through an authorized payment or POS flow. BarberPro does not auto-charge stored cards.'});
  }));

  r.get('/admin/shops/:shopId/rebooking-due',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const x=await pool.query(`WITH last_visits AS (
      SELECT DISTINCT ON (a.shop_id,a.customer_id) a.shop_id,a.customer_id,a.starts_at
      FROM appointments a WHERE a.status='COMPLETED' AND a.shop_id=$1 ORDER BY a.shop_id,a.customer_id,a.starts_at DESC
    )
    SELECT lv.customer_id,u.name,u.phone,u.email,COALESCE(cp.preferred_interval_days,21) preferred_interval_days,
      lv.starts_at last_visit,lv.starts_at+make_interval(days=>COALESCE(cp.preferred_interval_days,21)) due_at
    FROM last_visits lv LEFT JOIN shop_customer_profiles cp ON cp.shop_id=lv.shop_id AND cp.customer_id=lv.customer_id
    JOIN users u ON u.id=lv.customer_id
    WHERE lv.starts_at+make_interval(days=>COALESCE(cp.preferred_interval_days,21))<=NOW()
    ORDER BY due_at LIMIT 500`,[shop]);s.json({customers:x.rows});
  }));

  r.post('/customer/appointments/:appointmentId/review',...customer,wrap(async(q,s)=>{
    const appointment=id(q.params.appointmentId),rating=q.body?.rating,comment=typeof q.body?.comment==='string'?q.body.comment.trim():null;
    if(!appointment||!Number.isInteger(rating)||rating<1||rating>5||(comment&&comment.length>1500))return s.status(400).json({error:'Provide a rating from 1 to 5 and an optional comment.'});
    const x=await pool.query(`INSERT INTO shop_customer_feedback(shop_id,customer_id,appointment_id,rating,comment)
      SELECT a.shop_id,a.customer_id,a.id,$3,$4 FROM appointments a WHERE a.id=$1 AND a.customer_id=$2 AND a.status='COMPLETED'
      RETURNING id,shop_id,rating,comment,created_at`,[appointment,q.user.id,rating,comment]);
    if(!x.rowCount)return s.status(404).json({error:'Completed appointment not found or feedback already submitted.'});
    const settings=await pool.query('SELECT google_review_url FROM shop_booking_policies WHERE shop_id=$1',[x.rows[0].shop_id]);
    s.status(201).json({feedback:x.rows[0],route:rating>=4?'GOOGLE_REVIEW':'PRIVATE_FEEDBACK',googleReviewUrl:rating>=4?(settings.rows[0]?.google_review_url||null):null});
  }));

  r.get('/admin/shops/:shopId/demo-customer-profiles',...admin,wrap(async(q,s)=>{
    const shop=id(q.params.shopId);if(!shop)return s.status(400).json({error:'Invalid shop id.'});
    const seeds=[
      ['DEMO-001','Demo Customer Asha (SAMPLE)','Sample barber preference','Classic haircut','Synthetic sample notes: prefers a neat, low-maintenance style.'],
      ['DEMO-002','Demo Customer Rohan (SAMPLE)','No preference','Beard trim','Synthetic sample notes: asks for a tidy beard outline.'],
      ['DEMO-003','Demo Customer Meera (SAMPLE)','No preference','Hair wash','Synthetic sample notes: no additional service notes.']
    ];
    for(const row of seeds)await pool.query(`INSERT INTO shop_demo_customer_profiles(shop_id,demo_key,display_name,preferred_barber_label,preferred_service_label,care_notes)
      SELECT id,$2,$3,$4,$5,$6 FROM shops WHERE id=$1 AND is_active=TRUE ON CONFLICT(shop_id,demo_key) DO NOTHING`,[shop,...row]);
    const out=await pool.query('SELECT demo_key,display_name,preferred_barber_label,preferred_service_label,care_notes,photo_storage_consent,marketing_consent,whatsapp_reminders_consent,sms_reminders_consent FROM shop_demo_customer_profiles WHERE shop_id=$1 ORDER BY demo_key',[shop]);
    s.json({profiles:out.rows,notice:'Synthetic demo records only; these are not user accounts and do not represent customer consent.'});
  }));

  return r;
}

async function offerWaitlistEntry(db,shopId,entryId,cancelledAppointmentId) {
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    const slot=await c.query(`SELECT a.shop_id,a.service_id,a.staff_id,a.starts_at,a.ends_at
      FROM appointments a WHERE a.id=$1 AND a.shop_id=$2 AND a.status='CANCELLED'
      AND NOT EXISTS(SELECT 1 FROM appointments active WHERE active.staff_id=a.staff_id AND active.status IN('BOOKED','CONFIRMED','IN_PROGRESS','READY_TO_BILL') AND tstzrange(active.starts_at,active.ends_at,'[)')&&tstzrange(a.starts_at,a.ends_at,'[)'))
      AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=a.staff_id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange(a.starts_at,a.ends_at,'[)')) FOR UPDATE`,[cancelledAppointmentId,shopId]);
    if(!slot.rowCount){await c.query('ROLLBACK');return null;}
    const a=slot.rows[0];
    const w=await c.query(`SELECT * FROM shop_waitlist_entries WHERE ($1::bigint IS NULL OR id=$1) AND shop_id=$2 AND service_id=$3
      AND requested_date=(($4::timestamptz AT TIME ZONE (SELECT timezone FROM shops WHERE id=$2))::date)
      AND status='WAITING' AND (preferred_staff_id IS NULL OR preferred_staff_id=$5)
      AND (preferred_time_start IS NULL OR ($4::timestamptz AT TIME ZONE (SELECT timezone FROM shops WHERE id=$2))::time>=preferred_time_start)
      AND (preferred_time_end IS NULL OR ($4::timestamptz AT TIME ZONE (SELECT timezone FROM shops WHERE id=$2))::time<preferred_time_end)
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[entryId,shopId,a.service_id,a.starts_at,a.staff_id]);
    if(!w.rowCount){await c.query('ROLLBACK');return null;}
    const updated=await c.query(`UPDATE shop_waitlist_entries SET status='OFFERED',offered_staff_id=$2,offered_starts_at=$3,offered_ends_at=$4,
      offer_expires_at=NOW()+INTERVAL '15 minutes',offered_from_appointment_id=$5,updated_at=NOW() WHERE id=$1 RETURNING *`,[w.rows[0].id,a.staff_id,a.starts_at,a.ends_at,cancelledAppointmentId]);
    const customer=await c.query(`SELECT c.channel,c.destination FROM shop_message_consents c JOIN shop_messaging_settings m ON m.shop_id=c.shop_id
      JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key='WAITLIST_OFFER' AND t.is_active=TRUE
      JOIN users u ON u.id=c.customer_id WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.consent=TRUE AND c.revoked_at IS NULL
      AND c.channel=ANY(m.enabled_channels) AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN('SMS','WHATSAPP') AND c.destination=u.phone))`,
      [shopId,w.rows[0].customer_id]);
    for(const ch of customer.rows)await c.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key,metadata)
      VALUES($1,$2,$3,$4,'WAITLIST_OFFER',NOW(),$5,$6::jsonb) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [shopId,w.rows[0].customer_id,cancelledAppointmentId,ch.channel,'waitlist:'+w.rows[0].id+':'+ch.channel,JSON.stringify({waitlistEntryId:w.rows[0].id,offeredStartsAt:a.starts_at,offerExpiresAt:updated.rows[0].offer_expires_at})]);
    await c.query('COMMIT');return updated.rows[0];
  } catch(e){await c.query('ROLLBACK');throw e;} finally {c.release();}
}

module.exports={createRetentionRouter,offerWaitlistEntry};
