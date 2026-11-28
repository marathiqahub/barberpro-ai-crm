'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {createAuthMiddleware}=require('../auth/middleware');

function createSubscriptionRouter(pool,tokenService,options={}) {
 const r=express.Router(),{authenticate,requireRole}=options.authMiddleware||createAuthMiddleware(pool,tokenService);
 const env=options.env||process.env,fetchImpl=options.fetchImpl||global.fetch;
 const admin=[authenticate,requireRole('ADMIN')],signed=[authenticate];
 const wrap=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);
 const keyId=env.RAZORPAY_KEY_ID,keySecret=env.RAZORPAY_KEY_SECRET;
 const webhookSecret=env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET||env.RAZORPAY_WEBHOOK_SECRET;
 const validId=v=>/^[1-9]\d*$/.test(String(v))?Number(v):null;
 const equal=(a,b)=>{const x=Buffer.from(String(a||''),'hex'),y=Buffer.from(String(b||''),'hex');return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);};
 async function provider(path,method='GET',body) {
  if(!keyId||!keySecret)throw Object.assign(new Error('Razorpay credentials are not configured.'),{status:503});
  const response=await fetchImpl('https://api.razorpay.com/v1'+path,{method,headers:{Authorization:'Basic '+Buffer.from(keyId+':'+keySecret).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.error?.description||'Razorpay request failed.'),{status:502});
  return data;
 }
 async function canBill(user,shopId) {
  if(user.role==='ADMIN')return true;
  const q=await pool.query("SELECT 1 FROM shop_billing_members WHERE shop_id=$1 AND user_id=$2 AND role IN('SHOP_OWNER','BILLING_ADMIN')",[shopId,user.id]);
  return q.rowCount>0;
 }
 function billing(req,res,next) {
  const shopId=validId(req.params.shopId);
  if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  canBill(req.user,shopId).then(allowed=>{if(!allowed)return res.status(403).json({error:'Billing access is limited to your own shop.'});req.shopId=shopId;next();}).catch(next);
 }
 r.post('/admin/subscription-plans',...admin,wrap(async(q,s)=>{
  const {code,name,billingPeriod,amountPaise,featureEntitlements={}}=q.body||{};
  if(!/^[a-z0-9-]{2,40}$/.test(code||'')||typeof name!=='string'||!name.trim()||!['MONTHLY','YEARLY'].includes(billingPeriod)||!Number.isSafeInteger(amountPaise)||amountPaise<100||!featureEntitlements||typeof featureEntitlements!=='object'||Array.isArray(featureEntitlements)||Object.values(featureEntitlements).some(v=>typeof v!=='boolean'))return s.status(400).json({error:'Invalid plan details.'});
  const remote=await provider('/plans','POST',{period:billingPeriod==='MONTHLY'?'monthly':'yearly',interval:1,item:{name:name.trim(),amount:amountPaise,currency:'INR'},notes:{code}});
  const saved=await pool.query(`INSERT INTO barberpro_subscription_plans(code,name,billing_period,amount_paise,razorpay_plan_id,feature_entitlements)
   VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[code,name.trim(),billingPeriod,amountPaise,remote.id,JSON.stringify(featureEntitlements)]);
  s.status(201).json({plan:saved.rows[0]});
 }));
 r.post('/shops/:shopId/subscription/trial',...signed,billing,wrap(async(q,s)=>{
  const planId=validId(q.body?.planId);if(!planId)return s.status(400).json({error:'Valid planId is required.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const plan=await c.query('SELECT id FROM barberpro_subscription_plans WHERE id=$1 AND is_active=TRUE',[planId]);
   if(!plan.rowCount){await c.query('ROLLBACK');return s.status(404).json({error:'Active plan not found.'});}
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('subscription-shop:'||$1::text,0))",[q.shopId]);
   const existing=await c.query("SELECT id,status FROM shop_subscriptions WHERE shop_id=$1 AND status IN('CREATED','AUTHENTICATED','ACTIVE','PENDING','TRIALING') FOR UPDATE",[q.shopId]);
   if(existing.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'Shop already has a current subscription.'});}
   const prior=await c.query('SELECT 1 FROM shop_subscriptions WHERE shop_id=$1 AND trial_ends_at IS NOT NULL',[q.shopId]);
   if(prior.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'This shop has already used its trial.'});}
   const saved=await c.query("INSERT INTO shop_subscriptions(shop_id,plan_id,status,trial_ends_at,created_by) VALUES($1,$2,'TRIALING',NOW()+INTERVAL '14 days',$3) RETURNING *",[q.shopId,planId,q.user.id]);
   await c.query('COMMIT');s.status(201).json({subscription:saved.rows[0]});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 r.post('/shops/:shopId/subscription',...signed,billing,wrap(async(q,s)=>{
  const planId=validId(q.body?.planId);if(!planId)return s.status(400).json({error:'Valid planId is required.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('subscription-shop:'||$1::text,0))",[q.shopId]);
   const plan=await c.query('SELECT id,razorpay_plan_id FROM barberpro_subscription_plans WHERE id=$1 AND is_active=TRUE',[planId]);
   if(!plan.rowCount||!plan.rows[0].razorpay_plan_id){await c.query('ROLLBACK');return s.status(404).json({error:'Active provider-backed plan not found.'});}
   const current=await c.query("SELECT id FROM shop_subscriptions WHERE shop_id=$1 AND status IN('CREATED','AUTHENTICATED','ACTIVE','PENDING','TRIALING') FOR UPDATE",[q.shopId]);
   if(current.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'Shop already has a current subscription.'});}
   const remote=await provider('/subscriptions','POST',{plan_id:plan.rows[0].razorpay_plan_id,total_count:120,customer_notify:1,notes:{shopId:String(q.shopId),planId:String(planId)}});
   const saved=await c.query("INSERT INTO shop_subscriptions(shop_id,plan_id,razorpay_subscription_id,status,short_url,provider_payload,created_by) VALUES($1,$2,$3,'CREATED',$4,$5::jsonb,$6) RETURNING id,shop_id,plan_id,status,short_url",[q.shopId,planId,remote.id,remote.short_url,JSON.stringify({id:remote.id,status:remote.status}),q.user.id]);
   await c.query('COMMIT');s.status(201).json({subscription:saved.rows[0],checkoutUrl:remote.short_url});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }));
 r.get('/shops/:shopId/subscription',...signed,billing,wrap(async(q,s)=>{
  const found=await pool.query(`SELECT ss.*,p.code plan_code,p.name plan_name,p.billing_period,p.amount_paise,p.feature_entitlements
   FROM shop_subscriptions ss JOIN barberpro_subscription_plans p ON p.id=ss.plan_id WHERE ss.shop_id=$1 ORDER BY ss.created_at DESC LIMIT 1`,[q.shopId]);
  s.json({subscription:found.rows[0]||null});
 }));
 r.patch('/shops/:shopId/subscription/cancel',...signed,billing,wrap(async(q,s)=>{
  const found=await pool.query("SELECT * FROM shop_subscriptions WHERE shop_id=$1 AND status IN('CREATED','AUTHENTICATED','ACTIVE','PENDING','TRIALING') ORDER BY created_at DESC LIMIT 1",[q.shopId]);
  if(!found.rowCount)return s.status(404).json({error:'No current subscription found.'});
  const sub=found.rows[0],atCycleEnd=q.body?.cancelAtCycleEnd!==false;
  if(sub.status==='TRIALING'||!sub.razorpay_subscription_id){
   const out=await pool.query("UPDATE shop_subscriptions SET status='CANCELLED',cancelled_at=NOW(),cancel_at_period_end=FALSE,updated_at=NOW() WHERE id=$1 RETURNING *",[sub.id]);return s.json({subscription:out.rows[0]});
  }
  const remote=await provider('/subscriptions/'+encodeURIComponent(sub.razorpay_subscription_id)+'/cancel','POST',{cancel_at_cycle_end:atCycleEnd});
  const out=await pool.query('UPDATE shop_subscriptions SET cancel_at_period_end=$2,provider_payload=provider_payload||$3::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *',[sub.id,atCycleEnd,JSON.stringify({cancel_requested:true,provider_status:remote.status})]);
  s.json({subscription:out.rows[0]});
 }));
 r.get('/shops/:shopId/subscription/invoices',...signed,billing,wrap(async(q,s)=>{
  const out=await pool.query('SELECT id,invoice_number,amount_paise,currency,status,issued_at,paid_at,receipt_url FROM subscription_invoices WHERE shop_id=$1 ORDER BY issued_at DESC LIMIT 100',[q.shopId]);s.json({invoices:out.rows});
 }));
 r.get('/shops/:shopId/subscription/payments',...signed,billing,wrap(async(q,s)=>{
  const out=await pool.query('SELECT id,razorpay_payment_id,amount_paise,currency,status,failure_reason,paid_at,created_at FROM subscription_payments WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100',[q.shopId]);s.json({payments:out.rows});
 }));
 r.get('/shops/:shopId/feature-entitlements',...signed,billing,wrap(async(q,s)=>{
  const shopId=validId(q.params.shopId);if(!shopId)return s.status(400).json({error:'Invalid shop id.'});
  const sub=await pool.query(`SELECT p.feature_entitlements FROM shop_subscriptions ss JOIN barberpro_subscription_plans p ON p.id=ss.plan_id
   WHERE ss.shop_id=$1 AND ((ss.status='ACTIVE' AND (ss.current_end IS NULL OR ss.current_end>NOW())) OR (ss.status='TRIALING' AND ss.trial_ends_at>NOW()))
   ORDER BY ss.created_at DESC LIMIT 1`,[shopId]);
  if(sub.rowCount)return s.json({entitlements:sub.rows[0].feature_entitlements});
  const any=await pool.query('SELECT 1 FROM shop_subscriptions WHERE shop_id=$1',[shopId]);
  s.json({entitlements:{},legacyAccess:!any.rowCount});
 }));
 r.post('/subscriptions/webhook',(q,s,next)=>{
  try{
   const signature=q.get('x-razorpay-signature')||'',expected=crypto.createHmac('sha256',webhookSecret||'').update(q.rawBody||Buffer.alloc(0)).digest('hex');
   if(!webhookSecret||!equal(signature,expected))return s.status(401).json({error:'Invalid webhook signature.'});
   const body=q.body||{},eventId=q.get('x-razorpay-event-id'),createdAt=Number(body.created_at);
   if(!eventId||eventId.length>160)return s.status(400).json({error:'Missing Razorpay event id.'});
   if(!Number.isSafeInteger(createdAt)||createdAt<=0)return s.status(400).json({error:'A valid Razorpay event timestamp is required.'});
   q.verifiedEvent={eventId,body};next();
  }catch(e){next(e);}
 },wrap(async(q,s)=>{
  const {eventId,body}=q.verifiedEvent,event=body.event||'unknown',entity=body.payload?.subscription?.entity||{},payment=body.payload?.payment?.entity||{},invoice=body.payload?.invoice?.entity||{};
  const providerCreatedAt=Number(body.created_at||0),eventTime=Number.isFinite(providerCreatedAt)&&providerCreatedAt>0?new Date(providerCreatedAt*1000):null;
  const c=await pool.connect();try{await c.query('BEGIN');
   const inserted=await c.query('INSERT INTO subscription_webhook_events(provider_event_id,event_type,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(provider_event_id) DO NOTHING RETURNING id',[eventId,event,JSON.stringify(body)]);
   if(!inserted.rowCount){await c.query('COMMIT');return s.json({received:true,duplicate:true});}
   const subId=entity.id||payment.subscription_id||invoice.subscription_id;
   const found=subId?await c.query('SELECT * FROM shop_subscriptions WHERE razorpay_subscription_id=$1 FOR UPDATE',[subId]):{rowCount:0,rows:[]};
   if(found.rowCount){
    const sub=found.rows[0],map={'subscription.authenticated':'AUTHENTICATED','subscription.activated':'ACTIVE','subscription.charged':'ACTIVE','subscription.pending':'PENDING','subscription.halted':'HALTED','subscription.cancelled':'CANCELLED','subscription.completed':'EXPIRED','subscription.expired':'EXPIRED'};
    const status=map[event],isFresh=!eventTime||!sub.last_webhook_created_at||eventTime>new Date(sub.last_webhook_created_at);
    await c.query(`INSERT INTO shop_subscription_webhook_events(event_id,event_type,razorpay_subscription_id,provider_created_at,payload)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(event_id) DO NOTHING`,[eventId,event,subId,eventTime,JSON.stringify(body)]);
    if(status&&isFresh)await c.query(`UPDATE shop_subscriptions SET status=$2::varchar,current_start=COALESCE(to_timestamp(NULLIF($3,'')::numeric),current_start),
      current_end=COALESCE(to_timestamp(NULLIF($4,'')::numeric),current_end),next_charge_at=COALESCE(to_timestamp(NULLIF($5,'')::numeric),next_charge_at),
      cancelled_at=CASE WHEN $2::varchar='CANCELLED' THEN NOW() ELSE cancelled_at END,last_webhook_created_at=COALESCE($6,last_webhook_created_at),updated_at=NOW() WHERE id=$1`,
      [sub.id,status,String(entity.current_start||''),String(entity.current_end||''),String(entity.charge_at||''),eventTime]);
    else if(isFresh&&eventTime)await c.query('UPDATE shop_subscriptions SET last_webhook_created_at=$2,updated_at=NOW() WHERE id=$1',[sub.id,eventTime]);
    if(event==='subscription.halted'&&isFresh)await c.query("UPDATE shop_subscriptions SET last_payment_failed_at=NOW(),failure_count=failure_count+1,reminder_sent_at=NULL WHERE id=$1",[sub.id]);
    if(payment.id){
     const paymentStatus=String(payment.status||'').toLowerCase(),mappedPaymentStatus={captured:'CAPTURED',failed:'FAILED',refunded:'REFUNDED'}[paymentStatus];
     if(mappedPaymentStatus){
      await c.query(`INSERT INTO subscription_payments(shop_id,subscription_id,razorpay_payment_id,razorpay_invoice_id,amount_paise,status,failure_reason,paid_at,provider_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='CAPTURED' THEN to_timestamp(NULLIF($9,'')::numeric) END,$8::jsonb)
       ON CONFLICT(razorpay_payment_id) DO UPDATE SET status=EXCLUDED.status,failure_reason=EXCLUDED.failure_reason,paid_at=COALESCE(EXCLUDED.paid_at,subscription_payments.paid_at),provider_payload=EXCLUDED.provider_payload`,
       [sub.shop_id,sub.id,payment.id,invoice.id||null,Math.max(0,Number(payment.amount||0)),mappedPaymentStatus,payment.error_description||null,JSON.stringify(payment),String(payment.created_at||'')]);
      if(mappedPaymentStatus==='FAILED'&&isFresh)await c.query("UPDATE shop_subscriptions SET last_payment_failed_at=NOW(),failure_count=failure_count+1,reminder_sent_at=NULL WHERE id=$1",[sub.id]);
      if(mappedPaymentStatus==='CAPTURED'&&isFresh)await c.query("UPDATE shop_subscriptions SET last_payment_failed_at=NULL,failure_count=0,reminder_sent_at=NULL,last_payment_id=$2 WHERE id=$1",[sub.id,payment.id]);
     }
    }
    if(invoice.id){
     const amt=Number(invoice.amount||payment.amount||0),number=String(invoice.invoice_number||('RZP-'+invoice.id));
     await c.query(`INSERT INTO subscription_invoices(shop_id,subscription_id,provider_invoice_id,invoice_number,amount_paise,status,paid_at,receipt_url,invoice_payload)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='PAID' THEN NOW() END,$7,$8::jsonb)
      ON CONFLICT(provider_invoice_id) DO UPDATE SET status=EXCLUDED.status,paid_at=EXCLUDED.paid_at,receipt_url=EXCLUDED.receipt_url`,
      [sub.shop_id,sub.id,invoice.id,number,amt,invoice.status==='paid'?'PAID':'ISSUED',invoice.short_url||null,JSON.stringify(invoice)]);
    }
   }
   await c.query('UPDATE subscription_webhook_events SET processed_at=NOW() WHERE provider_event_id=$1',[eventId]);
   await c.query('COMMIT');s.json({received:true,processed:Boolean(found.rowCount)});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }));
 r.post('/admin/shops/:shopId/billing-members',...admin,wrap(async(q,s)=>{const shopId=validId(q.params.shopId),userId=validId(q.body?.userId),role=q.body?.role;if(!shopId||!userId||!['SHOP_OWNER','BILLING_ADMIN'].includes(role))return s.status(400).json({error:'Valid shopId, userId and role are required.'});const out=await pool.query('INSERT INTO shop_billing_members(shop_id,user_id,role,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,user_id) DO UPDATE SET role=EXCLUDED.role RETURNING id,shop_id,user_id,role',[shopId,userId,role,q.user.id]);s.status(201).json({member:out.rows[0]});}));
 r.delete('/admin/shops/:shopId/billing-members/:userId',...admin,wrap(async(q,s)=>{const shopId=validId(q.params.shopId),userId=validId(q.params.userId);if(!shopId||!userId)return s.status(400).json({error:'Invalid ids.'});const out=await pool.query('DELETE FROM shop_billing_members WHERE shop_id=$1 AND user_id=$2 RETURNING id',[shopId,userId]);s.json({removed:Boolean(out.rowCount)});}));
 r.post('/shops/:shopId/subscription/reconcile',...signed,billing,wrap(async(q,s)=>{
  const current=await pool.query("SELECT * FROM shop_subscriptions WHERE shop_id=$1 AND razorpay_subscription_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",[q.shopId]);
  if(!current.rowCount)return s.status(404).json({error:'No Razorpay subscription found for this shop.'});
  const sub=current.rows[0],allInvoices=[];let skip=0;
  for(let page=0;page<100;page++){
   const result=await provider('/invoices?subscription_id='+encodeURIComponent(sub.razorpay_subscription_id)+'&count=100&skip='+skip);
   const items=Array.isArray(result.items)?result.items:[];
   allInvoices.push(...items);if(items.length<100)break;skip+=items.length;
   if(page===99)throw Object.assign(new Error('Razorpay invoice pagination exceeded the safety limit.'),{status:502});
  }
  const normalized=[];
  for(const inv of allInvoices){
   if(!inv.id)continue;
   let payment=null;
   if(inv.payment_id)payment=await provider('/payments/'+encodeURIComponent(inv.payment_id));
   const paymentStatus=String(payment?.status||'').toLowerCase();
   normalized.push({inv,payment,paymentStatus});
  }
  const c=await pool.connect();let paymentCount=0,invoiceCount=0;
  try{await c.query('BEGIN');await c.query("SELECT id FROM shop_subscriptions WHERE id=$1 FOR UPDATE",[sub.id]);
   for(const {inv,payment,paymentStatus} of normalized){
    if(payment?.id&&['captured','failed','refunded'].includes(paymentStatus)){
     const mapped={captured:'CAPTURED',failed:'FAILED',refunded:'REFUNDED'}[paymentStatus];
     await c.query(`INSERT INTO subscription_payments(shop_id,subscription_id,razorpay_payment_id,razorpay_invoice_id,amount_paise,status,failure_reason,paid_at,provider_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='CAPTURED' THEN to_timestamp(NULLIF($8,'')::numeric) END,$9::jsonb)
      ON CONFLICT(razorpay_payment_id) DO UPDATE SET status=EXCLUDED.status,failure_reason=EXCLUDED.failure_reason,paid_at=COALESCE(EXCLUDED.paid_at,subscription_payments.paid_at),provider_payload=EXCLUDED.provider_payload`,
      [sub.shop_id,sub.id,payment.id,inv.id,Math.max(0,Number(payment.amount||inv.amount||0)),mapped,payment.error_description||null,String(payment.created_at||''),JSON.stringify(payment)]);
     paymentCount++;
    }
    const invoiceStatus=inv.status==='paid'?'PAID':['cancelled','expired'].includes(inv.status)?'VOID':'ISSUED';
    await c.query(`INSERT INTO subscription_invoices(shop_id,subscription_id,provider_invoice_id,invoice_number,amount_paise,status,paid_at,receipt_url,invoice_payload)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='PAID' THEN to_timestamp(NULLIF($7,'')::numeric) END,$8,$9::jsonb)
     ON CONFLICT(provider_invoice_id) DO UPDATE SET status=EXCLUDED.status,paid_at=COALESCE(EXCLUDED.paid_at,subscription_invoices.paid_at),receipt_url=COALESCE(EXCLUDED.receipt_url,subscription_invoices.receipt_url),invoice_payload=EXCLUDED.invoice_payload`,
     [sub.shop_id,sub.id,inv.id,String(inv.invoice_number||('RZP-'+inv.id)),Math.max(0,Number(inv.amount||0)),invoiceStatus,String(inv.paid_at||''),inv.short_url||null,JSON.stringify(inv)]);
    invoiceCount++;
   }
   await c.query('COMMIT');s.json({reconciled:true,payments:paymentCount,invoices:invoiceCount,pages:Math.ceil(allInvoices.length/100)});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }));
 return r;
}
module.exports={createSubscriptionRouter};
