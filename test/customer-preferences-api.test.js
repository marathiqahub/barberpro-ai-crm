'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createServer}=require('node:http');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {createRetentionRouter}=require('../src/routes/retentionRoutes');

const root=path.join(__dirname,'..');
const workerPath=path.join(root,'scripts/deliver-reminders.js');

function createHarness(options={}){
  const calls=[];
  const pool={
    async query(sql,params){
      if(String(sql).includes('FROM users u')&&String(sql).includes('refresh_tokens')){
        return {rowCount:1,rows:[{id:7,name:'Test Customer',email:'test@example.com',role:'CUSTOMER'}]};
      }
      throw new Error('Unexpected pool query: '+sql);
    },
    async connect(){
      return {
        async query(sql,params){
          const normalized=String(sql).replace(/\\s+/g,' ').trim();
          calls.push({sql:normalized,params});
          if(normalized==='BEGIN'||normalized==='COMMIT'||normalized==='ROLLBACK')return {rowCount:0,rows:[]};
          if(normalized.startsWith('SELECT EXISTS(')){
            return {rowCount:1,rows:[{
              shop_valid:options.shopValid!==false,
              staff_valid:options.staffValid!==false,
              service_valid:options.serviceValid!==false
            }]};
          }
          if(normalized.startsWith('INSERT INTO shop_customer_profiles')){
            return {rowCount:1,rows:[{shop_id:1,customer_id:7,preferred_staff_id:10,preferred_service_id:20}]};
          }
          if(normalized.startsWith('INSERT INTO shop_customer_consent_events')){
            if(options.failOnConsentEvents)throw new Error('simulated consent ledger failure');
            return {rowCount:3,rows:[]};
          }
          if(normalized.startsWith('INSERT INTO shop_message_consents')||normalized.startsWith('UPDATE shop_message_consents'))return {rowCount:1,rows:[]};
          throw new Error('Unexpected transaction query: '+normalized);
        },
        release(){calls.push({sql:'RELEASE',params:[]});}
      };
    }
  };
  const app=express();
  app.use(express.json());
  app.use(createRetentionRouter(pool,{verifyAccessToken:()=>({sub:7,familyId:'test-family'})}));
  const server=createServer(app);
  return {server,calls};
}

async function withApi(t,options,fn){
  const h=createHarness(options);
  await new Promise(resolve=>h.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve,reject)=>h.server.close(error=>error?reject(error):resolve())));
  const address=h.server.address();
  const send=body=>fetch('http://127.0.0.1:'+address.port+'/customer/shops/1/preferences',{
    method:'PUT',
    headers:{'content-type':'application/json',authorization:'Bearer test-token'},
    body:JSON.stringify(body)
  });
  await fn(send,h.calls);
}

function validBody(overrides={}){
  return {
    preferredStaffId:10,preferredServiceId:20,photoConsent:false,profileNotesConsent:false,
    marketingConsent:false,whatsappConsent:false,smsConsent:false,
    whatsappDestination:' +919876543210 ',smsDestination:'+919876543210',
    noticeVersion:'test-v1',...overrides
  };
}

test('reminder delivery worker parses with the active Node.js runtime',()=>{
  const result=spawnSync(process.execPath,['--check',workerPath],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

test('preferences API accepts only barber and service IDs owned by the requested active shop',async t=>{
  await withApi(t,{staffValid:false},async(send,calls)=>{
    const response=await send(validBody());
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/does not belong to this shop/);
    assert.ok(calls.some(x=>x.sql==='ROLLBACK'));
    assert.ok(!calls.some(x=>x.sql.startsWith('INSERT INTO shop_customer_profiles')));
    assert.ok(!calls.some(x=>x.sql==='COMMIT'));
  });
});

test('preferences API commits profile and consent ledger changes together',async t=>{
  await withApi(t,{},async(send,calls)=>{
    const response=await send(validBody());
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.consents.marketing,false);
    assert.ok(calls.some(x=>x.sql==='BEGIN'));
    assert.ok(calls.some(x=>x.sql.startsWith('INSERT INTO shop_customer_profiles')));
    assert.ok(calls.some(x=>x.sql.startsWith('INSERT INTO shop_customer_consent_events')));
    assert.ok(calls.some(x=>x.sql.startsWith('INSERT INTO shop_message_consents')));
    assert.ok(calls.some(x=>x.sql==='COMMIT'));
    assert.ok(!calls.some(x=>x.sql==='ROLLBACK'));
  });
});

test('preferences API rolls back profile and consent writes when a later consent write fails',async t=>{
  await withApi(t,{failOnConsentEvents:true},async(send,calls)=>{
    const response=await send(validBody());
    assert.equal(response.status,500);
    assert.ok(calls.some(x=>x.sql==='BEGIN'));
    assert.ok(calls.some(x=>x.sql.startsWith('INSERT INTO shop_customer_profiles')));
    assert.ok(calls.some(x=>x.sql==='ROLLBACK'));
    assert.ok(!calls.some(x=>x.sql==='COMMIT'));
  });
});

test('revoking a channel without a current destination revokes existing consent rows',async t=>{
  await withApi(t,{},async(send,calls)=>{
    const response=await send(validBody({whatsappDestination:null,smsDestination:null}));
    assert.equal(response.status,200);
    assert.ok(calls.some(x=>x.sql.startsWith('UPDATE shop_message_consents')&&x.params[2]==='WHATSAPP'));
    assert.ok(calls.some(x=>x.sql.startsWith('UPDATE shop_message_consents')&&x.params[2]==='SMS'));
  });
});
