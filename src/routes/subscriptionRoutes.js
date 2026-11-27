const express = require('express');
const rateLimit = require('express-rate-limit');
const { createAuthMiddleware } = require('../auth/middleware');

function createSubscriptionRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const admin = [authenticate, requireRole('ADMIN')];
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

  router.get('/subscription/plans', asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT id,code,name,description,price_monthly_paise,price_yearly_paise,max_branches,max_staff_per_branch,features,trial_days FROM subscription_plans WHERE is_active=TRUE ORDER BY display_order,id');
    return res.json({ plans: result.rows });
  }));

  router.get('/shops/:shopId/subscription', ...admin, limiter, asyncRoute(async (req, res) => {
    if (!validId(req.params.shopId)) return res.status(400).json({ error: 'Valid shopId is required.' });
    const result = await pool.query(
      `SELECT ss.id,ss.shop_id,ss.status,ss.billing_cycle,ss.starts_at,ss.trial_ends_at,ss.current_period_start,ss.current_period_end,ss.cancel_at_period_end,ss.cancelled_at,ss.provider,ss.provider_subscription_id,sp.code AS plan_code,sp.name AS plan_name,sp.price_monthly_paise,sp.price_yearly_paise,sp.max_branches,sp.max_staff_per_branch,sp.features
       FROM shop_subscriptions ss JOIN subscription_plans sp ON sp.id=ss.plan_id
       WHERE ss.shop_id=$1 AND ss.status IN ('TRIALING','ACTIVE','PAST_DUE','PENDING_PAYMENT')
       ORDER BY ss.created_at DESC LIMIT 1`, [Number(req.params.shopId)]);
    if (!result.rowCount) return res.status(404).json({ error: 'No current subscription found for this shop.' });
    return res.json({ subscription: result.rows[0] });
  }));

  router.post('/shops/:shopId/subscription/trial', ...admin, limiter, asyncRoute(async (req, res) => {
    if (!validId(req.params.shopId)) return res.status(400).json({ error: 'Valid shopId is required.' });
    const code = typeof req.body?.planCode === 'string' ? req.body.planCode.trim().toUpperCase() : 'STARTER';
    if (!['STARTER','GROWTH','BUSINESS'].includes(code)) return res.status(400).json({ error: 'Choose STARTER, GROWTH or BUSINESS.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shop = await client.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE FOR UPDATE', [Number(req.params.shopId)]);
      if (!shop.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active shop not found.' }); }
      const current = await client.query(`SELECT ss.id,sp.code FROM shop_subscriptions ss JOIN subscription_plans sp ON sp.id=ss.plan_id WHERE ss.shop_id=$1 AND ss.status IN ('TRIALING','ACTIVE','PAST_DUE','PENDING_PAYMENT') FOR UPDATE OF ss`, [Number(req.params.shopId)]);
      if (current.rowCount && current.rows[0].code !== 'FREE') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Shop already has a current subscription.' }); }
      const plan = await client.query('SELECT id,trial_days FROM subscription_plans WHERE code=$1 AND is_active=TRUE', [code]);
      if (!plan.rowCount || Number(plan.rows[0].trial_days)<1) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Selected plan has no trial.' }); }
      const args = [Number(req.params.shopId),plan.rows[0].id,Number(plan.rows[0].trial_days),JSON.stringify({startedBy:req.user.id,planCode:code})];
      const created = current.rowCount
        ? await client.query(`UPDATE shop_subscriptions SET plan_id=$2,status='TRIALING',billing_cycle='MONTHLY',starts_at=NOW(),trial_ends_at=NOW()+($3::text||' days')::interval,current_period_start=NOW(),current_period_end=NOW()+($3::text||' days')::interval,cancel_at_period_end=FALSE,cancelled_at=NULL,metadata=$4::jsonb,updated_at=NOW() WHERE id=$5 RETURNING id,shop_id,status,billing_cycle,starts_at,trial_ends_at,current_period_start,current_period_end`, [plan.rows[0].id,plan.rows[0].id,Number(plan.rows[0].trial_days),args[3],current.rows[0].id])
        : await client.query(`INSERT INTO shop_subscriptions (shop_id,plan_id,status,billing_cycle,starts_at,trial_ends_at,current_period_start,current_period_end,metadata) VALUES ($1,$2,'TRIALING','MONTHLY',NOW(),NOW()+($3::text||' days')::interval,NOW(),NOW()+($3::text||' days')::interval,$4::jsonb) RETURNING id,shop_id,status,billing_cycle,starts_at,trial_ends_at,current_period_start,current_period_end`, args);
      await client.query('COMMIT');
      return res.status(201).json({ subscription: created.rows[0], message: 'Trial started.' });
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); if(error.code==='23505') return res.status(409).json({error:'Current subscription conflict.'}); throw error; }
    finally { client.release(); }
  }));

  router.post('/shops/:shopId/subscription/subscribe', ...admin, limiter, asyncRoute(async (req, res) => {
    if (!validId(req.params.shopId)) return res.status(400).json({ error: 'Valid shopId is required.' });
    const code = typeof req.body?.planCode === 'string' ? req.body.planCode.trim().toUpperCase() : '';
    const cycle = typeof req.body?.billingCycle === 'string' ? req.body.billingCycle.trim().toUpperCase() : 'MONTHLY';
    if (!['STARTER','GROWTH','BUSINESS'].includes(code) || !['MONTHLY','YEARLY'].includes(cycle)) return res.status(400).json({ error: 'Choose a paid plan and MONTHLY or YEARLY billingCycle.' });
    const plan = await pool.query('SELECT id,price_monthly_paise,price_yearly_paise FROM subscription_plans WHERE code=$1 AND is_active=TRUE', [code]);
    if (!plan.rowCount) return res.status(400).json({ error: 'Plan unavailable.' });
    const amount = Number(cycle==='YEARLY'?plan.rows[0].price_yearly_paise:plan.rows[0].price_monthly_paise);
    if (!Number.isSafeInteger(amount) || amount<=0) return res.status(400).json({ error: 'Billing price unavailable.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shop = await client.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE FOR UPDATE', [Number(req.params.shopId)]);
      if (!shop.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active shop not found.' }); }
      const current = await client.query(`SELECT ss.id,sp.code FROM shop_subscriptions ss JOIN subscription_plans sp ON sp.id=ss.plan_id WHERE ss.shop_id=$1 AND ss.status IN ('TRIALING','ACTIVE','PAST_DUE','PENDING_PAYMENT') FOR UPDATE OF ss`, [Number(req.params.shopId)]);
      if (current.rowCount && current.rows[0].code!=='FREE') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Shop already has a current subscription.' }); }
      const months=cycle==='YEARLY'?12:1;
      const metadata=JSON.stringify({createdBy:req.user.id,planCode:code,amountPaise:amount,paymentProvider:'not_configured'});
      const created=current.rowCount
        ? await client.query(`UPDATE shop_subscriptions SET plan_id=$1,status='PENDING_PAYMENT',billing_cycle=$2,starts_at=NOW(),trial_ends_at=NULL,current_period_start=NOW(),current_period_end=NOW()+($3::text||' months')::interval,cancel_at_period_end=FALSE,cancelled_at=NULL,metadata=$4::jsonb,updated_at=NOW() WHERE id=$5 RETURNING id,shop_id,status,billing_cycle,current_period_start,current_period_end`,[plan.rows[0].id,cycle,months,metadata,current.rows[0].id])
        : await client.query(`INSERT INTO shop_subscriptions (shop_id,plan_id,status,billing_cycle,starts_at,current_period_start,current_period_end,metadata) VALUES ($1,$2,'PENDING_PAYMENT',$3,NOW(),NOW(),NOW()+($4::text||' months')::interval,$5::jsonb) RETURNING id,shop_id,status,billing_cycle,current_period_start,current_period_end`,[Number(req.params.shopId),plan.rows[0].id,cycle,months,metadata]);
      await client.query('COMMIT');
      return res.status(201).json({ subscription:created.rows[0],amountPaise:amount,currency:'INR',message:'Created pending subscription. Provider checkout and verified activation are not yet enabled; do not treat this as paid.' });
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); if(error.code==='23505') return res.status(409).json({error:'Current subscription conflict.'}); throw error; }
    finally { client.release(); }
  }));

  router.patch('/shops/:shopId/subscription/cancel', ...admin, limiter, asyncRoute(async (req,res) => {
    if (!validId(req.params.shopId)) return res.status(400).json({error:'Valid shopId is required.'});
    const result=await pool.query(`UPDATE shop_subscriptions SET cancel_at_period_end=TRUE,cancelled_at=NOW(),updated_at=NOW() WHERE shop_id=$1 AND status IN ('TRIALING','ACTIVE','PAST_DUE') RETURNING id,shop_id,status,cancel_at_period_end,cancelled_at,current_period_end`,[Number(req.params.shopId)]);
    if(!result.rowCount) return res.status(404).json({error:'No cancellable subscription found.'});
    return res.json({subscription:result.rows[0],message:'Cancellation scheduled at period end.'});
  }));

  router.post('/subscription/refresh-expired', ...admin, limiter, asyncRoute(async (req,res) => {
    const result=await pool.query('SELECT barberpro_refresh_subscription_status() AS expired_count');
    return res.json({expiredCount:Number(result.rows[0].expired_count)});
  }));
  return router;
}
module.exports={createSubscriptionRouter};
