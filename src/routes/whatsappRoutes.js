'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {deliver}=require('../messaging/delivery');
const {scheduleAppointmentReminders}=require('../messaging/reminders');
const {offerWaitlistEntry}=require('./retentionRoutes');
const {processWhatsAppAssistant}=require('../messaging/whatsapp-assistant');
function createWhatsAppRouter(pool,options={}){
 const r=express.Router(),env=options.env||process.env,fetchImpl=options.fetchImpl||global.fetch;
 r.get('/webhooks/whatsapp',(q,s)=>{const mode=q.query['hub.mode'],token=q.query['hub.verify_token'],challenge=q.query['hub.challenge'];if(mode==='subscribe'&&token&&token===env.META_WHATSAPP_VERIFY_TOKEN)return s.status(200).send(challenge);return s.sendStatus(403)});
 r.post('/webhooks/whatsapp',async(q,s,n)=>{try{
  if(!env.META_APP_SECRET)return s.status(503).json({error:'WhatsApp webhook signature verification is not configured.'});
  const signature=q.get('x-hub-signature-256')||'';const expected='sha256='+crypto.createHmac('sha256',env.META_APP_SECRET).update(q.rawBody||Buffer.alloc(0)).digest('hex');
  const a=Buffer.from(signature),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return s.sendStatus(401);
  const entries=q.body?.entry||[];for(const entry of entries)for(const change of entry.changes||[]){const value=change.value||{},phoneId=value.metadata?.phone_number_id;for(const msg of value.messages||[]){
   const messageId=msg.id;if(!messageId||!msg.from||!['text','interactive'].includes(msg.type))continue;
   const saved=await pool.query('INSERT INTO shop_whatsapp_inbound_messages(provider_message_id,sender,phone_number_id,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(provider_message_id) DO NOTHING RETURNING id',[messageId,msg.from,phoneId,JSON.stringify(msg)]);
   if(!saved.rowCount)continue;
   const shop=await pool.query('SELECT s.id,s.name,m.whatsapp_phone_number_id FROM shops s JOIN shop_messaging_settings m ON m.shop_id=s.id WHERE m.whatsapp_phone_number_id=$1 AND s.is_active=TRUE',[phoneId]);
   if(!shop.rowCount)continue;const shopId=shop.rows[0].id;let body=String(msg.text?.body||'').trim();if(msg.type==='interactive'){const reply=msg.interactive?.button_reply?.id||msg.interactive?.list_reply?.id||'';const match=String(reply).match(/^(confirm|cancel)[_:-](\\d+)$/i);if(match)body=match[1].toUpperCase()+' '+match[2];}
   const user=await pool.query("SELECT id FROM users WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$1 AND role='CUSTOMER' AND is_active=TRUE AND phone_verified_at IS NOT NULL LIMIT 1",[msg.from.replace(/\D/g,'')]);
   let reply='Welcome to '+shop.rows[0].name+'! Reply SERVICES to see services and prices. To request a booking, reply BOOK <service-id> <staff-id> <YYYY-MM-DDTHH:MM:SS+05:30>.';
   const command=body.match(/^(CONFIRM|CANCEL)\\s+(\\d+)$/i);
   if(command){
    if(!user.rowCount)reply='Please sign in to your BarberPro account and verify this WhatsApp number before confirming or cancelling.';
    else if(command[1].toUpperCase()==='CONFIRM'){
     const updated=await pool.query(`UPDATE appointments SET status='CONFIRMED',updated_at=NOW()
      WHERE id=$1 AND shop_id=$2 AND customer_id=$3 AND status='BOOKED' AND starts_at>NOW() AND deposit_paid_paise>=deposit_due_paise RETURNING id,starts_at`,[Number(command[2]),shopId,user.rows[0].id]);
     reply=updated.rowCount?'Booking #'+updated.rows[0].id+' is confirmed. See you soon!':'That booking could not be confirmed. Please check the booking in the app or contact the shop.';
    }else{
     const updated=await pool.query(`UPDATE appointments SET status='CANCELLED',updated_at=NOW()
      WHERE id=$1 AND shop_id=$2 AND customer_id=$3 AND status IN('BOOKED','CONFIRMED') AND starts_at>=NOW()+make_interval(hours=>COALESCE((SELECT cancellation_notice_hours FROM shop_booking_policies WHERE shop_id=appointments.shop_id),24)) RETURNING id`,[Number(command[2]),shopId,user.rows[0].id]);
     if(updated.rowCount){await pool.query("UPDATE shop_customer_reminders SET status='CANCELLED',processing_at=NULL WHERE appointment_id=$1 AND status IN('PENDING','PROCESSING')",[Number(command[2])]);try{await offerWaitlistEntry(pool,shopId,null,Number(command[2]));}catch(e){console.error('WhatsApp cancellation waitlist offer failed',e.message)}reply='Booking #'+command[2]+' has been cancelled. Thank you for letting us know.';}
     else reply='That booking could not be cancelled. Please check the booking in the app or contact the shop.';
    }
   }
   else if(/^(ACCEPT|DECLINE)\\s+\\d+$/i.test(body)){
    const m=body.match(/^(ACCEPT|DECLINE)\\s+(\\d+)$/i);
    if(!user.rowCount)reply='Please sign in and verify this WhatsApp number before responding to a waitlist offer.';
    else if(m[1].toUpperCase()==='DECLINE'){
     const declined=await pool.query(`UPDATE shop_waitlist_entries SET status='CANCELLED',updated_at=NOW()
      WHERE id=$1 AND shop_id=$2 AND customer_id=$3 AND status='OFFERED' RETURNING offered_from_appointment_id`,
      [Number(m[2]),shopId,user.rows[0].id]);
     if(declined.rowCount){if(declined.rows[0].offered_from_appointment_id)try{await offerWaitlistEntry(pool,shopId,null,declined.rows[0].offered_from_appointment_id)}catch(e){console.error('WhatsApp waitlist decline refill failed',e.message)}reply='Thanks. We have released the offered slot to the next person on the waitlist.';}
     else reply='That waitlist offer is no longer active.';
    }else{
     const client=await pool.connect();try{
      await client.query('BEGIN');
      const w=await client.query(`SELECT * FROM shop_waitlist_entries WHERE id=$1 AND shop_id=$2 AND customer_id=$3 AND status='OFFERED' AND offer_expires_at>NOW() FOR UPDATE`,
       [Number(m[2]),shopId,user.rows[0].id]);
      if(!w.rowCount){await client.query('ROLLBACK');reply='That waitlist offer has expired or is no longer available.';}
      else{
       const v=w.rows[0];
       const created=await client.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,deposit_due_paise)
        SELECT $1,$2,$3,$4,$5,$6,'BOOKED',CASE WHEN COALESCE(bp.deposit_enabled,FALSE) THEN LEAST(ROUND(sv.price*100)::bigint,CASE WHEN bp.deposit_type='PERCENT' THEN ROUND(sv.price*100*bp.deposit_value/10000)::bigint ELSE bp.deposit_value END) ELSE 0 END
        FROM services sv LEFT JOIN shop_booking_policies bp ON bp.shop_id=$1
        WHERE sv.id=$3 AND sv.shop_id=$1 AND $5>NOW()
        AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=$2 AND a.status IN('BOOKED','CONFIRMED','IN_PROGRESS') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange($5,$6,'[)'))
        RETURNING id,shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status,deposit_due_paise`,
        [v.shop_id,v.offered_staff_id,v.service_id,user.rows[0].id,v.offered_starts_at,v.offered_ends_at]);
       if(!created.rowCount){await client.query("UPDATE shop_waitlist_entries SET status='EXPIRED',updated_at=NOW() WHERE id=$1",[v.id]);await client.query('COMMIT');if(v.offered_from_appointment_id)try{await offerWaitlistEntry(pool,shopId,null,v.offered_from_appointment_id)}catch(e){console.error('WhatsApp waitlist auto-refill after conflict failed',e.message)}reply='That slot was just taken. Please rejoin the waitlist.';}
       else{await client.query("UPDATE shop_waitlist_entries SET status='BOOKED',accepted_appointment_id=$2,updated_at=NOW() WHERE id=$1",[v.id,created.rows[0].id]);await scheduleAppointmentReminders(client,created.rows[0],{transactional:true});await client.query('COMMIT');reply=created.rows[0].deposit_due_paise>0?'Your waitlist slot is booked. Please complete the required deposit in the BarberPro app before the shop confirms it.':'Your waitlist slot is booked. See you soon!';}
      }
     }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
   }
   else if(/^RATE\\s+[1-5]\\s+\\d+/i.test(body)){
    const m=body.match(/^RATE\\s+([1-5])\\s+(\\d+)(?:\\s+([\\s\\S]{1,1000}))?$/i);
    if(!m||!user.rowCount)reply='Please sign in and verify this WhatsApp number before leaving feedback.';
    else{
     const feedback=await pool.query(`INSERT INTO shop_customer_feedback(shop_id,customer_id,appointment_id,rating,comment)
      SELECT a.shop_id,a.customer_id,a.id,$4,$5 FROM appointments a
      WHERE a.id=$1 AND a.shop_id=$2 AND a.customer_id=$3 AND a.status='COMPLETED'
      ON CONFLICT(appointment_id,customer_id) DO NOTHING RETURNING id,rating`,
      [Number(m[2]),shopId,user.rows[0].id,Number(m[1]),m[3]||null]);
     if(!feedback.rowCount)reply='We could not match that completed visit or feedback was already received. Please contact the shop if you need help.';
     else if(Number(m[1])>=4){const link=await pool.query('SELECT google_review_url FROM shop_booking_policies WHERE shop_id=$1',[shopId]);reply=link.rows[0]?.google_review_url?'Thank you for the great rating! If you have a moment, please share it on Google: '+link.rows[0].google_review_url:'Thank you for your feedback!';}
     else reply='Thank you for your honest feedback. Your rating has been shared privately with the shop so the team can improve.';
    }
   }
   else if(/^services$/i.test(body)){const services=await pool.query('SELECT id,name,price,duration_minutes FROM services WHERE shop_id=$1 AND is_active=TRUE ORDER BY name LIMIT 20',[shopId]);const barbers=await pool.query('SELECT id,display_name FROM shop_staff WHERE shop_id=$1 AND is_active=TRUE ORDER BY display_name',[shopId]);reply='Available services:\n'+services.rows.map(x=>x.id+'. '+x.name+' — ₹'+Number(x.price).toFixed(2)+' ('+x.duration_minutes+' min)').join('\n')+'\nBarbers:\n'+barbers.rows.map(x=>x.id+'. '+x.display_name).join('\n')+'\nSend SLOTS <service-id> <YYYY-MM-DD> to find live times.'}
   else if(/^slots\s+/i.test(body)){const m=body.match(/^slots\s+(\d+)\s+(\d{4}-\d{2}-\d{2})$/i);if(!m)reply='Use SLOTS <service-id> <YYYY-MM-DD>.';else{const slots=await pool.query("WITH ctx AS (SELECT sh.id shop_id,sh.timezone,sv.id service_id,sv.duration_minutes FROM shops sh JOIN services sv ON sv.shop_id=sh.id WHERE sh.id=$1 AND sv.id=$2 AND sv.is_active=TRUE),candidates AS (SELECT st.id staff_id,st.display_name,slot starts_at,slot+make_interval(mins=>c.duration_minutes) ends_at FROM ctx c JOIN shop_staff st ON st.shop_id=c.shop_id AND st.is_active=TRUE JOIN staff_working_hours wh ON wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM $3::date)::int AND wh.is_active=TRUE CROSS JOIN LATERAL generate_series((($3::date+wh.opens_at) AT TIME ZONE c.timezone),((($3::date+wh.closes_at)-make_interval(mins=>c.duration_minutes)) AT TIME ZONE c.timezone),INTERVAL '15 minutes') slot WHERE NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=c.service_id)) SELECT staff_id,display_name,starts_at FROM candidates x WHERE starts_at>NOW() AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.staff_id=x.staff_id AND a.status IN('BOOKED','CONFIRMED') AND tstzrange(a.starts_at,a.ends_at,'[)')&&tstzrange(x.starts_at,x.ends_at,'[)')) AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=x.staff_id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange(x.starts_at,x.ends_at,'[)')) ORDER BY starts_at LIMIT 30",[shopId,Number(m[1]),m[2]]);reply=slots.rowCount?'Available slots:\n'+slots.rows.map(x=>'Barber '+x.staff_id+' ('+x.display_name+'): '+x.starts_at.toISOString()).join('\n')+'\nUse BOOK <service-id> <staff-id> <ISO date/time>.':'No available slots on that date.'}}
   else if(/^book\s+/i.test(body)){
    const m=body.match(/^book\s+(\d+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}T[^\s]+)$/i);
    if(!m||!user.rowCount)reply='To request a booking, first sign in to your BarberPro customer account and add your phone number. Then send BOOK <service-id> <staff-id> <ISO date/time>.';
    else{const start=new Date(m[3]);if(Number.isNaN(start.getTime()))reply='Please send a valid ISO date/time including timezone.';else{const booked=await pool.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status) SELECT sh.id,st.id,sv.id,$4,$5,$5+make_interval(mins=>sv.duration_minutes),'BOOKED' FROM shops sh JOIN shop_staff st ON st.shop_id=sh.id JOIN services sv ON sv.shop_id=sh.id WHERE sh.id=$1 AND st.id=$2 AND st.is_active=TRUE AND sv.id=$3 AND sv.is_active=TRUE AND $5>NOW() AND EXTRACT(MINUTE FROM ($5 AT TIME ZONE sh.timezone))::int % 15=0 AND EXTRACT(SECOND FROM ($5 AT TIME ZONE sh.timezone))=0 AND (NOT EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id) OR EXISTS(SELECT 1 FROM staff_services ss WHERE ss.staff_id=st.id AND ss.service_id=sv.id)) AND EXISTS(SELECT 1 FROM staff_working_hours wh WHERE wh.staff_id=st.id AND wh.day_of_week=EXTRACT(DOW FROM ($5 AT TIME ZONE sh.timezone))::int AND wh.is_active=TRUE AND ($5 AT TIME ZONE sh.timezone)::time>=wh.opens_at AND (($5 AT TIME ZONE sh.timezone)::time+make_interval(mins=>sv.duration_minutes))<=wh.closes_at) AND NOT EXISTS(SELECT 1 FROM staff_time_off t WHERE t.staff_id=st.id AND tstzrange(t.starts_at,t.ends_at,'[)')&&tstzrange($5,$5+make_interval(mins=>sv.duration_minutes),'[)')) RETURNING id,starts_at`,[shopId,Number(m[2]),Number(m[1]),user.rows[0].id,start.toISOString()]);if(booked.rowCount)await scheduleAppointmentReminders(pool,{id:booked.rows[0].id,shop_id:shopId,customer_id:user.rows[0].id,starts_at:booked.rows[0].starts_at});reply=booked.rowCount?'Booking request #'+booked.rows[0].id+' created for '+booked.rows[0].starts_at+'. The shop will confirm it.':'That barber/service is unavailable. Reply SERVICES or book in the app.'}}
   }
   const assistant=await processWhatsAppAssistant(pool,{shopId,sender:msg.from,body,customerId:user.rows[0]?.id||null,env,fetchImpl});
   if(assistant?.suppressReply){await pool.query('UPDATE shop_whatsapp_inbound_messages SET processed_at=NOW() WHERE id=$1',[saved.rows[0].id]);continue;}
   if(assistant?.body)reply=assistant.body;
   const delivery=await deliver('WHATSAPP',msg.from,{body:reply},env,fetchImpl,{provider:'META',phoneNumberId:phoneId,allowFreeform:true});
   if(assistant?.outboundMessageId)await pool.query('UPDATE shop_whatsapp_conversation_messages SET delivery_status=$2,provider_message_id=$3 WHERE id=$1',[assistant.outboundMessageId,delivery?.reference?'SENT':'FAILED',delivery?.reference||null]);
   else if(assistant?.conversationId&&assistant.skipAI)await pool.query("INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body,ai_generated,provider_message_id,delivery_status) VALUES($1,'OUTBOUND',$2,FALSE,$3,'SENT')",[assistant.conversationId,reply,delivery?.reference||null]);
   await pool.query('UPDATE shop_whatsapp_inbound_messages SET processed_at=NOW() WHERE id=$1',[saved.rows[0].id]);
  }}
  s.sendStatus(200);
 }catch(e){n(e)}});
 return r;
}
module.exports={createWhatsAppRouter};
