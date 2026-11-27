'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {processWhatsAppAssistant,COMMAND_RE}=require('../src/messaging/whatsapp-assistant');

test('WhatsApp command messages bypass the AI receptionist',()=>{
 for(const value of ['SERVICES','SLOTS 2 2026-12-01','BOOK 2 4 2026-12-01T10:00:00+05:30','CONFIRM 22','CANCEL 22','ACCEPT 3','DECLINE 3','RATE 5 22'])assert.equal(COMMAND_RE.test(value),true,value);
 assert.equal(COMMAND_RE.test('What services do you offer?'),false);
});

function fakePool({status='AI'}={}){
 const statements=[];
 return {statements,async query(sql,params=[]){
  statements.push({sql,params});
  if(sql.includes('SELECT m.whatsapp_ai_enabled'))return {rowCount:1,rows:[{whatsapp_ai_enabled:true,whatsapp_ai_locale:'mr',whatsapp_ai_greeting:'Namaskar! How can we help?',whatsapp_handoff_keywords:['HUMAN'],name:'Demo Barber'}]};
  if(sql.includes('INSERT INTO shop_whatsapp_conversations'))return {rowCount:1,rows:[{id:17,status,locale:'mr'}]};
  if(sql.includes('SELECT direction,body FROM shop_whatsapp_conversation_messages'))return {rowCount:1,rows:[{direction:'INBOUND',body:'hello'}]};
  if(sql.includes('SELECT name,price,duration_minutes'))return {rowCount:1,rows:[{name:'Haircut',price:250,duration_minutes:30}]};
  if(sql.includes('SELECT display_name FROM shop_staff'))return {rowCount:1,rows:[{display_name:'Amit'}]};
  if(sql.includes('SELECT policy_text,cancellation_notice_hours'))return {rowCount:0,rows:[]};
  if(sql.includes('INSERT INTO shop_whatsapp_conversation_messages')&&sql.includes('RETURNING id'))return {rowCount:1,rows:[{id:99}]};
  return {rowCount:1,rows:[]};
 }};
}

test('AI receptionist saves the inbound and outbound thread and uses configured fallback',async()=>{
 const pool=fakePool();
 const result=await processWhatsAppAssistant(pool,{shopId:4,sender:'919876543210',body:'Hello, what is the price?',customerId:null,env:{}});
 assert.equal(result.body,'Namaskar! How can we help?');
 assert.equal(result.conversationId,17);
 assert.equal(result.outboundMessageId,99);
 assert.equal(result.handedOff,false);
 assert.ok(pool.statements.some(x=>x.sql.includes('INSERT INTO shop_whatsapp_leads')));
 assert.ok(pool.statements.some(x=>x.sql.includes("VALUES($1,'INBOUND',$2)")));
});

test('booking commands are logged but delegated to the existing booking handler',async()=>{
 const pool=fakePool();
 const result=await processWhatsAppAssistant(pool,{shopId:4,sender:'919876543210',body:'SERVICES',env:{}});
 assert.equal(result.skipAI,true);
 assert.equal(result.conversationId,17);
 assert.equal(pool.statements.some(x=>x.sql.includes("VALUES($1,'INBOUND',$2)")),true);
 assert.equal(pool.statements.some(x=>x.sql.includes("VALUES($1,'OUTBOUND'")),false);
});

test('explicit human request pauses AI and creates a handoff lead',async()=>{
 const pool=fakePool();
 const result=await processWhatsAppAssistant(pool,{shopId:4,sender:'919876543210',body:'Please connect me to a human',env:{}});
 assert.equal(result.handedOff,true);
 assert.match(result.body,/passed your message to the shop team/i);
 assert.ok(pool.statements.some(x=>x.sql.includes("SET status='HUMAN'")));
});

test('existing human-owned conversation does not send another bot reply',async()=>{
 const pool=fakePool({status:'HUMAN'});
 const result=await processWhatsAppAssistant(pool,{shopId:4,sender:'919876543210',body:'Any update?',env:{}});
 assert.equal(result,null);
 assert.equal(pool.statements.some(x=>x.sql.includes("VALUES($1,'OUTBOUND'")),false);
});

test('disabled WhatsApp AI never calls the model or creates a conversation',async()=>{
 const pool=fakePool();
 pool.query=async(sql,params)=>{pool.statements.push({sql,params});return {rowCount:1,rows:[{whatsapp_ai_enabled:false,enabled_channels:['WHATSAPP']}]};};
 const result=await processWhatsAppAssistant(pool,{shopId:4,sender:'919876543210',body:'Hello',env:{OPENAI_API_KEY:'not-used'},fetchImpl:async()=>{throw new Error('must not call provider')}});
 assert.equal(result,null);
 assert.equal(pool.statements.length,1);
});
