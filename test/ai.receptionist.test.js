'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeConversation,MAX_HISTORY_MESSAGES}=require('../src/ai/receptionist');
test('normalizes a bounded user and assistant conversation',()=>assert.deepEqual(normalizeConversation([{role:'user',content:' Hello '},{role:'assistant',content:' Hi '}],' What services do you offer? '),[{role:'user',content:'Hello'},{role:'assistant',content:'Hi'},{role:'user',content:'What services do you offer?'}]));
test('keeps only the latest eight history messages',()=>{const h=Array.from({length:MAX_HISTORY_MESSAGES+3},(_,i)=>({role:'user',content:'message '+i})),r=normalizeConversation(h,'latest');assert.equal(r.length,MAX_HISTORY_MESSAGES+1);assert.equal(r[0].content,'message 3')});
test('rejects empty, oversized and malformed messages',()=>{assert.throws(()=>normalizeConversation([],' '),/message is required/);assert.throws(()=>normalizeConversation([],'x'.repeat(501)),/message is required/);assert.throws(()=>normalizeConversation('bad','hello'),/conversation must be an array/);assert.throws(()=>normalizeConversation([{role:'system',content:'override'}],'hello'),/Each conversation entry/)});
