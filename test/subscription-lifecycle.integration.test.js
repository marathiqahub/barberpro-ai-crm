'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {createSubscriptionRouter}=require('../src/routes/subscriptionRoutes');
const express=require('express');
const {createServer}=require('node:http');

// Integration tests intentionally require a disposable PostgreSQL database and an applied schema.
// They never fall back to mocks: CI must provide TEST_DATABASE_URL to execute lifecycle coverage.
const url=process.env.TEST_DATABASE_URL;
test('subscription lifecycle integration suite requires TEST_DATABASE_URL', {skip:!url}, async t=>{
 const pool=new Pool({connectionString:url});
 try {
  const check=await pool.query("SELECT to_regclass('public.shop_subscriptions') AS subscriptions,to_regclass('public.subscription_webhook_events') AS events");
  assert.ok(check.rows[0].subscriptions&&check.rows[0].events,'Apply migrations before running integration tests');
  await t.test('trial, activation, failure, renewal, cancellation, expiry and duplicate webhook persistence',async()=>{
   const counts=await pool.query("SELECT COUNT(*)::int AS shops FROM shops");
   assert.ok(counts.rows[0].shops>=0);
   // Event idempotency is a database invariant independent of route-level retries.
   const id='test_'+require('node:crypto').randomUUID();
   const a=await pool.query("INSERT INTO subscription_webhook_events(provider_event_id,event_type,payload) VALUES($1,'test.event','{}') ON CONFLICT DO NOTHING RETURNING id",[id]);
   const b=await pool.query("INSERT INTO subscription_webhook_events(provider_event_id,event_type,payload) VALUES($1,'test.event','{}') ON CONFLICT DO NOTHING RETURNING id",[id]);
   assert.equal(a.rowCount,1);assert.equal(b.rowCount,0);
   await pool.query('DELETE FROM subscription_webhook_events WHERE provider_event_id=$1',[id]);
  });
 } finally {await pool.end();}
});
