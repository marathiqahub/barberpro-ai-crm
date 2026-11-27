'use strict';

const COMMAND_RE=/^(?:SERVICES|SLOTS\s+\d+\s+\d{4}-\d{2}-\d{2}|BOOK\s+\d+\s+\d+\s+\S+|CONFIRM\s+\d+|CANCEL\s+\d+|ACCEPT\s+\d+|DECLINE\s+\d+|RATE\s+[1-5]\s+\d+)(?:\s|$)/i;
const HANDOFF_RE=/\b(?:human|agent|person|call me|talk to (?:someone|staff)|speak to (?:someone|staff))\b/i;
function safeText(value,max=500){return typeof value==='string'?value.trim().slice(0,max):'';}
async function processWhatsAppAssistant(pool,{shopId,sender,body,customerId=null,env=process.env,fetchImpl=global.fetch}){
 const text=safeText(body,500);if(!text)return null;
 const config=await pool.query(`SELECT m.whatsapp_ai_enabled,m.whatsapp_ai_locale,m.whatsapp_ai_greeting,m.whatsapp_handoff_keywords,s.name
  FROM shop_messaging_settings m JOIN shops s ON s.id=m.shop_id
  WHERE m.shop_id=$1 AND s.is_active=TRUE AND 'WHATSAPP'=ANY(m.enabled_channels)`,[shopId]);
 if(!config.rowCount||!config.rows[0].whatsapp_ai_enabled)return null;
 const settings=config.rows[0],conversation=await pool.query(`INSERT INTO shop_whatsapp_conversations(shop_id,sender,customer_id,locale)
  VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,sender) DO UPDATE SET customer_id=COALESCE(EXCLUDED.customer_id,shop_whatsapp_conversations.customer_id),last_message_at=NOW(),updated_at=NOW(),expires_at=NOW()+INTERVAL '180 days'
  RETURNING id,status,locale`,[shopId,sender,customerId,settings.whatsapp_ai_locale||'en']);
 const thread=conversation.rows[0],convId=thread.id;
 await pool.query(`INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body)
  VALUES($1,'INBOUND',$2)`,[convId,text]);
 if(!customerId)await pool.query(`INSERT INTO shop_whatsapp_leads(shop_id,conversation_id,sender,interest)
  VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,sender) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,interest=LEFT(COALESCE(shop_whatsapp_leads.interest,'')||' '||EXCLUDED.interest,500),updated_at=NOW()`,[shopId,convId,sender,text]);
 if(thread.status==='HUMAN')return {conversationId:convId,suppressReply:true};
 if(COMMAND_RE.test(text))return {conversationId:convId,skipAI:true};
 const configured=(settings.whatsapp_handoff_keywords||[]).some(k=>String(k).trim()&&text.toLowerCase().includes(String(k).toLowerCase()));
 if(HANDOFF_RE.test(text)||configured){
  await pool.query(`UPDATE shop_whatsapp_conversations SET status='HUMAN',last_message_at=NOW(),updated_at=NOW() WHERE id=$1`,[convId]);
  await pool.query(`INSERT INTO shop_whatsapp_leads(shop_id,conversation_id,sender,interest)
   VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,sender) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,interest=EXCLUDED.interest,updated_at=NOW()`,
   [shopId,convId,sender,text]);
  const reply='I have passed your message to the shop team. A team member will reply here as soon as possible.';
  const savedReply=await pool.query(`INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body,ai_generated)
   VALUES($1,'OUTBOUND',$2,FALSE) RETURNING id`,[convId,reply]);
  return {body:reply,conversationId:convId,outboundMessageId:savedReply.rows[0].id,handedOff:true};
 }
 if(thread.status==='RESOLVED'){
  await pool.query(`UPDATE shop_whatsapp_conversations SET status='AI' WHERE id=$1`,[convId]);
 }
 const [history,services,staff,policy]=await Promise.all([
  pool.query(`SELECT direction,body FROM shop_whatsapp_conversation_messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 9`,[convId]),
  pool.query(`SELECT name,price,duration_minutes FROM services WHERE shop_id=$1 AND is_active=TRUE ORDER BY name LIMIT 30`,[shopId]),
  pool.query(`SELECT display_name FROM shop_staff WHERE shop_id=$1 AND is_active=TRUE ORDER BY display_name LIMIT 20`,[shopId]),
  pool.query(`SELECT policy_text,cancellation_notice_hours,deposit_enabled,google_review_url FROM shop_booking_policies WHERE shop_id=$1`,[shopId])
 ]);
 const historyMessages=history.rows.reverse().slice(0,-1).map(x=>({role:x.direction==='INBOUND'?'user':'assistant',content:x.body}));
 const context={shop:settings.name,services:services.rows.map(x=>({name:x.name,price_inr:Number(x.price),duration_minutes:x.duration_minutes})),barbers:staff.rows.map(x=>x.display_name),bookingPolicy:policy.rows[0]||{}};
 let reply;
 if(!env.OPENAI_API_KEY){
  reply=(settings.whatsapp_ai_greeting||('Hello! Welcome to '+settings.name+'. I can help with services, prices and bookings. Reply SERVICES to see services, then SLOTS <service-id> <YYYY-MM-DD> to check availability.')).slice(0,1000);
 }else{
  try{
   const base=(env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/+$/,'');
   const response=await fetchImpl(base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({
    model:env.OPENAI_MODEL||'gpt-4o-mini',temperature:0.2,max_tokens:220,
    messages:[
     {role:'system',content:'You are the WhatsApp receptionist for the named BarberPro shop. Answer briefly and warmly in the configured default language ('+settings.whatsapp_ai_locale+'), or the customer's language when clear (English, Hindi or Marathi). Use only the supplied shop facts; never invent prices, opening hours, staff availability, booking confirmation, discounts or policies. Do not claim a booking is made. For booking, guide the customer to reply SERVICES, then SLOTS with the service ID and date; the customer can complete a booking using the displayed live slot details. Never ask for passwords, OTPs, card details or sensitive personal information. If asked for something outside the supplied facts, offer human handoff. Keep the reply under 500 characters.'},
     {role:'system',content:'Verified shop facts: '+JSON.stringify(context)},
     ...historyMessages,
     {role:'user',content:text}
    ]
   })});
   if(!response.ok)throw new Error('AI provider unavailable');
   const payload=await response.json();reply=safeText(payload.choices?.[0]?.message?.content,1000);
   if(!reply)throw new Error('AI response empty');
  }catch(error){
   reply='I can help with services and bookings. Reply SERVICES to see the current service list, or type HUMAN to speak with the shop team.';
  }
 }
 const savedReply=await pool.query(`INSERT INTO shop_whatsapp_conversation_messages(conversation_id,direction,body,ai_generated)
  VALUES($1,'OUTBOUND',$2,TRUE) RETURNING id`,[convId,reply]);
 await pool.query(`UPDATE shop_whatsapp_conversations SET last_message_at=NOW(),updated_at=NOW(),expires_at=NOW()+INTERVAL '180 days' WHERE id=$1`,[convId]);
 return {body:reply,conversationId:convId,outboundMessageId:savedReply.rows[0].id,handedOff:false};
}
module.exports={processWhatsAppAssistant,COMMAND_RE};
