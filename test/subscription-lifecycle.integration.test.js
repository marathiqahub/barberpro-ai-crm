'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const crypto=require('node:crypto');
const express=require('express');
const {createServer}=require('node:http');
const {createSubscriptionRouter}=require('../src/routes/subscriptionRoutes');
const url=process.env.TEST_DATABASE_URL;

test('subscription lifecycle APIs, webhook ordering, authorization, reconciliation and concurrency', {skip:!url,timeout:90000}, async()=>{
 const pool=new Pool({connectionString:url,max:12}),secret=crypto.randomBytes(32).toString('hex');
 const suffix=crypto.randomUUID(),slug='sub-api-'+suffix,providerPlan='plan_'+suffix,providerSub='sub_'+suffix;
 let shopId,otherShopId,planId,ownerId,outsiderId,server,trialSubscriptionId,subscriptionId;
 let providerSubscriptionCreates=0,providerCancelCalls=0,firstProviderSubscriptionId=null;
 const authMiddleware={
  authenticate(req,res,next){const token=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!['owner','outsider','admin'].includes(token))return res.status(401).json({error:'unauthorized'});req.user={id:token==='outsider'?outsiderId:ownerId,role:token==='admin'?'ADMIN':'CUSTOMER'};next();},
  requireRole(...roles){return(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:'forbidden'});}
 };
 const fetchImpl=async(url,options={})=>{
  const u=new URL(url),path=u.pathname.replace('/v1','');
  if(path==='/subscriptions'&&options.method==='POST'){providerSubscriptionCreates++;const id=providerSub+'_'+providerSubscriptionCreates;if(providerSubscriptionCreates===1)firstProviderSubscriptionId=id;return new Response(JSON.stringify({id,short_url:'https://checkout.razorpay.test/'+id,status:'created'}),{status:200});}
  if(path.startsWith('/subscriptions/')&&path.endsWith('/cancel')){providerCancelCalls++;return new Response(JSON.stringify({id:providerSub,status:'cancelled'}),{status:200});}
  if(path==='/invoices'){return new Response(JSON.stringify({items:[{id:'inv_'+suffix,payment_id:'pay_'+suffix,invoice_number:'INV-'+suffix,amount:49900,status:'paid',paid_at:Math.floor(Date.now()/1000),short_url:'https://invoice.test/'+suffix}]}),{status:200});}
  if(path==='/payments/pay_'+suffix){return new Response(JSON.stringify({id:'pay_'+suffix,status:'captured',amount:49900,created_at:Math.floor(Date.now()/1000)}),{status:200});}
  return new Response(JSON.stringify({error:{description:'Unexpected mocked Razorpay request: '+path}}),{status:500});
 };
 try{
  const shop=await pool.query("INSERT INTO shops(name,slug) VALUES($1,$2) RETURNING id",['Subscription API test',slug]);shopId=shop.rows[0].id;
  const other=await pool.query("INSERT INTO shops(name,slug) VALUES($1,$2) RETURNING id",['Other subscription shop',slug+'-other']);otherShopId=other.rows[0].id;
  const owner=await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES('Billing owner',$1,'test-hash','CUSTOMER') RETURNING id",['owner-'+suffix+'@example.test']);ownerId=owner.rows[0].id;
  const outsider=await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES('Other user',$1,'test-hash','CUSTOMER') RETURNING id",['outsider-'+suffix+'@example.test']);outsiderId=outsider.rows[0].id;
  const plan=await pool.query("INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise,razorpay_plan_id,feature_entitlements) VALUES($1,'API test plan','MONTHLY',49900,$2,'{\"ADVANCED_REPORTS\":true}'::jsonb) RETURNING id",['api-'+suffix.slice(0,28),providerPlan]);planId=plan.rows[0].id;
  await pool.query("INSERT INTO shop_billing_members(shop_id,user_id,role) VALUES($1,$2,'SHOP_OWNER')",[shopId,ownerId]);
  const app=express();app.use(express.json({verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));
  app.use('/api',createSubscriptionRouter(pool,{}, {env:{RAZORPAY_KEY_ID:'rzp_test',RAZORPAY_KEY_SECRET:'secret',RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET:secret},fetchImpl,authMiddleware}));
  server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,{method='GET',token='owner',body}={}){const headers={};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json().catch(()=>({}))};}
  async function webhook(event,id,createdAt,entities={}){const body=JSON.stringify({event,created_at:createdAt,payload:{subscription:{entity:{id:firstProviderSubscriptionId,...(entities.subscription||{})}},...(entities.payment?{payment:{entity:entities.payment}}:{}),...(entities.invoice?{invoice:{entity:entities.invoice}}:{})}});const signature=crypto.createHmac('sha256',secret).update(body).digest('hex');return fetch(base+'/api/subscriptions/webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':signature,'x-razorpay-event-id':id},body});}

  // Billing membership is shop-scoped; authentication alone is not sufficient.
  assert.equal((await request('/shops/'+shopId+'/subscription',{token:'outsider'})).status,403);
  assert.equal((await request('/shops/'+otherShopId+'/feature-entitlements',{token:'owner'})).status,403);
  assert.equal((await request('/shops/'+shopId+'/feature-entitlements',{token:'owner'})).status,200);

  // Concurrent trial attempts serialize and only one can create the trial.
  const trialAttempts=await Promise.all([request('/shops/'+shopId+'/subscription/trial',{method:'POST',body:{planId}}),request('/shops/'+shopId+'/subscription/trial',{method:'POST',body:{planId}})]);
  assert.deepEqual(trialAttempts.map(x=>x.status).sort(),[201,409]);
  trialSubscriptionId=trialAttempts.find(x=>x.status===201).body.subscription.id;
  assert.equal((await request('/shops/'+shopId+'/subscription')).body.subscription.status,'TRIALING');
  assert.equal((await request('/shops/'+shopId+'/feature-entitlements')).body.entitlements.ADVANCED_REPORTS,true);
  assert.equal((await request('/shops/'+shopId+'/subscription/cancel',{method:'PATCH',body:{}})).status,200);

  // Concurrent checkout attempts serialize before calling Razorpay.
  const checkoutAttempts=await Promise.all([request('/shops/'+shopId+'/subscription',{method:'POST',body:{planId}}),request('/shops/'+shopId+'/subscription',{method:'POST',body:{planId}})]);
  assert.deepEqual(checkoutAttempts.map(x=>x.status).sort(),[201,409]);
  assert.equal(providerSubscriptionCreates,1);
  subscriptionId=checkoutAttempts.find(x=>x.status===201).body.subscription.id;
  assert.ok(checkoutAttempts.find(x=>x.status===201).body.checkoutUrl);
  assert.equal((await request('/shops/'+shopId+'/subscription')).body.subscription.status,'CREATED');

  // Signed API webhook transitions; older events must not revert newer state.
  const t0=Math.floor(Date.now()/1000)-100,t1=t0+10,t2=t0+20,t3=t0+30,t4=t0+40;
  let response=await webhook('subscription.activated','evt-'+suffix+'-active',t1,{subscription:{current_start:t1,current_end:t1+2592000}});
  assert.equal(response.status,200);assert.equal((await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId])).rows[0].status,'ACTIVE');
  response=await webhook('subscription.pending','evt-'+suffix+'-stale',t0);
  assert.equal(response.status,200);assert.equal((await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId])).rows[0].status,'ACTIVE');
  response=await webhook('subscription.halted','evt-'+suffix+'-halt',t2,{payment:{id:'pay-fail-'+suffix,status:'failed',amount:49900,error_description:'declined'}});
  assert.equal(response.status,200);
  let state=await pool.query('SELECT status,failure_count FROM shop_subscriptions WHERE id=$1',[subscriptionId]);assert.equal(state.rows[0].status,'HALTED');assert.equal(state.rows[0].failure_count,1);
  response=await webhook('subscription.charged','evt-'+suffix+'-renew',t3,{subscription:{current_start:t3,current_end:t3+2592000},payment:{id:'pay-paid-'+suffix,status:'captured',amount:49900,created_at:t3}});
  assert.equal(response.status,200);
  state=await pool.query('SELECT status,failure_count,last_payment_failed_at FROM shop_subscriptions WHERE id=$1',[subscriptionId]);assert.equal(state.rows[0].status,'ACTIVE');assert.equal(state.rows[0].failure_count,0);assert.equal(state.rows[0].last_payment_failed_at,null);

  // Unknown provider payment statuses are ignored, never misclassified as FAILED.
  await webhook('subscription.charged','evt-'+suffix+'-unknown',t3+1,{payment:{id:'pay-unknown-'+suffix,status:'authorized',amount:49900}});
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM subscription_payments WHERE razorpay_payment_id=$1',['pay-unknown-'+suffix])).rows[0].n,0);
  assert.equal((await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId])).rows[0].status,'ACTIVE');

  // Duplicate webhook delivery is idempotent; a later cancellation and expiry transition are persisted.
  const duplicateId='evt-'+suffix+'-cancel';
  response=await webhook('subscription.cancelled',duplicateId,t4);
  assert.equal(response.status,200);
  const duplicate=await webhook('subscription.cancelled',duplicateId,t4);assert.equal((await duplicate.json()).duplicate,true);
  assert.equal((await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId])).rows[0].status,'CANCELLED');
  // A newer terminal expiry event is accepted; an older activation cannot resurrect it.
  await webhook('subscription.expired','evt-'+suffix+'-expired',t4+1);
  await webhook('subscription.activated','evt-'+suffix+'-late-activation',t4-1);
  assert.equal((await pool.query('SELECT status FROM shop_subscriptions WHERE id=$1',[subscriptionId])).rows[0].status,'EXPIRED');
  const staleEvent=await pool.query("SELECT provider_created_at FROM shop_subscription_webhook_events WHERE event_id=$1",['evt-'+suffix+'-late-activation']);assert.equal(staleEvent.rowCount,1);

  // Provider cancellation API, payment/invoice reconciliation and idempotent ledger upserts.
  // Use another checkout subscription because the first is terminal.
  await pool.query("UPDATE shop_subscriptions SET status='CANCELLED' WHERE id=$1",[subscriptionId]);
  const checkout=await request('/shops/'+shopId+'/subscription',{method:'POST',body:{planId}});assert.equal(checkout.status,201);
  const reconcile=await request('/shops/'+shopId+'/subscription/reconcile',{method:'POST',body:{}});
  assert.equal(reconcile.status,200);assert.equal(reconcile.body.payments,1);assert.equal(reconcile.body.invoices,1);
  const reconcileAgain=await request('/shops/'+shopId+'/subscription/reconcile',{method:'POST',body:{}});
  assert.equal(reconcileAgain.status,200);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM subscription_payments WHERE razorpay_payment_id=$1',['pay_'+suffix])).rows[0].n,1);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM subscription_invoices WHERE provider_invoice_id=$1',['inv_'+suffix])).rows[0].n,1);
  const cancelled=await request('/shops/'+shopId+'/subscription/cancel',{method:'PATCH',body:{cancelAtCycleEnd:false}});
  assert.equal(cancelled.status,200);assert.equal(providerCancelCalls,1);

  // No subscription is returned for a different shop, even if the caller is a member of this shop.
  assert.equal((await request('/shops/'+otherShopId+'/subscription')).status,403);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(shopId){
   await pool.query('DELETE FROM shop_subscription_webhook_events WHERE razorpay_subscription_id=$1',[firstProviderSubscriptionId]).catch(()=>{});
   await pool.query('DELETE FROM subscription_webhook_events WHERE payload::text LIKE $1',['%'+providerSub+'%']).catch(()=>{});
   await pool.query('DELETE FROM subscription_payments WHERE shop_id=$1',[shopId]).catch(()=>{});
   await pool.query('DELETE FROM subscription_invoices WHERE shop_id=$1',[shopId]).catch(()=>{});
   await pool.query('DELETE FROM shop_subscriptions WHERE shop_id=$1',[shopId]).catch(()=>{});
   await pool.query('DELETE FROM shop_billing_members WHERE shop_id=$1',[shopId]).catch(()=>{});
   await pool.query('DELETE FROM shops WHERE id=ANY($1::bigint[])',[[shopId,otherShopId].filter(Boolean)]).catch(()=>{});
  }
  if(planId)await pool.query('DELETE FROM barberpro_subscription_plans WHERE id=$1',[planId]).catch(()=>{});
  if(ownerId)await pool.query('DELETE FROM users WHERE id=ANY($1::bigint[])',[[ownerId,outsiderId].filter(Boolean)]).catch(()=>{});
  await pool.end();
 }
});
