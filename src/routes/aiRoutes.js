const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[1-9]\d*$/;

function validDate(value) {
  return typeof value === 'string' && DATE_RE.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00.000Z')) &&
    new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
}

function createAiRouter(pool, tokenService, options = {}) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const admin = [authenticate, requireRole('ADMIN')];
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const fetchImpl = options.fetchImpl || global.fetch;
  const env = options.env || process.env;

  router.post('/admin/ai/insights', ...admin, asyncRoute(async (req, res) => {
    const { from, to, shopId: rawShopId = null, question = 'Review business performance and recommend the highest-impact actions for the next 7 days.' } = req.body || {};
    const shopId = rawShopId === null || rawShopId === '' ? null :
      (ID_RE.test(String(rawShopId)) ? Number(rawShopId) : NaN);
    if (!validDate(from) || !validDate(to) || from > to ||
        (shopId !== null && !Number.isSafeInteger(shopId)) ||
        typeof question !== 'string' || question.trim().length < 8 || question.trim().length > 500) {
      return res.status(400).json({ error: 'Provide valid from/to dates, an optional positive shopId, and a question between 8 and 500 characters.' });
    }

    if (!env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI insights are not configured. Add OPENAI_API_KEY to the Render service environment.' });
    }

    const metrics = await pool.query(
      `WITH appointment_metrics AS (
         SELECT a.shop_id,
           COUNT(*)::int AS appointments,
           COUNT(*) FILTER (WHERE a.status='COMPLETED')::int AS completed,
           COUNT(*) FILTER (WHERE a.status='CANCELLED')::int AS cancelled,
           COUNT(*) FILTER (WHERE a.status='NO_SHOW')::int AS no_shows,
           COUNT(*) FILTER (WHERE a.status IN ('BOOKED','CONFIRMED'))::int AS upcoming
         FROM appointments a JOIN shops s ON s.id=a.shop_id
         WHERE (a.starts_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
         GROUP BY a.shop_id
       ), refund_totals AS (
         SELECT payment_id,SUM(amount_paise)::bigint AS refunded_paise
         FROM payment_refunds WHERE status='PROCESSED' GROUP BY payment_id
       ), revenue_metrics AS (
         SELECT a.shop_id,
           COALESCE(SUM(p.amount_paise-COALESCE(r.refunded_paise,0))
             FILTER (WHERE p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')),0)::bigint AS net_captured_revenue_paise
         FROM appointments a JOIN shops s ON s.id=a.shop_id
         LEFT JOIN payments p ON p.appointment_id=a.id
         LEFT JOIN refund_totals r ON r.payment_id=p.id
         WHERE (a.starts_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
         GROUP BY a.shop_id
       )
       SELECT s.id AS shop_id,s.name AS shop_name,s.timezone,s.is_active,
         COALESCE(a.appointments,0)::int AS appointments,
         COALESCE(a.completed,0)::int AS completed,
         COALESCE(a.cancelled,0)::int AS cancelled,
         COALESCE(a.no_shows,0)::int AS no_shows,
         COALESCE(a.upcoming,0)::int AS upcoming,
         COALESCE(r.net_captured_revenue_paise,0)::bigint AS net_captured_revenue_paise
       FROM shops s LEFT JOIN appointment_metrics a ON a.shop_id=s.id
       LEFT JOIN revenue_metrics r ON r.shop_id=s.id
       WHERE ($3::bigint IS NULL OR s.id=$3)
       ORDER BY s.name`,
      [from, to, shopId]
    );
    if (shopId !== null && !metrics.rowCount) return res.status(404).json({ error: 'Shop not found.' });

    const services = await pool.query(
      `SELECT s.id AS shop_id,s.name AS shop_name,v.name AS service_name,
              COUNT(a.id)::int AS bookings
       FROM shops s JOIN services v ON v.shop_id=s.id
       LEFT JOIN appointments a ON a.service_id=v.id AND
         (a.starts_at AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
       WHERE ($3::bigint IS NULL OR s.id=$3)
       GROUP BY s.id,s.name,v.id,v.name
       ORDER BY bookings DESC,s.name,v.name LIMIT 15`,
      [from, to, shopId]
    );

    const context = {
      period: { from, to },
      shopScope: shopId === null ? 'all shops' : 'one selected shop',
      shops: metrics.rows.map(row => ({
        ...row,
        net_captured_revenue_inr: Number(row.net_captured_revenue_paise) / 100
      })),
      popularServices: services.rows
    };

    const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    let providerResponse;
    try {
      providerResponse = await fetchImpl(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.OPENAI_API_KEY,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model: env.OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are BarberPro, an operations analyst for a barber-shop CRM. Analyze only the supplied aggregate metrics. Do not invent missing facts or claim causation. Revenue is net captured payments after processed refunds, not catalogue sales. Return valid JSON with keys: summary (string), risks (array of strings), opportunities (array of strings), actions (array of objects with priority, action, reason). Keep recommendations specific, measurable, respectful, and practical. Never request or infer customer personal data.'
            },
            {
              role: 'user',
              content: JSON.stringify({ question: question.trim(), crmData: context })
            }
          ]
        })
      });
      if (!providerResponse.ok) {
        const status = providerResponse.status;
        return res.status(status === 429 ? 503 : 502).json({
          error: status === 429 ? 'AI provider rate limit reached. Try again shortly.' : 'AI provider could not complete the analysis.'
        });
      }
      const payload = await providerResponse.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(502).json({ error: 'AI provider returned an empty analysis.' });
      }
      let analysis;
      try { analysis = JSON.parse(content); }
      catch { analysis = { summary: content, risks: [], opportunities: [], actions: [] }; }
      return res.json({
        generatedAt: new Date().toISOString(),
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        scope: context.shopScope,
        period: context.period,
        analysis
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return res.status(504).json({ error: 'AI analysis timed out. Please retry.' });
      }
      throw error;
    }
  }));

  return router;
}

module.exports = { createAiRouter };
