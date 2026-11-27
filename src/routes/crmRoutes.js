const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');
const { validateLoyaltyTransaction, nextLoyaltyBalance, campaignCanBePrepared } = require('../crm/rules');

function createCrmRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const admin = [authenticate, requireRole('ADMIN')];
  const asyncRoute = handler => (req,res,next) => Promise.resolve(handler(req,res,next)).catch(next);
  const id = value => /^[1-9]\\d*$/.test(String(value)) ? Number(value) : null;

  async function activeShop(shopId) {
    const result = await pool.query('SELECT id FROM shops WHERE id=$1 AND is_active=TRUE',[shopId]);
    return result.rowCount > 0;
  }

  router.get('/admin/shops/:shopId/customers', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId), search=typeof req.query.search==='string'?req.query.search.trim().slice(0,100):'';
    if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
    if(!await activeShop(shopId))return res.status(404).json({error:'Active shop not found.'});
    const result=await pool.query(
      `SELECT u.id customer_id,u.name,u.email,
        COUNT(DISTINCT a.id)::int appointment_count,
        COUNT(DISTINCT a.id) FILTER(WHERE a.status='COMPLETED')::int completed_visits,
        MAX(a.starts_at) last_visit,
        COALESCE(la.balance_points,0)::int loyalty_points,
        COALESCE(cp.marketing_email_consent,FALSE) marketing_email_consent,
        COALESCE(cp.marketing_sms_consent,FALSE) marketing_sms_consent,
        cp.notes
       FROM users u
       LEFT JOIN appointments a ON a.customer_id=u.id AND a.shop_id=$1
       LEFT JOIN shop_customer_profiles cp ON cp.shop_id=$1 AND cp.customer_id=u.id
       LEFT JOIN shop_loyalty_accounts la ON la.shop_id=$1 AND la.customer_id=u.id
       WHERE u.role='CUSTOMER' AND (a.id IS NOT NULL OR cp.customer_id IS NOT NULL) AND ($2='' OR u.name ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
       GROUP BY u.id,u.name,u.email,la.balance_points,cp.marketing_email_consent,cp.marketing_sms_consent,cp.notes
       ORDER BY last_visit DESC NULLS LAST,u.name LIMIT 500`,[shopId,search]);
    res.json({shopId,customers:result.rows});
  }));

  router.put('/admin/shops/:shopId/customers/:customerId/profile', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),customerId=id(req.params.customerId),b=req.body||{};
    if(!shopId||!customerId||typeof b.marketingEmailConsent!=='boolean'||
       typeof b.marketingSmsConsent!=='boolean'||(b.notes!==undefined&&(typeof b.notes!=='string'||b.notes.length>2000)))
      return res.status(400).json({error:'Provide valid consent choices and notes.'});
    if(!await activeShop(shopId))return res.status(404).json({error:'Active shop not found.'});
    const customer=await pool.query(`SELECT 1 FROM users u WHERE u.id=$2 AND u.role='CUSTOMER' AND (EXISTS(SELECT 1 FROM appointments WHERE shop_id=$1 AND customer_id=$2) OR EXISTS(SELECT 1 FROM shop_customer_profiles WHERE shop_id=$1 AND customer_id=$2))`,[shopId,customerId]);
    if(!customer.rowCount)return res.status(404).json({error:'Customer is not linked to this shop.'});
    const result=await pool.query(
      `INSERT INTO shop_customer_profiles(shop_id,customer_id,marketing_email_consent,marketing_sms_consent,consent_updated_at,notes)
       VALUES($1,$2,$3,$4,NOW(),$5)
       ON CONFLICT(shop_id,customer_id) DO UPDATE SET
        marketing_email_consent=EXCLUDED.marketing_email_consent,
        marketing_sms_consent=EXCLUDED.marketing_sms_consent,
        consent_updated_at=NOW(),notes=EXCLUDED.notes,updated_at=NOW()
       RETURNING shop_id,customer_id,marketing_email_consent,marketing_sms_consent,consent_updated_at,notes`,
      [shopId,customerId,b.marketingEmailConsent,b.marketingSmsConsent,b.notes??null]);
    await pool.query(`INSERT INTO shop_customer_consent_events(shop_id,customer_id,purpose,channel,consent,notice_version,source)
      VALUES($1,$2,'MARKETING','EMAIL',$3,'v1','ADMIN_CRM'),($1,$2,'MARKETING','SMS',$4,'v1','ADMIN_CRM')`,
      [shopId,customerId,b.marketingEmailConsent,b.marketingSmsConsent]);
    res.json({profile:result.rows[0]});
  }));

  router.post('/admin/shops/:shopId/customers/:customerId/loyalty', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),customerId=id(req.params.customerId),b=req.body||{};
    const points=b.points, type=b.transactionType, reason=typeof b.reason==='string'?b.reason.trim():'';
    if(!shopId||!customerId||!validateLoyaltyTransaction(points,type,reason))
      return res.status(400).json({error:'Provide non-zero whole points, a matching transaction type and reason.'});
    if(!await activeShop(shopId))return res.status(404).json({error:'Active shop not found.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const booking=await client.query('SELECT 1 FROM appointments WHERE shop_id=$1 AND customer_id=$2 LIMIT 1',[shopId,customerId]);
      if(!booking.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Customer has no booking history at this shop.'});}
      await client.query(`INSERT INTO shop_loyalty_accounts(shop_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[shopId,customerId]);
      const account=await client.query('SELECT balance_points FROM shop_loyalty_accounts WHERE shop_id=$1 AND customer_id=$2 FOR UPDATE',[shopId,customerId]);
      let next;
      try{next=nextLoyaltyBalance(Number(account.rows[0].balance_points),points);}
      catch(error){await client.query('ROLLBACK');return res.status(400).json({error:error.message});}
      await client.query(
        `UPDATE shop_loyalty_accounts SET balance_points=$3,
         lifetime_earned_points=lifetime_earned_points+CASE WHEN $4='EARN' THEN $5 ELSE 0 END,updated_at=NOW()
         WHERE shop_id=$1 AND customer_id=$2`,[shopId,customerId,next,type,Math.max(points,0)]);
      const transaction=await client.query(
        `INSERT INTO shop_loyalty_transactions(shop_id,customer_id,points,transaction_type,reason,created_by)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[shopId,customerId,points,type,reason,req.user.id]);
      await client.query('COMMIT');
      res.status(201).json({transaction:transaction.rows[0],balancePoints:next});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }));

  router.get('/admin/shops/:shopId/customers/:customerId/loyalty', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),customerId=id(req.params.customerId);
    if(!shopId||!customerId)return res.status(400).json({error:'Invalid shop or customer id.'});
    const result=await pool.query(
      `SELECT a.balance_points,a.lifetime_earned_points,
       COALESCE(json_agg(json_build_object('id',t.id,'points',t.points,'type',t.transaction_type,'reason',t.reason,'createdAt',t.created_at) ORDER BY t.created_at DESC)
       FILTER(WHERE t.id IS NOT NULL),'[]'::json) transactions
       FROM shop_loyalty_accounts a LEFT JOIN shop_loyalty_transactions t
        ON t.shop_id=a.shop_id AND t.customer_id=a.customer_id
       WHERE a.shop_id=$1 AND a.customer_id=$2 GROUP BY a.shop_id,a.customer_id`,[shopId,customerId]);
    res.json({loyalty:result.rows[0]||{balance_points:0,lifetime_earned_points:0,transactions:[]}});
  }));

  router.get('/admin/shops/:shopId/campaigns', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId);
    if(!shopId)return res.status(400).json({error:'Invalid shop id.'});
    const result=await pool.query(
      `SELECT c.*,
       (SELECT COUNT(*)::int FROM shop_customer_profiles p
        WHERE p.shop_id=c.shop_id
          AND ((c.channel='EMAIL' AND p.marketing_email_consent=TRUE) OR (c.channel='SMS' AND p.marketing_sms_consent=TRUE))
          AND (c.audience<>'NO_VISIT_30_DAYS' OR NOT EXISTS(
            SELECT 1 FROM appointments a WHERE a.shop_id=p.shop_id AND a.customer_id=p.customer_id
              AND a.status='COMPLETED' AND a.starts_at>=NOW()-INTERVAL '30 days'))
          AND (c.audience<>'LOYALTY_MEMBERS' OR EXISTS(
            SELECT 1 FROM shop_loyalty_accounts la WHERE la.shop_id=p.shop_id AND la.customer_id=p.customer_id AND la.balance_points>0))) eligible_consent_count
       FROM shop_marketing_campaigns c WHERE c.shop_id=$1 ORDER BY c.created_at DESC LIMIT 100`,[shopId]);
    res.json({campaigns:result.rows});
  }));

  router.post('/admin/shops/:shopId/campaigns', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),b=req.body||{};
    const name=typeof b.name==='string'?b.name.trim():'',message=typeof b.message==='string'?b.message.trim():'';
    const channel=b.channel,audience=b.audience||'ALL_CONSENTED',subject=typeof b.subject==='string'?b.subject.trim():null;
    if(!shopId||!name||name.length>160||!message||message.length>2000||
       !campaignCanBePrepared(channel,subject,message,audience))
      return res.status(400).json({error:'Provide a valid campaign name, channel, email subject when applicable, message and audience.'});
    if(!await activeShop(shopId))return res.status(404).json({error:'Active shop not found.'});
    const result=await pool.query(
      `INSERT INTO shop_marketing_campaigns(shop_id,name,channel,subject,message,audience,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [shopId,name,channel,subject,message,audience,req.user.id]);
    res.status(201).json({campaign:result.rows[0]});
  }));

  router.patch('/admin/shops/:shopId/campaigns/:campaignId', ...admin, asyncRoute(async(req,res)=>{
    const shopId=id(req.params.shopId),campaignId=id(req.params.campaignId),status=req.body?.status;
    if(!shopId||!campaignId||!['DRAFT','READY','ARCHIVED'].includes(status))
      return res.status(400).json({error:'Status must be DRAFT, READY or ARCHIVED.'});
    const result=await pool.query(
      `UPDATE shop_marketing_campaigns SET status=$3,updated_at=NOW()
       WHERE id=$1 AND shop_id=$2 RETURNING *`,[campaignId,shopId,status]);
    if(!result.rowCount)return res.status(404).json({error:'Campaign not found for this shop.'});
    res.json({campaign:result.rows[0],deliveryPerformed:false});
  }));
  return router;
}
module.exports={createCrmRouter};
