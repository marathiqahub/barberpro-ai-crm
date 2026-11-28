'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const crypto=require('node:crypto');
const express=require('express');
const {createServer}=require('node:http');
const {createSubscriptionRouter}=require('../src/routes/subscriptionRoutes');
const url=process.env.TEST_DATABASE_URL;
test('PostgreSQL subscription lifecycle and webhook idempotency', {skip:!url}, async()=>{
 const pool=new Pool({connectionString:url,max:1});
 const client=await pool.connect();
 let shopId,planId,subId;
 try{
  await client.query('BEGIN');
  const shop=await client.query("INSERT INTO shops(name,slug) VALUES($1,$2) RETURNING id",['Billing test shop','billing-test-'+crypto.randomUUID()]);
  shopId=shop.rows[0].id;
  const plan=await client.query("INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise,feature_entitlements) VALUES($1,'Test plan','MONTHLY',49900,'{\"ADVANCED_REPORTS\":true}'::jsonb) RETURNING id",['test-'+crypto.randomUUID().slice(0,30)]);
  planId=plan.rows[0].id;
  const trial=await client.query("INSERT INTO shop_subscriptions(shop_id,plan_id,status,trial_ends_at) VALUES($1,$2,'TRIALING',NOW()+INTERVAL '14 days') RETURNING id,status,trial_ends_at",[shopId,planId]);
  subId=trial.rows[0].id;
  assert.equal(trial.rows[0].status,'TRIALING');
  assert.ok(new Date(trial.rows[0].trial_ends_at)>new Date());
  await client.query("UPDATE shop_subscriptions SET status='ACTIVE',current_start=NOW(),current_end=NOW()+INTERVAL '1 month' WHERE id=$1",[subId]);
  assert.equal((await client.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subId])).rows[0].status,'ACTIVE');
  await client.query("INSERT INTO subscription_payments(shop_id,subscription_id,razorpay_payment_id,amount_paise,status,failure_reason) VALUES($1,$2,$3,49900,'FAILED','declined')",[shopId,subId,'pay_fail_'+crypto.randomUUID()]);
  await client.query("UPDATE shop_subscriptions SET status='HALTED',last_payment_failed_at=NOW(),failure_count=1 WHERE id=$1",[subId]);
  assert.equal((await client.query('SELECT failure_count FROM shop_subscriptions WHERE id=$1',[subId])).rows[0].failure_count,1);
  await client.query("INSERT INTO subscription_payments(shop_id,subscription_id,razorpay_payment_id,amount_paise,status,paid_at) VALUES($1,$2,$3,49900,'CAPTURED',NOW())",[shopId,subId,'pay_renew_'+crypto.randomUUID()]);
  await client.query("UPDATE shop_subscriptions SET status='ACTIVE',failure_count=0,last_payment_failed_at=NULL,current_start=NOW(),current_end=NOW()+INTERVAL '1 month' WHERE id=$1",[subId]);
  await client.query("INSERT INTO subscription_invoices(shop_id,subscription_id,invoice_number,amount_paise,status,paid_at) VALUES($1,$2,$3,49900,'PAID',NOW())",[shopId,subId,'INV-'+crypto.randomUUID()]);
  assert.equal((await client.query("SELECT COUNT(*)::int n FROM subscription_invoices WHERE shop_id=$1 AND status='PAID'",[shopId])).rows[0].n,1);
  await client.query("UPDATE shop_subscriptions SET cancel_at_period_end=TRUE WHERE id=$1",[subId]);
  assert.equal((await client.query('SELECT cancel_at_period_end FROM shop_subscriptions WHERE id=$1',[subId])).rows[0].cancel_at_period_end,true);
  await client.query("UPDATE shop_subscriptions SET status='CANCELLED',cancelled_at=NOW() WHERE id=$1",[subId]);
  assert.equal((await client.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subId])).rows[0].status,'CANCELLED');
  const expired=await client.query("INSERT INTO shop_subscriptions(shop_id,plan_id,status,trial_ends_at) VALUES($1,$2,'TRIALING',NOW()-INTERVAL '1 day') RETURNING id,trial_ends_at",[shopId,planId]);
  assert.ok(new Date(expired.rows[0].trial_ends_at)<new Date());
  await client.query("UPDATE shop_subscriptions SET status='EXPIRED' WHERE id=$1 AND trial_ends_at<=NOW()",[expired.rows[0].id]);
  assert.equal((await client.query('SELECT status FROM shop_subscriptions WHERE id=$1',[expired.rows[0].id])).rows[0].status,'EXPIRED');
  const eventId='evt_'+crypto.randomUUID();
  const first=await client.query("INSERT INTO subscription_webhook_events(provider_event_id,event_type,payload) VALUES($1,'subscription.charged','{}') ON CONFLICT(provider_event_id) DO NOTHING RETURNING id",[eventId]);
  const duplicate=await client.query("INSERT INTO subscription_webhook_events(provider_event_id,event_type,payload) VALUES($1,'subscription.charged','{}') ON CONFLICT(provider_event_id) DO NOTHING RETURNING id",[eventId]);
  assert.equal(first.rowCount,1);assert.equal(duplicate.rowCount,0);
  assert.equal((await client.query('SELECT COUNT(*)::int n FROM subscription_webhook_events WHERE provider_event_id=$1',[eventId])).rows[0].n,1);
 }finally{
  await client.query('ROLLBACK').catch(()=>{});
  client.release();await pool.end();
 }
});

test('signed Razorpay webhook activates once and safely acknowledges duplicate delivery', {skip:!url}, async()=>{
 const pool=new Pool({connectionString:url,max:3}),secret=crypto.randomBytes(32).toString('hex');
 const slug='webhook-test-'+crypto.randomUUID(),planCode='wh-'+crypto.randomUUID().slice(0,32),providerId='sub_'+crypto.randomUUID(),eventId='evt_'+crypto.randomUUID();
 let shopId,planId,subscriptionId,server;
 try{
  const shop=await pool.query('INSERT INTO shops(name,slug) VALUES($1,$2) RETURNING id',['Webhook test shop',slug]);shopId=shop.rows[0].id;
  const plan=await pool.query("INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise) VALUES($1,'Webhook test','MONTHLY',49900) RETURNING id",[planCode]);planId=plan.rows[0].id;
  const sub=await pool.query("INSERT INTO shop_subscriptions(shop_id,plan_id,razorpay_subscription_id,status) VALUES($1,$2,$3,'CREATED') RETURNING id",[shopId,planId,providerId]);subscriptionId=sub.rows[0].id;
  const app=express();
  app.use(express.json({verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));
  app.use('/api',createSubscriptionRouter(pool,{}, {env:{RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET:secret}}));
  server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const body=JSON.stringify({event:'subscription.activated',payload:{subscription:{entity:{id:providerId,current_start:Math.floor(Date.now()/1000),current_end:Math.floor(Date.now()/1000)+2592000}}}});
  const signature=crypto.createHmac('sha256',secret).update(body).digest('hex');
  const send=()=>fetch('http://127.0.0.1:'+server.address().port+'/api/subscriptions/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':signature,'X-Razorpay-Event-Id':eventId},body});
  const first=await send(),firstBody=await first.json();assert.equal(first.status,200);assert.equal(firstBody.processed,true);
  const second=await send(),secondBody=await second.json();assert.equal(second.status,200);assert.equal(secondBody.duplicate,true);
  const state=await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId]);assert.equal(state.rows[0].status,'ACTIVE');
  const events=await pool.query('SELECT COUNT(*)::int n FROM subscription_webhook_events WHERE provider_event_id=$1',[eventId]);assert.equal(events.rows[0].n,1);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(subscriptionId)await pool.query('DELETE FROM shop_subscriptions WHERE id=$1',[subscriptionId]).catch(()=>{});
  if(shopId)await pool.query('DELETE FROM subscription_webhook_events WHERE payload->\'payload\'->\'subscription\'->\'entity\'->>\'id\'=$1',[providerId]).catch(()=>{});
  if(shopId)await pool.query('DELETE FROM shops WHERE id=$1',[shopId]).catch(()=>{});
  if(planId)await pool.query('DELETE FROM barberpro_subscription_plans WHERE id=$1',[planId]).catch(()=>{});
  await pool.end();
 }
});
