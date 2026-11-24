'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {createAuthMiddleware}=require('../auth/middleware');

function createCommercialRouter(pool,tokenService){
 const router=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokenService);
 const admin=[authenticate,requireRole('ADMIN')],signed=[authenticate];
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
 const id=v=>/^[1-9]\d*$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T00:00:00Z'));
 const audit=async(client,shopId,actor,action,type,entityId,metadata={})=>client.query(
  'INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
  [shopId,actor,action,type,entityId==null?null:String(entityId),JSON.stringify(metadata)]);

 router.post('/admin/shops/:shopId/membership-plans',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{};
  if(!shopId||typeof b.name!=='string'||!b.name.trim()||b.name.length>120||!Number.isSafeInteger(b.pricePaise)||b.pricePaise<1||
   !Number.isInteger(b.validityDays)||b.validityDays<1||b.validityDays>730||
   (b.includedVisits!==undefined&&b.includedVisits!==null&&(!Number.isInteger(b.includedVisits)||b.includedVisits<1))||
   !Number.isInteger(b.discountBps??0)||(b.discountBps??0)<0||(b.discountBps??0)>10000)
   return res.status(400).json({error:'Provide a plan name, positive price, validity and valid optional visit/discount limits.'});
  const r=await pool.query(`INSERT INTO shop_membership_plans(shop_id,name,price_paise,validity_days,included_visits,discount_bps)
   SELECT id,$2,$3,$4,$5,$6 FROM shops WHERE id=$1 AND is_active=TRUE RETURNING *`,
   [shopId,b.name.trim(),b.pricePaise,b.validityDays,b.includedVisits??null,b.discountBps??0]);
  if(!r.rowCount)return res.status(404).json({error:'Active shop not found.'});
  await pool.query('INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)',
   [shopId,req.user.id,'MEMBERSHIP_PLAN_CREATED','membership_plan',r.rows[0].id]);
  res.status(201).json({plan:r.rows[0]});
 }));
 router.get('/admin/shops/:shopId/membership-plans',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  const r=await pool.query('SELECT * FROM shop_membership_plans WHERE shop_id=$1 ORDER BY created_at DESC',[shopId]);res.json({plans:r.rows});
 }));
 router.post('/admin/shops/:shopId/customers/:customerId/memberships',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),customerId=id(req.params.customerId),planId=id(req.body?.planId),startsAt=req.body?.startsAt;
  if(!shopId||!customerId||!planId||!date(startsAt))return res.status(400).json({error:'Provide shop, customer, plan and start date.'});
  const plan=await pool.query('SELECT * FROM shop_membership_plans WHERE id=$1 AND shop_id=$2 AND is_active=TRUE',[planId,shopId]);
  if(!plan.rowCount)return res.status(404).json({error:'Active membership plan not found.'});
  const p=plan.rows[0],expires=new Date(Date.parse(startsAt+'T00:00:00Z')+(Number(p.validity_days)-1)*86400000).toISOString().slice(0,10);
  const r=await pool.query(`INSERT INTO shop_customer_memberships(shop_id,customer_id,plan_id,starts_at,expires_at,visits_remaining)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[shopId,customerId,planId,startsAt,expires,p.included_visits]);
  await pool.query('INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)',
   [shopId,req.user.id,'MEMBERSHIP_ASSIGNED','customer_membership',r.rows[0].id]);
  res.status(201).json({membership:r.rows[0]});
 }));
 router.get('/admin/shops/:shopId/customers/:customerId/memberships',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),customerId=id(req.params.customerId);
  if(!shopId||!customerId)return res.status(400).json({error:'Invalid shop or customer id.'});
  const r=await pool.query(`SELECT m.*,p.name plan_name,p.discount_bps FROM shop_customer_memberships m
   JOIN shop_membership_plans p ON p.id=m.plan_id AND p.shop_id=m.shop_id
   WHERE m.shop_id=$1 AND m.customer_id=$2 ORDER BY m.created_at DESC`,[shopId,customerId]);
  res.json({memberships:r.rows});
 }));

 router.post('/admin/shops/:shopId/customers/:customerId/wallet/adjust',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),customerId=id(req.params.customerId),b=req.body||{};
  if(!shopId||!customerId||!Number.isSafeInteger(b.amountPaise)||b.amountPaise===0||Math.abs(b.amountPaise)>100000000||
   !['CREDIT','DEBIT','REFUND'].includes(b.type)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>240||
   ((b.type==='DEBIT')!==(b.amountPaise<0)))return res.status(400).json({error:'Provide a signed amount, matching CREDIT/DEBIT/REFUND type and reason.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   await c.query('INSERT INTO shop_customer_wallets(shop_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[shopId,customerId]);
   const w=await c.query('SELECT balance_paise FROM shop_customer_wallets WHERE shop_id=$1 AND customer_id=$2 FOR UPDATE',[shopId,customerId]);
   const next=Number(w.rows[0].balance_paise)+b.amountPaise;if(next<0){await c.query('ROLLBACK');return res.status(409).json({error:'Wallet balance is insufficient.'})}
   await c.query('UPDATE shop_customer_wallets SET balance_paise=$3,updated_at=NOW() WHERE shop_id=$1 AND customer_id=$2',[shopId,customerId,next]);
   const t=await c.query(`INSERT INTO shop_wallet_transactions(shop_id,customer_id,amount_paise,transaction_type,reason,created_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[shopId,customerId,b.amountPaise,b.type,b.reason.trim(),req.user.id]);
   await audit(c,shopId,req.user.id,'WALLET_ADJUSTED','wallet_transaction',t.rows[0].id,{amountPaise:b.amountPaise,type:b.type});
   await c.query('COMMIT');res.status(201).json({balancePaise:next,transaction:t.rows[0]});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 router.get('/admin/shops/:shopId/customers/:customerId/wallet',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),customerId=id(req.params.customerId);
  const r=await pool.query('SELECT balance_paise FROM shop_customer_wallets WHERE shop_id=$1 AND customer_id=$2',[shopId,customerId]);
  const t=await pool.query('SELECT amount_paise,transaction_type,reason,created_at FROM shop_wallet_transactions WHERE shop_id=$1 AND customer_id=$2 ORDER BY id DESC LIMIT 100',[shopId,customerId]);
  res.json({balancePaise:Number(r.rows[0]?.balance_paise||0),transactions:t.rows});
 }));
 router.post('/admin/shops/:shopId/gift-vouchers',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{};
  if(!shopId||!Number.isSafeInteger(b.valuePaise)||b.valuePaise<100||b.valuePaise>100000000||
   (b.expiresAt!==undefined&&b.expiresAt!==null&&!date(b.expiresAt)))return res.status(400).json({error:'Provide a valid voucher value and optional expiry date.'});
  const code=crypto.randomBytes(8).toString('hex').toUpperCase(),hash=crypto.createHash('sha256').update(code).digest('hex');
  const r=await pool.query(`INSERT INTO shop_gift_vouchers(shop_id,code_hash,code_last4,issued_value_paise,balance_paise,expires_at,issued_to_customer_id,created_by)
   VALUES($1,$2,$3,$4,$4,$5,$6,$7) RETURNING id,shop_id,code_last4,issued_value_paise,balance_paise,expires_at,status`,
   [shopId,hash,code.slice(-4),b.valuePaise,b.expiresAt??null,id(b.customerId)||null,req.user.id]);
  await pool.query('INSERT INTO shop_audit_events(shop_id,actor_user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)',
   [shopId,req.user.id,'GIFT_VOUCHER_ISSUED','gift_voucher',r.rows[0].id]);
  res.status(201).json({voucher:r.rows[0],redeemCode:code,message:'Store this code securely; only its SHA-256 hash is retained.'});
 }));
 router.post('/admin/shops/:shopId/gift-vouchers/redeem',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),code=typeof req.body?.code==='string'?req.body.code.trim().toUpperCase():'',amount=req.body?.amountPaise;
  if(!shopId||!/^[A-F0-9]{16}$/.test(code)||!Number.isSafeInteger(amount)||amount<1)return res.status(400).json({error:'Provide a valid voucher code and positive redemption amount.'});
  const hash=crypto.createHash('sha256').update(code).digest('hex'),c=await pool.connect();
  try{await c.query('BEGIN');const v=await c.query('SELECT * FROM shop_gift_vouchers WHERE shop_id=$1 AND code_hash=$2 FOR UPDATE',[shopId,hash]);
   if(!v.rowCount||v.rows[0].status!=='ACTIVE'||(v.rows[0].expires_at&&new Date(v.rows[0].expires_at)<new Date())){await c.query('ROLLBACK');return res.status(404).json({error:'Active voucher not found.'})}
   const next=Number(v.rows[0].balance_paise)-amount;if(next<0){await c.query('ROLLBACK');return res.status(409).json({error:'Voucher balance is insufficient.'})}
   const r=await c.query("UPDATE shop_gift_vouchers SET balance_paise=$2,status=CASE WHEN $2=0 THEN 'REDEEMED' ELSE 'ACTIVE' END WHERE id=$1 RETURNING id,code_last4,balance_paise,status",[v.rows[0].id,next]);
   await audit(c,shopId,req.user.id,'GIFT_VOUCHER_REDEEMED','gift_voucher',r.rows[0].id,{amountPaise:amount});
   await c.query('COMMIT');res.json({voucher:r.rows[0],redeemedPaise:amount});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 router.post('/customer/appointments/:appointmentId/feedback',...signed,wrap(async(req,res)=>{
  if(req.user.role!=='CUSTOMER')return res.status(403).json({error:'Customer account required.'});
  const appointmentId=id(req.params.appointmentId),rating=req.body?.rating,comment=req.body?.comment;
  if(!appointmentId||!Number.isInteger(rating)||rating<1||rating>5||(comment!==undefined&&(typeof comment!=='string'||comment.length>1500)))return res.status(400).json({error:'Provide a rating from 1 to 5 and optional comment.'});
  const r=await pool.query(`INSERT INTO shop_customer_feedback(shop_id,customer_id,appointment_id,rating,comment)
   SELECT a.shop_id,a.customer_id,a.id,$4,$5 FROM appointments a WHERE a.id=$1 AND a.customer_id=$2 AND a.status='COMPLETED'
   RETURNING id,rating,comment,created_at`,[appointmentId,req.user.id,rating,comment||null]);
  if(!r.rowCount)return res.status(404).json({error:'Completed appointment not found or feedback already submitted.'});
  res.status(201).json({feedback:r.rows[0]});
 }));
 router.get('/admin/shops/:shopId/feedback',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId);if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  const r=await pool.query(`SELECT f.id,f.rating,f.comment,f.created_at,u.name customer_name,a.starts_at
   FROM shop_customer_feedback f JOIN users u ON u.id=f.customer_id JOIN appointments a ON a.id=f.appointment_id
   WHERE f.shop_id=$1 ORDER BY f.created_at DESC LIMIT 300`,[shopId]);res.json({feedback:r.rows});
 }));
 router.post('/admin/shops/:shopId/reminders',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),b=req.body||{},customerId=id(b.customerId),scheduledAt=Date.parse(b.scheduledAt);
  if(!shopId||!customerId||!['EMAIL','SMS','WHATSAPP','IN_APP'].includes(b.channel)||typeof b.templateKey!=='string'||!/^([A-Z_]){2,40}$/.test(b.templateKey)||!Number.isFinite(scheduledAt)||scheduledAt<Date.now()-60000)
   return res.status(400).json({error:'Provide customer, supported channel, template key and future schedule.'});
  const r=await pool.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at)
   SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM appointments WHERE shop_id=$1 AND customer_id=$2)
   RETURNING *`,[shopId,customerId,id(b.appointmentId),b.channel,b.templateKey,new Date(scheduledAt)]);
  if(!r.rowCount)return res.status(404).json({error:'Customer has no appointment history at this shop.'});
  res.status(201).json({reminder:r.rows[0],status:'PENDING',message:'Reminder queued; delivery requires a configured provider worker.'});
 }));
 router.get('/admin/shops/:shopId/payroll-report',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),from=req.query.from,to=req.query.to;
  if(!shopId||!date(from)||!date(to)||from>to)return res.status(400).json({error:'Provide a valid shop and date range.'});
  const r=await pool.query(`SELECT st.id staff_id,st.display_name,
    COUNT(DISTINCT a.id) FILTER(WHERE a.clock_in_at IS NOT NULL)::int attendance_days,
    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(a.clock_out_at,NOW())-a.clock_in_at))/3600),0)::numeric(10,2) hours_worked,
    COALESCE(e.service_sales_paise,0)::bigint service_sales_paise,
    COALESCE(e.commission_paise,0)::bigint commission_paise,
    COALESCE(t.tips_paise,0)::bigint tips_paise,
    COALESCE(e.service_count,0)::int completed_services,
    COALESCE(g.target_sales_paise,0)::bigint target_sales_paise,
    COALESCE(g.target_services,0)::int target_services
   FROM shop_staff st
   LEFT JOIN shop_staff_attendance a ON a.shop_id=st.shop_id AND a.staff_id=st.id AND a.work_date BETWEEN $2::date AND $3::date
   LEFT JOIN LATERAL(SELECT SUM(l.taxable_paise) service_sales_paise,SUM(l.commission_paise) commission_paise,COUNT(*) service_count
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.invoice_id
    WHERE i.shop_id=st.shop_id AND l.staff_id=st.id AND i.issue_date BETWEEN $2::date AND $3::date AND i.status='ISSUED') e ON TRUE
   LEFT JOIN LATERAL(SELECT SUM(l.tip_paise) tips_paise FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.invoice_id
    WHERE i.shop_id=st.shop_id AND l.staff_id=st.id AND i.issue_date BETWEEN $2::date AND $3::date) t ON TRUE
   LEFT JOIN LATERAL(SELECT SUM(target_sales_paise) target_sales_paise,SUM(target_services) target_services
    FROM shop_staff_targets WHERE shop_id=st.shop_id AND staff_id=st.id AND period_start<=$3::date AND period_end>=$2::date) g ON TRUE
   WHERE st.shop_id=$1 GROUP BY st.id,st.display_name,e.service_sales_paise,e.commission_paise,e.service_count,t.tips_paise,g.target_sales_paise,g.target_services
   ORDER BY st.display_name`,[shopId,from,to]);res.json({from,to,staff:r.rows});
 }));
 router.put('/admin/shops/:shopId/staff/:staffId/targets',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),staffId=id(req.params.staffId),b=req.body||{};
  if(!shopId||!staffId||!date(b.periodStart)||!date(b.periodEnd)||b.periodStart>b.periodEnd||
   !Number.isSafeInteger(b.targetSalesPaise)||b.targetSalesPaise<0||!Number.isInteger(b.targetServices)||b.targetServices<0)
   return res.status(400).json({error:'Provide valid target period, sales and service targets.'});
  const r=await pool.query(`INSERT INTO shop_staff_targets(shop_id,staff_id,period_start,period_end,target_sales_paise,target_services,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(shop_id,staff_id,period_start,period_end) DO UPDATE SET
   target_sales_paise=EXCLUDED.target_sales_paise,target_services=EXCLUDED.target_services
   RETURNING *`,[shopId,staffId,b.periodStart,b.periodEnd,b.targetSalesPaise,b.targetServices,req.user.id]);
  res.json({target:r.rows[0]});
 }));
 router.put('/admin/shops/:shopId/services/:serviceId/inventory-recipe',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),serviceId=id(req.params.serviceId),items=req.body?.items;
  if(!shopId||!serviceId||!Array.isArray(items)||items.length>50||items.some(x=>!id(x.itemId)||typeof x.quantityPerService!=='number'||!Number.isFinite(x.quantityPerService)||x.quantityPerService<=0||x.quantityPerService>1000))
   return res.status(400).json({error:'Provide up to 50 valid stock item quantities per service.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const s=await c.query('SELECT id FROM services WHERE id=$1 AND shop_id=$2',[serviceId,shopId]);if(!s.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Service not found in this shop.'})}
   const itemIds=items.map(x=>id(x.itemId));const found=await c.query('SELECT id FROM shop_inventory_items WHERE shop_id=$1 AND id=ANY($2::bigint[]) AND is_active=TRUE',[shopId,itemIds]);
   if(found.rowCount!==new Set(itemIds).size){await c.query('ROLLBACK');return res.status(400).json({error:'Every recipe item must be active in this shop.'})}
   await c.query('DELETE FROM shop_service_inventory_recipes WHERE shop_id=$1 AND service_id=$2',[shopId,serviceId]);
   for(const x of items)await c.query('INSERT INTO shop_service_inventory_recipes(shop_id,service_id,item_id,quantity_per_service) VALUES($1,$2,$3,$4)',[shopId,serviceId,id(x.itemId),x.quantityPerService]);
   await audit(c,shopId,req.user.id,'SERVICE_STOCK_RECIPE_UPDATED','service',serviceId,{items:items.length});
   await c.query('COMMIT');res.json({shopId,serviceId,recipe:items});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 router.get('/admin/shops/:shopId/audit-events',...admin,wrap(async(req,res)=>{
  const shopId=id(req.params.shopId),limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);
  if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
  const r=await pool.query('SELECT id,actor_user_id,action,entity_type,entity_id,metadata,created_at FROM shop_audit_events WHERE shop_id=$1 ORDER BY id DESC LIMIT $2',[shopId,limit]);res.json({events:r.rows});
 }));
 return router;
}
module.exports={createCommercialRouter};
