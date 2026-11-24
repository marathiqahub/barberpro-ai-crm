'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {deliver}=require('../src/messaging/delivery');
const {scheduleAppointmentReminders}=require('../src/messaging/reminders');

test('India SMS delivery is blocked until DLT entity and template IDs exist',async()=>{
 const env={TWILIO_ACCOUNT_SID:'AC123',TWILIO_AUTH_TOKEN:'secret',TWILIO_SMS_FROM:'BARBER'};
 await assert.rejects(()=>deliver('SMS','+919999999999',{body:'Reminder'},env,async()=>{throw new Error('must not call provider')}),{code:'DLT_REGISTRATION_REQUIRED'});
});

test('scheduled WhatsApp delivery requires an approved named template',async()=>{
 const env={META_WHATSAPP_TOKEN:'token'};
 await assert.rejects(()=>deliver('WHATSAPP','919999999999',{body:'Reminder'},env,async()=>{throw new Error('must not call provider')},{provider:'META',phoneNumberId:'123',templateName:'appt_reminder',templateStatus:'PENDING'}),{code:'APPROVED_TEMPLATE_REQUIRED'});
});

test('Meta WhatsApp uses the configured approved template locale',async()=>{
 let payload;
 const env={META_WHATSAPP_TOKEN:'token'};
 const result=await deliver('WHATSAPP','919999999999',{body:'Appointment reminder'},env,async(url,options)=>{payload=JSON.parse(options.body);return new Response(JSON.stringify({messages:[{id:'wamid.test'}]}),{status:200})},{provider:'META',phoneNumberId:'123',templateName:'appt_reminder_hi',templateLanguage:'hi',templateStatus:'APPROVED'});
 assert.equal(result.reference,'wamid.test');
 assert.equal(payload.template.language.code,'hi');
 assert.equal(payload.template.name,'appt_reminder_hi');
});

test('appointment reminder scheduler creates 24-hour, 2-hour and legacy email/SMS queries',async()=>{
 const statements=[];
 const db={query:async(sql,params)=>{statements.push({sql,params});return {rows:[]}}};
 await scheduleAppointmentReminders(db,{shop_id:1,customer_id:2,id:3,starts_at:new Date(Date.now()+48*60*60*1000).toISOString()});
 assert.equal(statements.length,3);
 assert.match(statements[0].sql,/APPOINTMENT_REMINDER_24H/);
 assert.match(statements[1].sql,/APPOINTMENT_REMINDER_2H/);
 assert.match(statements[2].sql,/APPOINTMENT_REMINDER/);
});
