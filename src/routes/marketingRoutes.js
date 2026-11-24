const express = require('express');
const rateLimit = require('express-rate-limit');
const { createAuthMiddleware } = require('../auth/middleware');

function createMarketingRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 5,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many demo requests. Try again later.' }
  });

  router.post('/leads', limiter, async (req, res, next) => {
    const body = req.body || {};
    if (typeof body.website === 'string' && body.website.trim()) return res.status(202).json({ received: true });
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const shopName = typeof body.shopName === 'string' ? body.shopName.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!name || name.length > 120 || !shopName || shopName.length > 160 ||
        !/^[+\d().\-\s]{7,20}$/.test(phone) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        !['independent', 'shop', 'multi_outlet'].includes(body.segment) ||
        plan.length > 30 || message.length > 1000 || body.consent !== true) {
      return res.status(400).json({ error: 'Please check the required fields and consent.' });
    }
    try {
      await pool.query(
        'INSERT INTO marketing_leads (name, shop_name, phone, email, segment, plan, message, consent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',
        [name, shopName, phone, email, body.segment, plan || null, message || null]
      );
      return res.status(201).json({ received: true });
    } catch (error) { return next(error); }
  });

  router.get('/leads', authenticate, requireRole('ADMIN'), async (req, res, next) => {
    try {
      const result = await pool.query(
        'SELECT id, name, shop_name, phone, email, segment, plan, message, status, created_at FROM marketing_leads ORDER BY created_at DESC LIMIT 200'
      );
      return res.json({ leads: result.rows });
    } catch (error) { return next(error); }
  });
  return router;
}
module.exports = { createMarketingRouter };
