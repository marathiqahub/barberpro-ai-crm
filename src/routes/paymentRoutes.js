const express = require('express');
const crypto = require('node:crypto');
const { createAuthMiddleware } = require('../auth/middleware');

function createPaymentRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const signedIn = [authenticate];
  const admin = [authenticate, requireRole('ADMIN')];
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const configured = Boolean(keyId && keySecret && webhookSecret);
  const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const safeEqual = (a, b) => {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  };
  const razorpay = async (path, method, body) => {
    if (!keyId || !keySecret) throw Object.assign(new Error('Payment provider is not configured.'), { status: 503 });
    const response = await fetch('https://api.razorpay.com/v1' + path, {
      method, headers: { Authorization: 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.description || 'Payment provider request failed.'), { status: 502 });
    return data;
  };
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.post('/orders', ...signedIn, asyncRoute(async (req, res) => {
    if (req.user.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer account required.' });
    if (!configured) return res.status(503).json({ error: 'Razorpay is not configured. Set test credentials to enable checkout.' });
    const appointmentId = Number(req.body?.appointmentId);
    if (!Number.isSafeInteger(appointmentId) || appointmentId < 1) return res.status(400).json({ error: 'Valid appointmentId is required.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT a.id, a.customer_id, a.status, sv.price
         FROM appointments a JOIN services sv ON sv.id=a.service_id
         WHERE a.id=$1 AND a.customer_id=$2 FOR UPDATE OF a`, [appointmentId, req.user.id]);
      if (!found.rowCount || !['BOOKED','CONFIRMED'].includes(found.rows[0].status)) {
        await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payable appointment not found.' });
      }
      const existing = await client.query('SELECT id, provider_order_id, amount_paise, currency, status FROM payments WHERE appointment_id=$1', [appointmentId]);
      if (existing.rowCount && existing.rows[0].provider_order_id) {
        await client.query('COMMIT');
        return res.json({ payment: existing.rows[0], keyId });
      }
      const amountPaise = Math.round(Number(found.rows[0].price) * 100);
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'Appointment amount must be at least INR 1.' });
      }
      const order = await razorpay('/orders', 'POST', { amount: amountPaise, currency: 'INR', receipt: 'appt_' + appointmentId, notes: { appointmentId: String(appointmentId), customerId: String(req.user.id) } });
      const saved = await client.query(
        `INSERT INTO payments (appointment_id, customer_id, provider_order_id, amount_paise, currency, provider_payload)
         VALUES ($1,$2,$3,$4,'INR',$5::jsonb)
         ON CONFLICT (appointment_id) DO UPDATE SET provider_order_id=EXCLUDED.provider_order_id,
         amount_paise=EXCLUDED.amount_paise, provider_payload=EXCLUDED.provider_payload, status='CREATED', updated_at=NOW()
         RETURNING id, appointment_id, provider_order_id, amount_paise, currency, status`,
        [appointmentId, req.user.id, order.id, amountPaise, JSON.stringify({ order })]);
      await client.query('COMMIT');
      res.status(201).json({ payment: saved.rows[0], keyId, order });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));

  router.post('/verify', ...signedIn, asyncRoute(async (req, res) => {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (![orderId, paymentId, signature].every(v => typeof v === 'string' && v.length < 200)) return res.status(400).json({ error: 'Payment verification fields are required.' });
    const expected = hmac(keySecret || '', orderId + '|' + paymentId);
    if (!keySecret || !safeEqual(expected, signature)) return res.status(400).json({ error: 'Invalid payment signature.' });
    const result = await pool.query(
      `UPDATE payments SET provider_payment_id=$1, status='CAPTURED', updated_at=NOW(),
       provider_payload=provider_payload || $2::jsonb
       WHERE provider_order_id=$3 AND customer_id=$4
       RETURNING id, appointment_id, status`,
      [paymentId, JSON.stringify({ checkoutVerified: true }), orderId, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Payment order not found for this customer.' });
    res.json({ payment: result.rows[0] });
  }));

  router.post('/webhook', express.raw({ type: 'application/json', limit: '256kb' }), asyncRoute(async (req, res) => {
    if (!webhookSecret) return res.status(503).send('Webhook is not configured.');
    const signature = req.get('x-razorpay-signature') || '';
    const expected = hmac(webhookSecret, req.body);
    if (!safeEqual(expected, signature)) return res.status(400).send('Invalid webhook signature.');
    const event = JSON.parse(req.body.toString('utf8'));
    const eventId = req.get('x-razorpay-event-id');
    if (!eventId) return res.status(400).send('Missing event id.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO payment_webhook_events (provider_event_id,event_type,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id',
        [eventId, event.event || 'unknown', JSON.stringify(event)]);
      if (inserted.rowCount) {
        const entity = event.payload?.payment?.entity;
        if (entity?.order_id) {
          const status = event.event === 'payment.captured' ? 'CAPTURED' : event.event === 'payment.failed' ? 'FAILED' : null;
          if (status) await client.query(
            `UPDATE payments SET status=$1, provider_payment_id=COALESCE($2,provider_payment_id),
             provider_payload=provider_payload || $3::jsonb, updated_at=NOW() WHERE provider_order_id=$4`,
            [status, entity.id || null, JSON.stringify({ webhookEvent: event.event }), entity.order_id]);
        }
        const refund = event.payload?.refund?.entity;
        if (refund?.id) await client.query(
          `UPDATE payment_refunds SET status=CASE WHEN $1='refund.processed' THEN 'PROCESSED' WHEN $1='refund.failed' THEN 'FAILED' ELSE status END,
           provider_payload=provider_payload || $2::jsonb, updated_at=NOW() WHERE provider_refund_id=$3`,
          [event.event, JSON.stringify({ webhookEvent: event.event }), refund.id]);
      }
      await client.query('COMMIT');
      res.json({ received: true, duplicate: !inserted.rowCount });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));

  router.post('/:paymentId/refunds', ...admin, asyncRoute(async (req, res) => {
    if (!configured) return res.status(503).json({ error: 'Razorpay is not configured.' });
    const paymentId = Number(req.params.paymentId);
    const amountPaise = req.body?.amountPaise === undefined ? null : Number(req.body.amountPaise);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0,240) : null;
    const payment = await pool.query("SELECT * FROM payments WHERE id=$1 AND status IN ('CAPTURED','PARTIALLY_REFUNDED')", [paymentId]);
    if (!payment.rowCount || !payment.rows[0].provider_payment_id) return res.status(404).json({ error: 'Captured payment not found.' });
    const total = await pool.query("SELECT COALESCE(SUM(amount_paise),0)::bigint AS refunded FROM payment_refunds WHERE payment_id=$1 AND status IN ('PENDING','PROCESSED')", [paymentId]);
    const remaining = Number(payment.rows[0].amount_paise) - Number(total.rows[0].refunded);
    const amount = amountPaise === null ? remaining : amountPaise;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > remaining) return res.status(400).json({ error: 'Refund amount exceeds the remaining captured balance.' });
    const refund = await razorpay('/payments/' + encodeURIComponent(payment.rows[0].provider_payment_id) + '/refunds', 'POST', { amount, notes: { reason: reason || 'Admin initiated refund' } });
    const saved = await pool.query(
      `INSERT INTO payment_refunds (payment_id,provider_refund_id,amount_paise,status,reason,provider_payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [paymentId, refund.id, amount, refund.status === 'processed' ? 'PROCESSED' : 'PENDING', reason, JSON.stringify(refund)]);
    await pool.query("UPDATE payments SET status=CASE WHEN $2 >= amount_paise THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END, updated_at=NOW() WHERE id=$1",
      [paymentId, Number(total.rows[0].refunded) + amount]);
    res.status(201).json({ refund: saved.rows[0] });
  }));

  router.get('/mine', ...signedIn, asyncRoute(async (req,res) => {
    const result = await pool.query('SELECT id,appointment_id,amount_paise,currency,status,created_at FROM payments WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]);
    res.json({ payments: result.rows });
  }));
  router.get('/reconciliation', ...admin, asyncRoute(async (req,res) => {
    const result = await pool.query(
      `SELECT p.id,p.appointment_id,p.provider_order_id,p.provider_payment_id,p.amount_paise,p.currency,p.status,p.created_at,
       COALESCE(SUM(r.amount_paise) FILTER (WHERE r.status IN ('PENDING','PROCESSED')),0)::bigint AS refunded_paise
       FROM payments p LEFT JOIN payment_refunds r ON r.payment_id=p.id
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 500`);
    res.json({ payments: result.rows });
  }));
  return router;
}
module.exports = { createPaymentRouter };
