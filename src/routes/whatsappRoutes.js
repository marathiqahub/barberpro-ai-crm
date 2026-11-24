'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {deliver}=require('../messaging/delivery');
function createWhatsAppRouter(pool,options={}){
 const r=express.Router(),env=options.env||process.env,fetchImpl=options.fetchImpl||global.fetch;
 r.get('/webhooks/whatsapp',(q,s)=>{const mode=q.query['hub.mode'],token=q.query['hub.verify_token'],challenge=q.query['hub.challenge'];if(mode==='subscribe'&&token&&token===env.META_WHATSAPP_VERIFY_TOKEN)return s.status(200).send(challenge);return s.sendStatus(403)});
 r.post('/webhooks/whatsapp',async(q,s,n)=>{try{
  if(!env.META_APP_SECRET)return s.status(503).json({error:'WhatsApp webhook signature verification is not configured.'});
  const signature=q.get('x-hub-signature-256')||'';const expected='sha256='+crypto.createHmac('sha256',env.META_APP_SECRET).update(q.rawBody||Buffer.alloc(0)).digest('hex');
  const a=Buffer.from(signature),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return s.sendStatus(401);
  const entries=q.body?.entry||[];for(const entry of entries)for(const change of entry.changes||[]){const value=change.value||{},phoneId=value.metadata?.phone_number_id;for(const msg of value.messages||[]){
   const messageId=msg.id;if(!messageId||!msg.from||msg.type!=='text')continue;
   const saved=await pool.query('INSERT INTO shop_whatsapp_inbound_messages(provider_message_id,sender,phone_number_id,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(provider_message_id) DO NOTHING RETURNING id',[messageId,msg.from,phoneId,JSON.stringify(msg)]);
   if(!saved.rowCount)continue;
   const shop=await pool.query('SELECT s.id,s.name,m.whatsapp_phone_number_id FROM shops s JOIN shop_messaging_settings m ON m.shop_id=s.id WHERE m.whatsapp_phone_number_id=$1 AND s.is_active=TRUE',[phoneId]);
   if(!shop.rowCount)continue;const shopId=shop.rows[0].id,body=String(msg.text.body||'').trim();
   const user=await pool.query("SELECT id FROM users WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$1 AND role='CUSTOMER' AND is_active=TRUE LIMIT 1",[msg.from.replace(/\\D/g,'')]);
   let reply='Welcome to '+shop.rows[0].name+'! Reply SERVICES to see services and prices. To request a booking, reply BOOK <service-id> <staff-id> <YYYY-MM-DDTHH:MM:SS+05:30>.';
   if(/^services$/i.test(body)){const services=await pool.query('SELECT id,name,price,duration_minutes FROM services WHERE shop_id=$1 AND is_active=TRUE ORDER BY name LIMIT 20',[shopId]);reply='Available services:\\n'+services.rows.map(x=>x.id+'. '+x.name+' — ₹'+Number(x.price).toFixed(2)+' ('+x.duration_minutes+' min)').join('\\n')+'\\nFor a booking request use BOOK <service-id> <staff-id> <ISO date/time>. Sign in to BarberPro to view live availability.'}
   else if(/^book\\s+/i.test(body)){
    const m=body.match(/^book\\s+(\\d+)\\s+(\\d+)\\s+(\\d{4}-\\d{2}-\\d{2}T[^\\s]+)$/i);
    if(!m||!user.rowCount)reply='To request a booking, first sign in to your BarberPro customer account and add your phone number. Then send BOOK <service-id> <staff-id> <ISO date/time>.';
    else{const start=new Date(m[3]);if(Number.isNaN(start.getTime()))reply='Please send a valid ISO date/time including timezone.';else{const booked=await pool.query(`INSERT INTO appointments(shop_id,staff_id,service_id,customer_id,starts_at,ends_at,status) SELECT sh.id,st.id,sv.id,$4,$5,$5+make_interval(mins=>sv.duration_minutes),'BOOKED' FROM shops sh JOIN shop_staff st ON st.shop_id=sh.id JOIN services sv ON sv.shop_id=sh.id WHERE sh.id=$1 AND st.id=$2 AND st.is_active=TRUE AND sv.id=$3 AND sv.is_active=TRUE AND $5>NOW() RETURNING id,starts_at`,[shopId,Number(m[2]),Number(m[1]),user.rows[0].id,start.toISOString()]);reply=booked.rowCount?'Booking request #'+booked.rows[0].id+' created for '+booked.rows[0].starts_at+'. The shop will confirm it.':'That barber/service is unavailable. Reply SERVICES or book in the app.'}}
   }
   await deliver('WHATSAPP',msg.from,{body:reply},env,fetchImpl,{provider:'META',phoneNumberId:phoneId});
   await pool.query('UPDATE shop_whatsapp_inbound_messages SET processed_at=NOW() WHERE id=$1',[saved.rows[0].id]);
  }}
  s.sendStatus(200);
 }catch(e){n(e)}});
 return r;
}
module.exports={createWhatsAppRouter};
