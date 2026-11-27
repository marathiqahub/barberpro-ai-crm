'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const crypto=require('node:crypto');
const url=process.env.TEST_DATABASE_URL;
test('PostgreSQL subscription lifecycle and webhook idempotency', {skip:!url}, async()=>{
 const pool=new Pool({connectionString:url,max:1});
 const client=await pool.connect();
 let shopId,planId,subId;
 try{
  await client.query('BEGIN');
  const shop=await client.query("INSERT INTO shops(name,slug) VALUES($1,$2) RETURNING id",['Billing test shop','billing-test-'+crypto.randomUUID()]);
  shopId=shop.rows[0].id;
  const plan=await client.query("INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise,feature_entitlements) VALUES($1,'Test plan','MONTHLY',49900,'{\"ADVANCED_REPORTS\":true}'::jsonb) RETURNING id",['test-'+crypto.randomUUID()]);
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
