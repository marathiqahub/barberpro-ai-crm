'use strict';
require('dotenv').config();
const {Pool}=require('pg');
const {deliver}=require('../src/messaging/delivery');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
async function run(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
 const client=await pool.connect();let rows=[];
 try{
  await client.query('BEGIN');
  await client.query("UPDATE shop_customer_reminders SET status='PENDING',processing_at=NULL WHERE status='PROCESSING' AND processing_at<NOW()-INTERVAL '10 minutes'");
  await client.query("UPDATE shop_waitlist_offers SET status='EXPIRED' WHERE status='OFFERED' AND expires_at<=NOW()");
  await client.query("UPDATE shop_waitlist_entries SET status='WAITING',updated_at=NOW() WHERE status='OFFERED' AND id IN (SELECT waitlist_entry_id FROM shop_waitlist_offers WHERE status='EXPIRED')");
  await client.query(`WITH visits AS (
    SELECT shop_id,customer_id,starts_at,LAG(starts_at) OVER(PARTITION BY shop_id,customer_id ORDER BY starts_at) previous_visit
    FROM appointments WHERE status='COMPLETED'
  ), stats AS (
    SELECT shop_id,customer_id,MAX(starts_at) last_visit,
      ROUND(AVG(EXTRACT(EPOCH FROM (starts_at-previous_visit))/86400) FILTER(WHERE previous_visit IS NOT NULL))::int interval_days
    FROM visits GROUP BY shop_id,customer_id
  )
  INSERT INTO shop_customer_rebooking_profiles(shop_id,customer_id,interval_days,last_visit_at,next_due_at,enabled,interval_source)
  SELECT shop_id,customer_id,GREATEST(7,LEAST(365,COALESCE(interval_days,21))),last_visit,
    last_visit+make_interval(days=>GREATEST(7,LEAST(365,COALESCE(interval_days,21)))),TRUE,'AUTO'
  FROM stats
  ON CONFLICT(shop_id,customer_id) DO UPDATE SET
    interval_days=CASE WHEN shop_customer_rebooking_profiles.interval_source='MANUAL' THEN shop_customer_rebooking_profiles.interval_days ELSE EXCLUDED.interval_days END,
    last_visit_at=EXCLUDED.last_visit_at,
    next_due_at=EXCLUDED.last_visit_at+make_interval(days=>CASE WHEN shop_customer_rebooking_profiles.interval_source='MANUAL' THEN shop_customer_rebooking_profiles.interval_days ELSE EXCLUDED.interval_days END),
    updated_at=NOW()`);
  await client.query(`WITH due AS (
    INSERT INTO shop_customer_reminders(shop_id,customer_id,channel,template_key,scheduled_at,related_entity_type)
    SELECT p.shop_id,p.customer_id,c.channel,'REBOOKING_DUE',NOW(),'REBOOKING'
    FROM shop_customer_rebooking_profiles p
    JOIN shop_message_consents c ON c.shop_id=p.shop_id AND c.customer_id=p.customer_id
    JOIN shop_messaging_settings m ON m.shop_id=p.shop_id AND c.channel=ANY(m.enabled_channels)
    JOIN shop_message_templates t ON t.shop_id=p.shop_id AND t.channel=c.channel AND t.template_key='REBOOKING_DUE' AND t.is_active=TRUE
    JOIN users u ON u.id=p.customer_id
    WHERE p.enabled=TRUE AND p.next_due_at<=NOW() AND (p.last_nudge_at IS NULL OR p.last_nudge_at<p.next_due_at)
      AND c.consent=TRUE AND c.revoked_at IS NULL
      AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN ('SMS','WHATSAPP') AND c.destination=u.phone))
      AND (c.channel<>'WHATSAPP' OR t.provider_template_status='APPROVED')
    ON CONFLICT DO NOTHING RETURNING shop_id,customer_id
  )
  UPDATE shop_customer_rebooking_profiles p SET last_nudge_at=NOW(),updated_at=NOW()
  FROM (SELECT DISTINCT shop_id,customer_id FROM due) d WHERE p.shop_id=d.shop_id AND p.customer_id=d.customer_id`);
  const result=await client.query(`SELECT r.*,u.email,u.phone,u.phone_verified_at,u.name AS customer_name,sh.name AS shop_name,t.subject,t.body,m.email_provider,m.whatsapp_provider,m.sender_email,m.sender_name,m.sms_from,m.whatsapp_phone_number_id,m.enabled_channels,t.provider_template_name,t.provider_template_language,t.provider_template_status
   FROM shop_customer_reminders r JOIN users u ON u.id=r.customer_id JOIN shops sh ON sh.id=r.shop_id
   JOIN shop_message_templates t ON t.shop_id=r.shop_id AND t.channel=r.channel AND t.template_key=r.template_key AND t.is_active=TRUE
   LEFT JOIN shop_messaging_settings m ON m.shop_id=r.shop_id
   WHERE r.status='PENDING' AND r.channel IN ('EMAIL','SMS','WHATSAPP') AND r.scheduled_at<=NOW()
   ORDER BY r.scheduled_at,r.id LIMIT 25 FOR UPDATE OF r SKIP LOCKED`);
  rows=result.rows;for(const row of rows)await client.query("UPDATE shop_customer_reminders SET status='PROCESSING',processing_at=NOW() WHERE id=$1",[row.id]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 for(const row of rows){
  let destination=row.channel==='EMAIL'?row.email:row.phone;
  try{
   if(!row.enabled_channels?.includes(row.channel))throw Object.assign(new Error('This channel is not enabled for the shop'),{code:'CHANNEL_DISABLED'});
   if(row.channel!=='EMAIL'&&!row.phone_verified_at)throw Object.assign(new Error('Customer phone number is not verified'),{code:'PHONE_NOT_VERIFIED'});
   if(!destination)throw Object.assign(new Error('Customer has no destination for this channel'),{code:'NO_DESTINATION'});
   {
    const consent=await pool.query(`SELECT 1 FROM shop_message_consents WHERE shop_id=$1 AND customer_id=$2 AND channel=$3 AND destination=$4 AND consent=TRUE AND revoked_at IS NULL`,[row.shop_id,row.customer_id,row.channel,destination]);
    if(!consent.rowCount)throw Object.assign(new Error('No active consent for this channel'),{code:'CONSENT_REQUIRED'});
   }
   const body=String(row.body).replace(/\{\{shop_name\}\}/g,row.shop_name).replace(/\{\{customer_name\}\}/g,row.customer_name);
   const sent=await deliver(row.channel,destination,{subject:row.subject,body},process.env,global.fetch,{provider:row.whatsapp_provider,phoneNumberId:row.whatsapp_phone_number_id,from:row.channel==='SMS'?row.sms_from:row.channel==='EMAIL'?row.sender_email:null,templateName:row.provider_template_name});
   await pool.query("UPDATE shop_customer_reminders SET status='SENT',sent_at=NOW(),processing_at=NULL,provider_reference=$2 WHERE id=$1",[row.id,sent.reference]);
   await pool.query("INSERT INTO shop_message_delivery_attempts(reminder_id,shop_id,channel,destination,provider,status,provider_reference) VALUES($1,$2,$3,$4,$5,'SENT',$6)",[row.id,row.shop_id,row.channel,destination,sent.provider,sent.reference]);
  }catch(e){
   await pool.query("UPDATE shop_customer_reminders SET status='FAILED',processing_at=NULL WHERE id=$1",[row.id]);
   await pool.query("INSERT INTO shop_message_delivery_attempts(reminder_id,shop_id,channel,destination,provider,status,error_code) VALUES($1,$2,$3,$4,$5,'FAILED',$6)",[row.id,row.shop_id,row.channel,destination,row.channel==='EMAIL'?'RESEND':row.channel==='SMS'?'TWILIO':'META',String(e.code||'DELIVERY_FAILED').slice(0,80)]);
   console.error('Reminder delivery failed',row.id,e.message);
  }
 }
 console.log('Processed reminder records:',rows.length);
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
