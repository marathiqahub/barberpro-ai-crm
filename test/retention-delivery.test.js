'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {scheduleAppointmentReminders}=require('../src/messaging/reminders');
const {deliver}=require('../src/messaging/delivery');

test('appointment reminder scheduling creates separate 24-hour and 2-hour jobs with consent and dedupe guards',async()=>{
 let captured;
 const db={query:async(sql,params)=>{captured={sql,params};return {rows:[]}}};
 await scheduleAppointmentReminders(db,{id:41,shop_id:3,customer_id:8,starts_at:'2026-12-01T10:00:00Z'});
 assert.match(captured.sql,/APPOINTMENT_REMINDER_24H/);
 assert.match(captured.sql,/APPOINTMENT_REMINDER_2H/);
 assert.match(captured.sql,/c\.consent=TRUE/);
 assert.match(captured.sql,/c\.revoked_at IS NULL/);
 assert.match(captured.sql,/ON CONFLICT\(dedupe_key\)/);
 assert.deepEqual(captured.params,[3,8,41,'2026-12-01T10:00:00Z']);
});

test('scheduled WhatsApp delivery refuses free-form messages without an approved template',async()=>{
 await assert.rejects(
  deliver('WHATSAPP','919999999999',{body:'reminder'}, {}, async()=>({ok:true,json:async()=>({})}), {}),
  error=>error.code==='APPROVED_TEMPLATE_REQUIRED'
 );
});

test('domestic India SMS is blocked without DLT registration and an approved template ID',async()=>{
 await assert.rejects(
  deliver('SMS','+919999999999',{body:'Reminder'}, {TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'secret',TWILIO_SMS_FROM:'BARBER'}, async()=>({ok:true,json:async()=>({})}), {}),
  error=>error.code==='DLT_TEMPLATE_REQUIRED'
 );
});

test('domestic India SMS passes registered DLT PE and template identifiers to Twilio',async()=>{
 let payload;
 await deliver('SMS','+919999999999',{body:'Reminder'}, {
  TWILIO_ACCOUNT_SID:'AC1',TWILIO_AUTH_TOKEN:'secret',TWILIO_SMS_FROM:'BARBER',TWILIO_DLT_PE_ID:'1200000000000000000'
 },async(url,options)=>{payload=new URLSearchParams(options.body);return {ok:true,json:async()=>({sid:'SM1'})}},
 {templateName:'1207160000000000000'});
 assert.equal(payload.get('DltPEId'),'1200000000000000000');
 assert.equal(payload.get('DltTemplateId'),'1207160000000000000');
});

test('Meta WhatsApp templates receive the configured locale and reference parameter',async()=>{
 let sent;
 await deliver('WHATSAPP','919999999999',{body:'Reminder',variables:{'1':'41','2':'1 Dec 2026, 10:00 am','3':'BranchOne'}},{
  META_WHATSAPP_TOKEN:'token'
 },async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({messages:[{id:'wamid.1'}]})}},
 {templateName:'appointment_reminder_24h',phoneNumberId:'123',language:'hi'});
 assert.equal(sent.template.language.code,'hi');
 assert.equal(sent.template.components[0].parameters[0].text,'41');
 assert.equal(sent.template.components[0].parameters[1].text,'1 Dec 2026, 10:00 am');
 assert.equal(sent.template.components[0].parameters[2].text,'BranchOne');
});
