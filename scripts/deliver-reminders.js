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
  const result=await client.query(`SELECT r.*,u.email,u.phone,u.phone_verified_at,u.name AS customer_name,sh.name AS shop_name,t.subject,t.body,m.email_provider,m.whatsapp_provider,m.sender_email,m.sender_name,m.sms_from,m.whatsapp_phone_number_id,m.enabled_channels,t.provider_template_name
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
   if(row.channel!=='EMAIL'&&!row.phone_verified_at)throw Object.assign(new Error('Customer phone number is not verified'),{code:'PHONE_NOT_VERIFIED'});\n   if(!destination)throw Object.assign(new Error('Customer has no destination for this channel'),{code:'NO_DESTINATION'});
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
