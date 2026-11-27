'use strict';
const express=require('express');
const {createAuthMiddleware}=require('../auth/middleware');
const {deliver}=require('../messaging/delivery');
function createWhatsAppAutomationRouter(pool,tokens,options={}){
 const env=options.env||process.env,fetchImpl=options.fetchImpl||global.fetch;
 const r=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokens),admin=[authenticate,requireRole('ADMIN')];
 const wrap=fn=>(q,s,n)=>Promise.resolve(fn(q,s)).catch(n);
 const id=v=>/^[1-9]\d*$/.test(String(v))?Number(v):null;
 async function ensureShop(shop,res){if(!shop){res.status(400).json({error:'Invalid shop id.'});return false;}const x=await pool.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE',[shop]);if(!x.rowCount){res.status(404).json({error:'Active shop not found.'});return false;}return true;}
 r.get('/admin/shops/:shopId/whatsapp-automation',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId);if(!await ensureShop(shop,s))return;
  const [settings,counts]=await Promise.all([
   pool.query(`SELECT whatsapp_phone_number_id,whatsapp_business_account_id,enabled_channels,whatsapp_ai_enabled,whatsapp_ai_locale,whatsapp_ai_greeting,whatsapp_handoff_keywords,updated_at FROM shop_messaging_settings WHERE shop_id=$1`,[shop]),
   pool.query(`SELECT (SELECT COUNT(*)::int FROM shop_whatsapp_conversations WHERE shop_id=$1 AND status='HUMAN') waiting_human,(SELECT COUNT(*)::int FROM shop_whatsapp_leads WHERE shop_id=$1 AND status='NEW') new_leads,(SELECT COUNT(*)::int FROM shop_whatsapp_conversations WHERE shop_id=$1) conversations`,[shop])
  ]);
  s.json({settings:settings.rows[0]||{enabled_channels:[],whatsapp_ai_enabled:false,whatsapp_ai_locale:'en',whatsapp_handoff_keywords:['HUMAN','AGENT','PERSON','CALL ME']},...counts.rows[0]});
 }));
 r.put('/admin/shops/:shopId/whatsapp-automation',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),b=q.body||{};
  if(!await ensureShop(shop,s))return;
  if(typeof b.aiEnabled!=='boolean'||!['en','hi','mr'].includes(b.locale||'en')||(b.greeting!==undefined&&(typeof b.greeting!=='string'||b.greeting.length>500))||!Array.isArray(b.handoffKeywords)||b.handoffKeywords.length>12||b.handoffKeywords.some(x=>typeof x!=='string'||!x.trim()||x.length>40))return s.status(400).json({error:'Provide AI enabled, supported locale, a greeting up to 500 characters and up to 12 handoff keywords.'});
  const out=await pool.query(`INSERT INTO shop_messaging_settings(shop_id,whatsapp_provider,enabled_channels,whatsapp_ai_enabled,whatsapp_ai_locale,whatsapp_ai_greeting,whatsapp_handoff_keywords,updated_by,updated_at)
   VALUES($1,'META',ARRAY['IN_APP']::text[],$2,$3,$4,$5,$6,NOW())
   ON CONFLICT(shop_id) DO UPDATE SET whatsapp_ai_enabled=EXCLUDED.whatsapp_ai_enabled,whatsapp_ai_locale=EXCLUDED.whatsapp_ai_locale,whatsapp_ai_greeting=EXCLUDED.whatsapp_ai_greeting,whatsapp_handoff_keywords=EXCLUDED.whatsapp_handoff_keywords,updated_by=EXCLUDED.updated_by,updated_at=NOW()
   RETURNING whatsapp_ai_enabled,whatsapp_ai_locale,whatsapp_ai_greeting,whatsapp_handoff_keywords`,
   [shop,b.aiEnabled,b.locale||'en',b.greeting?.trim()||null,b.handoffKeywords.map(x=>x.trim().toUpperCase()),q.user.id]);
  s.json({settings:out.rows[0]});
 }));
 r.get('/admin/shops/:shopId/whatsapp-inbox',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId);if(!await ensureShop(shop,s))return;
  const status=['AI','HUMAN','RESOLVED'].includes(q.query.status)?q.query.status:null;
  const rows=await pool.query(`SELECT c.id,c.sender,c.status,c.locale,c.last_message_at,u.name customer_name,
   (SELECT body FROM shop_whatsapp_conversation_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_message
   FROM shop_whatsapp_conversations c LEFT JOIN users u ON u.id=c.customer_id WHERE c.shop_id=$1 AND ($2::text IS NULL OR c.status=$2)
   ORDER BY c.last_message_at DESC LIMIT 100`,[shop,status]);
  s.json({conversations:rows.rows});
 }));
 r.get('/admin/shops/:shopId/whatsapp-inbox/:conversationId',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),conversation=id(q.params.conversationId);if(!await ensureShop(shop,s))return;
  const thread=await pool.query('SELECT id,sender,status,locale,customer_id,last_message_at FROM shop_whatsapp_conversations WHERE id=$1 AND shop_id=$2',[conversation,shop]);
  if(!thread.rowCount)return s.status(404).json({error:'Conversation not found.'});
  const messages=await pool.query('SELECT id,direction,body,ai_generated,delivery_status,created_at FROM shop_whatsapp_conversation_messages WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 300',[conversation]);
  s.json({conversation:thread.rows[0],messages:messages.rows});
 }));
 r.post('/admin/shops/:shopId/whatsapp-inbox/:conversationId/reply',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),conversation=id(q.params.conversationId),body=typeof q.body?.body==='string'?q.body.body.trim():'';
  if(!await ensureShop(shop,s))return;
  if(!body||body.length>1000)return s.status(400).json({error:'Reply must contain 1–1000 characters.'});
  const thread=await pool.query(`SELECT c.id,c.sender,c.status,m.whatsapp_phone_number_id,m.enabled_channels FROM shop_whatsapp_conversations c JOIN shop_messaging_settings m ON m.shop_id=c.shop_id WHERE c.id=$1 AND c.shop_id=$2`,[conversation,shop]);
  if(!thread.rowCount)return s.status(404).json({error:'Conversation not found.'});
  if(thread.rows[0].status!=='HUMAN')return s.status(409).json({error:'Take over the conversation before sending a human reply.'});
  if(!thread.rows[0].whatsapp_phone_number_id||!thread.rows[0].enabled_channels.includes('WHATSAPP'))return s.status(409).json({error:'WhatsApp is not connected or enabled for this shop.'});
  try{
   const sent=await deliver('WHATSAPP',thread.rows[0].sender,{body},env,fetchImpl,{provider:'META',phoneNumberId:thread.rows[0].whatsapp_phone_number_id,allowFreeform:true});
   const saved=await pool.query(`INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body,ai_generated,provider_message_id,delivery_status)
    VALUES($1,'OUTBOUND',$2,FALSE,$3,'SENT') RETURNING id,created_at`,[conversation,body,sent?.reference||null]);
   await pool.query(`UPDATE shop_whatsapp_conversations SET last_message_at=NOW(),updated_at=NOW(),expires_at=NOW()+INTERVAL '180 days' WHERE id=$1`,[conversation]);
   return s.status(201).json({message:{id:saved.rows[0].id,body,created_at:saved.rows[0].created_at,delivery_status:'SENT'}});
  }catch(error){
   await pool.query(`INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body,ai_generated,delivery_status)
    VALUES($1,'OUTBOUND',$2,FALSE,'FAILED')`,[conversation,body]);
   return s.status(502).json({error:'WhatsApp could not deliver this reply. Check the 24-hour messaging window and Meta configuration.'});
  }
 }));
 r.patch('/admin/shops/:shopId/whatsapp-inbox/:conversationId',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),conversation=id(q.params.conversationId),status=q.body?.status;
  if(!await ensureShop(shop,s))return;
  if(!['AI','HUMAN','RESOLVED'].includes(status))return s.status(400).json({error:'Status must be AI, HUMAN or RESOLVED.'});
  const out=await pool.query(`UPDATE shop_whatsapp_conversations SET status=$3,assigned_to=CASE WHEN $3='HUMAN' THEN $4 ELSE assigned_to END,updated_at=NOW(),expires_at=NOW()+INTERVAL '180 days' WHERE id=$1 AND shop_id=$2 RETURNING id,status,assigned_to`,[conversation,shop,status,q.user.id]);
  if(!out.rowCount)return s.status(404).json({error:'Conversation not found.'});
  s.json({conversation:out.rows[0]});
 }));
 r.get('/admin/shops/:shopId/whatsapp-leads',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId);if(!await ensureShop(shop,s))return;
  const rows=await pool.query('SELECT id,sender,customer_name,interest,status,created_at,updated_at FROM shop_whatsapp_leads WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 200',[shop]);
  s.json({leads:rows.rows});
 }));
 r.patch('/admin/shops/:shopId/whatsapp-leads/:leadId',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),lead=id(q.params.leadId),status=q.body?.status;
  if(!await ensureShop(shop,s))return;
  if(!['NEW','CONTACTED','CONVERTED','CLOSED'].includes(status))return s.status(400).json({error:'Invalid lead status.'});
  const out=await pool.query('UPDATE shop_whatsapp_leads SET status=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 RETURNING id,status',[lead,shop,status]);
  if(!out.rowCount)return s.status(404).json({error:'Lead not found.'});
  s.json({lead:out.rows[0]});
 }));
 return r;
}
module.exports={createWhatsAppAutomationRouter};
