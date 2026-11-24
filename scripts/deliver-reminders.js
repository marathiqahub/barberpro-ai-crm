'use strict';
require('dotenv').config();
const {Pool}=require('pg');
const {deliver}=require('../src/messaging/delivery');
const {offerWaitlistEntry}=require('../src/routes/retentionRoutes');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
async function purgeExpiredReferencePhotos(){ await pool.query('DELETE FROM shop_appointment_reference_photos WHERE retention_until<=NOW()'); }
async function refillExpiredWaitlistOffers(){
 const expired=await pool.query(`UPDATE shop_waitlist_entries SET status='EXPIRED',updated_at=NOW()
  WHERE status='OFFERED' AND offer_expires_at<=NOW() RETURNING shop_id,offered_from_appointment_id`);
 for(const row of expired.rows)if(row.offered_from_appointment_id){
  try{await offerWaitlistEntry(pool,row.shop_id,null,row.offered_from_appointment_id)}
  catch(e){console.error('Waitlist auto-refill failed',row.shop_id,e.message)}
 }
}
async function queueMissingAppointmentReminders(){
 await pool.query(`WITH reminder_types(template_key,hours_before) AS (
   VALUES ('APPOINTMENT_REMINDER_24H',24),('APPOINTMENT_REMINDER_2H',2)
  )
  INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key)
  SELECT a.shop_id,a.customer_id,a.id,c.channel,rt.template_key,
    GREATEST(NOW(),a.starts_at-make_interval(hours=>rt.hours_before)),
    'appointment:'||a.id::text||':'||c.channel||':'||rt.template_key
  FROM appointments a JOIN shop_message_consents c ON c.shop_id=a.shop_id AND c.customer_id=a.customer_id
  JOIN shop_messaging_settings m ON m.shop_id=a.shop_id AND c.channel=ANY(m.enabled_channels)
  JOIN reminder_types rt ON TRUE
  JOIN shop_message_templates t ON t.shop_id=a.shop_id AND t.channel=c.channel AND t.template_key=rt.template_key AND t.is_active=TRUE
  JOIN users u ON u.id=a.customer_id
  WHERE a.status IN('BOOKED','CONFIRMED') AND a.starts_at>NOW()
    AND (a.starts_at>=NOW()+make_interval(hours=>rt.hours_before) OR rt.hours_before=2)
    AND c.consent=TRUE AND c.revoked_at IS NULL
    AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN('SMS','WHATSAPP') AND c.destination=u.phone))
  ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`);
}
async function queueRebookingAndReviewNudges(){
 await pool.query(`WITH last_visits AS (
   SELECT DISTINCT ON (a.shop_id,a.customer_id) a.shop_id,a.customer_id,a.id appointment_id,a.starts_at,a.service_id
   FROM appointments a WHERE a.status='COMPLETED' ORDER BY a.shop_id,a.customer_id,a.starts_at DESC
  ), due AS (
   SELECT lv.*,COALESCE(cp.preferred_interval_days,21) preferred_interval_days,sh.name shop_name,sv.name service_name
   FROM last_visits lv LEFT JOIN shop_customer_profiles cp ON cp.shop_id=lv.shop_id AND cp.customer_id=lv.customer_id
   JOIN shops sh ON sh.id=lv.shop_id JOIN services sv ON sv.id=lv.service_id
   WHERE lv.starts_at+make_interval(days=>COALESCE(cp.preferred_interval_days,21))<=NOW()
     AND NOT EXISTS(SELECT 1 FROM appointments upcoming WHERE upcoming.shop_id=lv.shop_id AND upcoming.customer_id=lv.customer_id AND upcoming.status IN('BOOKED','CONFIRMED') AND upcoming.starts_at>NOW())
  )
  INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key)
  SELECT d.shop_id,d.customer_id,d.appointment_id,c.channel,'REBOOKING_NUDGE',NOW(),
    'rebook:'||d.shop_id::text||':'||d.customer_id::text||':'||d.appointment_id::text||':'||c.channel
  FROM due d JOIN shop_message_consents c ON c.shop_id=d.shop_id AND c.customer_id=d.customer_id
  JOIN shop_messaging_settings m ON m.shop_id=d.shop_id AND c.channel=ANY(m.enabled_channels)
  JOIN shop_message_templates t ON t.shop_id=d.shop_id AND t.channel=c.channel AND t.template_key='REBOOKING_NUDGE' AND t.is_active=TRUE
  JOIN users u ON u.id=c.customer_id
  WHERE c.consent=TRUE AND c.revoked_at IS NULL
    AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN('SMS','WHATSAPP') AND c.destination=u.phone))
  ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`);
 await pool.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key)
  SELECT a.shop_id,a.customer_id,a.id,c.channel,'REVIEW_REQUEST',NOW(),
    'review:'||a.id::text||':'||c.channel
  FROM appointments a JOIN shop_booking_policies bp ON bp.shop_id=a.shop_id AND bp.review_requests_enabled=TRUE
  JOIN shop_message_consents c ON c.shop_id=a.shop_id AND c.customer_id=a.customer_id
  JOIN shop_messaging_settings m ON m.shop_id=a.shop_id AND c.channel=ANY(m.enabled_channels)
  JOIN shop_message_templates t ON t.shop_id=a.shop_id AND t.channel=c.channel AND t.template_key='REVIEW_REQUEST' AND t.is_active=TRUE
  JOIN users u ON u.id=a.customer_id
  WHERE a.status='COMPLETED' AND a.ends_at<=NOW()-INTERVAL '2 hours'
    AND NOT EXISTS(SELECT 1 FROM shop_customer_feedback f WHERE f.appointment_id=a.id AND f.customer_id=a.customer_id)
    AND c.channel='WHATSAPP' AND c.consent=TRUE AND c.revoked_at IS NULL AND c.destination=u.phone
  ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`);
}
async function run(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
 await purgeExpiredReferencePhotos();
 await refillExpiredWaitlistOffers();
 await queueMissingAppointmentReminders();
 await queueRebookingAndReviewNudges();
 const client=await pool.connect();let rows=[];
 try{
  await client.query('BEGIN');
  await client.query("UPDATE shop_customer_reminders SET status='PENDING',processing_at=NULL WHERE status='PROCESSING' AND processing_at<NOW()-INTERVAL '10 minutes'");
  const result=await client.query(`SELECT r.*,u.email,u.phone,u.phone_verified_at,u.preferred_locale,u.name AS customer_name,sh.name AS shop_name,sh.timezone AS shop_timezone,a.starts_at AS appointment_starts_at,sv.name AS service_name,
   COALESCE(tr.subject,t.subject) subject,COALESCE(tr.body,t.body) body,m.email_provider,m.whatsapp_provider,m.sender_email,m.sender_name,m.sms_from,m.whatsapp_phone_number_id,m.enabled_channels,
   COALESCE(tr.provider_template_name,t.provider_template_name) provider_template_name,
   COALESCE(tr.provider_template_language,t.provider_template_language) provider_template_language,
   COALESCE(tr.provider_template_status,t.provider_template_status,'PENDING') provider_template_status
   FROM shop_customer_reminders r JOIN users u ON u.id=r.customer_id JOIN shops sh ON sh.id=r.shop_id LEFT JOIN appointments a ON a.id=r.appointment_id LEFT JOIN services sv ON sv.id=a.service_id
   JOIN shop_message_templates t ON t.shop_id=r.shop_id AND t.channel=r.channel AND t.template_key=r.template_key AND t.is_active=TRUE
   LEFT JOIN shop_message_template_translations tr ON tr.shop_id=r.shop_id AND tr.channel=r.channel AND tr.template_key=r.template_key AND tr.locale=u.preferred_locale
   LEFT JOIN shop_messaging_settings m ON m.shop_id=r.shop_id
   WHERE r.status='PENDING' AND r.channel IN ('EMAIL','SMS','WHATSAPP') AND r.scheduled_at<=NOW()
   ORDER BY r.scheduled_at,r.id LIMIT 25 FOR UPDATE OF r SKIP LOCKED`);
  rows=result.rows;for(const row of rows)await client.query("UPDATE shop_customer_reminders SET status='PROCESSING',processing_at=NOW(),attempt_count=attempt_count+1 WHERE id=$1",[row.id]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 for(const row of rows){
  let destination=row.channel==='EMAIL'?row.email:row.phone;
  try{
   const phoneDigits=String(destination||'').replace(/\D/g,'');
   const indiaDomestic=/^\+91/.test(String(destination||''))||/^91\d{10}$/.test(phoneDigits)||/^\d{10}$/.test(phoneDigits);
   if(row.channel==='SMS'&&indiaDomestic&&process.env.TWILIO_INDIA_SMS_ROUTE!=='INTERNATIONAL'&&(!process.env.TWILIO_DLT_PE_ID||!row.provider_template_name||row.provider_template_status!=='APPROVED')){await pool.query("UPDATE shop_customer_reminders SET status='PENDING',processing_at=NULL WHERE id=$1",[row.id]);continue;}
   if(!row.enabled_channels?.includes(row.channel))throw Object.assign(new Error('This channel is not enabled for the shop'),{code:'CHANNEL_DISABLED'});
   if(row.channel!=='EMAIL'&&!row.phone_verified_at)throw Object.assign(new Error('Customer phone number is not verified'),{code:'PHONE_NOT_VERIFIED'});
   if(!destination)throw Object.assign(new Error('Customer has no destination for this channel'),{code:'NO_DESTINATION'});
   {
    const consent=await pool.query(`SELECT 1 FROM shop_message_consents WHERE shop_id=$1 AND customer_id=$2 AND channel=$3 AND destination=$4 AND consent=TRUE AND revoked_at IS NULL`,[row.shop_id,row.customer_id,row.channel,destination]);
    if(!consent.rowCount)throw Object.assign(new Error('No active consent for this channel'),{code:'CONSENT_REQUIRED'});
   }
   const rawTime=row.template_key==='WAITLIST_OFFER'?row.metadata?.offeredStartsAt:row.appointment_starts_at;
   const locale=row.preferred_locale==='hi'?'hi-IN':row.preferred_locale==='mr'?'mr-IN':'en-IN';
   const appointmentTime=rawTime?new Date(rawTime).toLocaleString(locale,{timeZone:row.shop_timezone||'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}):'';
   const body=String(row.body).replace(/\{\{shop_name\}\}/g,row.shop_name).replace(/\{\{customer_name\}\}/g,row.customer_name).replace(/\{\{appointment_id\}\}/g,String(row.appointment_id||'')).replace(/\{\{waitlist_entry_id\}\}/g,String(row.metadata?.waitlistEntryId||'')).replace(/\{\{appointment_time\}\}/g,appointmentTime).replace(/\{\{service_name\}\}/g,row.service_name||'').replace(/\{\{tip_payment_link\}\}/g,row.metadata?.tipPaymentLink||'');
   const templateValue=row.template_key==='WAITLIST_OFFER'?row.metadata?.waitlistEntryId:row.appointment_id;
   const secondValue=row.template_key==='TIP_PAYMENT_LINK'?(row.metadata?.tipPaymentLink||''):['REBOOKING_NUDGE','REVIEW_REQUEST'].includes(row.template_key)?(row.service_name||''):appointmentTime;
   const variables=templateValue==null?{}:{'1':String(templateValue),'2':String(secondValue),'3':String(row.shop_name||'')};
   const sent=await deliver(row.channel,destination,{subject:row.subject,body,variables},process.env,global.fetch,{provider:row.whatsapp_provider,phoneNumberId:row.whatsapp_phone_number_id,from:row.channel==='SMS'?row.sms_from:row.channel==='EMAIL'?row.sender_email:null,templateName:row.provider_template_name,templateStatus:row.provider_template_status,language:row.provider_template_language||'en_US'});
   await pool.query("UPDATE shop_customer_reminders SET status='SENT',sent_at=NOW(),processing_at=NULL,provider_reference=$2 WHERE id=$1",[row.id,sent.reference]);
   if(row.related_entity_type==='REVIEW_REQUEST')await pool.query("UPDATE shop_review_requests SET status='SENT' WHERE id=$1",[row.related_entity_id]);
   await pool.query("INSERT INTO shop_message_delivery_attempts(reminder_id,shop_id,channel,destination,provider,status,provider_reference) VALUES($1,$2,$3,$4,$5,'SENT',$6)",[row.id,row.shop_id,row.channel,destination,sent.provider,sent.reference]);
  }catch(e){
   const code=String(e.code||'DELIVERY_FAILED'),attempts=Number(row.attempt_count||0)+1;
   const retryable=/^(429|500|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(code);
   const retry=retryable&&attempts<5;
   await pool.query(`UPDATE shop_customer_reminders SET status=$2,processing_at=NULL,
     scheduled_at=CASE WHEN $2='PENDING' THEN NOW()+make_interval(mins=>LEAST(60,5*$3)) ELSE scheduled_at END
     WHERE id=$1`,[row.id,retry?'PENDING':'FAILED',attempts]);
   await pool.query("INSERT INTO shop_message_delivery_attempts(reminder_id,shop_id,channel,destination,provider,status,error_code) VALUES($1,$2,$3,$4,$5,'FAILED',$6)",[row.id,row.shop_id,row.channel,destination,row.channel==='EMAIL'?'RESEND':row.channel==='SMS'?'TWILIO':'META',String(e.code||'DELIVERY_FAILED').slice(0,80)]);
   console.error('Reminder delivery failed',row.id,e.message);
  }
 }
 console.log('Processed reminder records:',rows.length);
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
