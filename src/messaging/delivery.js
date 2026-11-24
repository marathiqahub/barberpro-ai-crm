'use strict';
async function deliver(channel,destination,content,env=process.env,fetchImpl=global.fetch,meta={}){
 if(channel==='EMAIL'){
  if(!env.RESEND_API_KEY)throw Object.assign(new Error('RESEND_API_KEY is not configured'),{code:'PROVIDER_NOT_CONFIGURED'});
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:meta.from||env.MAIL_FROM,to:[destination],subject:content.subject||'BarberPro appointment reminder',html:content.body})});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.message||'Email provider rejected the message'),{code:String(response.status)});return {provider:'RESEND',reference:data.id||null};
 }
 if(channel==='SMS'||channel==='WHATSAPP'&&meta.provider==='TWILIO'){
  if(!env.TWILIO_ACCOUNT_SID||!env.TWILIO_AUTH_TOKEN)throw Object.assign(new Error('Twilio credentials are not configured'),{code:'PROVIDER_NOT_CONFIGURED'});
  const from=channel==='SMS'?env.TWILIO_SMS_FROM:env.TWILIO_WHATSAPP_FROM;
  if(!from)throw Object.assign(new Error('Twilio sender is not configured'),{code:'SENDER_NOT_CONFIGURED'});
  const form=new URLSearchParams({To:(channel==='WHATSAPP'?'whatsapp:':'')+destination,From:from,Body:content.body});
  const response=await fetchImpl('https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.TWILIO_ACCOUNT_SID+':'+env.TWILIO_AUTH_TOKEN).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:form});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.message||'Twilio rejected the message'),{code:String(response.status)});return {provider:'TWILIO',reference:data.sid||null};
 }
 if(channel==='WHATSAPP'){
  if(!env.META_WHATSAPP_TOKEN||!meta.phoneNumberId)throw Object.assign(new Error('Meta WhatsApp credentials are not configured'),{code:'PROVIDER_NOT_CONFIGURED'});
  const response=await fetchImpl('https://graph.facebook.com/v21.0/'+meta.phoneNumberId+'/messages',{method:'POST',headers:{Authorization:'Bearer '+env.META_WHATSAPP_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:destination,type:'text',text:{body:content.body}})});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error?.message||'Meta rejected the message'),{code:String(response.status)});return {provider:'META',reference:data.messages?.[0]?.id||null};
 }
 throw Object.assign(new Error('Unsupported message channel'),{code:'UNSUPPORTED_CHANNEL'});
}
module.exports={deliver};
