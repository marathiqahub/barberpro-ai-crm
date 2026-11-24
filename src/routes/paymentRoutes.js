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
        `SELECT a.id,a.customer_id,a.status,a.deposit_paid_paise,a.no_show_fee_due_paise,a.no_show_fee_status,sv.price,
          bp.deposit_enabled,bp.deposit_type,bp.deposit_value
         FROM appointments a JOIN services sv ON sv.id=a.service_id LEFT JOIN shop_booking_policies bp ON bp.shop_id=a.shop_id
         WHERE a.id=$1 AND a.customer_id=$2 FOR UPDATE OF a`, [appointmentId, req.user.id]);
      if (!found.rowCount || (!['BOOKED','CONFIRMED','COMPLETED'].includes(found.rows[0].status) && !(found.rows[0].status==='NO_SHOW' && req.body?.paymentPurpose==='NO_SHOW_FEE'))) {
        await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payable appointment not found.' });
      }
      const purpose = req.body?.paymentPurpose === 'NO_SHOW_FEE' ? 'NO_SHOW_FEE' :
        req.body?.paymentPurpose === 'APPOINTMENT' ? 'APPOINTMENT' :
        (found.rows[0].deposit_enabled ? 'BOOKING_DEPOSIT' : 'APPOINTMENT');
      if (purpose === 'NO_SHOW_FEE' && found.rows[0].no_show_fee_status !== 'DUE') {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'No-show fee is not due for this appointment.' });
      }
      const existing = await client.query('SELECT id, provider_order_id, amount_paise, currency, status, provider_payload FROM payments WHERE appointment_id=$1 AND payment_purpose=$2', [appointmentId,purpose]);
      if (existing.rowCount && existing.rows[0].provider_order_id) {
        await client.query('COMMIT');
        return res.json({ payment: existing.rows[0], keyId, order: existing.rows[0].provider_payload?.order || null });
      }
      const serviceAmountPaise = Math.round(Number(found.rows[0].price) * 100);
      const policyDeposit = found.rows[0].deposit_type === 'PERCENT'
        ? Math.round(serviceAmountPaise * Number(found.rows[0].deposit_value || 0) / 10000)
        : Number(found.rows[0].deposit_value || 0);
      const amountPaise = purpose === 'NO_SHOW_FEE' ? Number(found.rows[0].no_show_fee_due_paise) :
        purpose === 'BOOKING_DEPOSIT' ? Math.min(serviceAmountPaise,policyDeposit) : Math.max(0,serviceAmountPaise-Number(found.rows[0].deposit_paid_paise||0));
      if (purpose === 'BOOKING_DEPOSIT') await client.query('UPDATE appointments SET deposit_due_paise=$2 WHERE id=$1',[appointmentId,amountPaise]);
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) {
        await client.query('ROLLBACK'); return res.status(400).json({ error: 'Appointment amount must be at least INR 1.' });
      }
      const order = await razorpay('/orders', 'POST', { amount: amountPaise, currency: 'INR', receipt: 'appt_' + appointmentId + '_' + purpose.toLowerCase(), notes: { appointmentId: String(appointmentId), customerId: String(req.user.id), paymentPurpose: purpose } });
      const saved = await client.query(
        `INSERT INTO payments (appointment_id,customer_id,provider_order_id,amount_paise,currency,provider_payload,payment_purpose)
         VALUES ($1,$2,$3,$4,'INR',$5::jsonb,$6)
         ON CONFLICT (appointment_id,payment_purpose) DO UPDATE SET provider_order_id=EXCLUDED.provider_order_id,
         amount_paise=EXCLUDED.amount_paise,provider_payload=EXCLUDED.provider_payload,status='CREATED',updated_at=NOW()
         RETURNING id,appointment_id,provider_order_id,amount_paise,currency,status,payment_purpose`,
        [appointmentId,req.user.id,order.id,amountPaise,JSON.stringify({order}),purpose]);
      await client.query('COMMIT');
      res.status(201).json({ payment: saved.rows[0], keyId, order });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));

  router.post('/verify', ...signedIn, asyncRoute(async (req, res) => {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (![orderId, paymentId, signature].every(v => typeof v === 'string' && v.length < 200)) return res.status(400).json({ error: 'Payment verification fields are required.' });
    if (req.user.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer account required.' });
    const expected = hmac(keySecret || '', orderId + '|' + paymentId);
    if (!keySecret || !safeEqual(expected, signature)) return res.status(400).json({ error: 'Invalid payment signature.' });
    const existing = await pool.query(
      `SELECT id, appointment_id, provider_order_id, amount_paise, currency, status
       FROM payments WHERE provider_order_id=$1 AND customer_id=$2`,
      [orderId, req.user.id]);
    if (!existing.rowCount) return res.status(404).json({ error: 'Payment order not found for this customer.' });
    const providerPayment = await razorpay('/payments/' + encodeURIComponent(paymentId), 'GET');
    if (providerPayment.order_id !== orderId ||
        Number(providerPayment.amount) !== Number(existing.rows[0].amount_paise) ||
        providerPayment.currency !== existing.rows[0].currency) {
      return res.status(400).json({ error: 'Provider payment does not match this order.' });
    }
    const providerStatus = providerPayment.status;
    if (!['authorized','captured','failed'].includes(providerStatus)) {
      return res.status(409).json({ error: 'Payment is not in a final verifiable state.', providerStatus });
    }
    const status = providerStatus === 'captured' ? 'CAPTURED' : providerStatus === 'authorized' ? 'AUTHORIZED' : 'FAILED';
    const result = await pool.query(
      `UPDATE payments SET provider_payment_id=$1,
       status=CASE WHEN status IN ('CAPTURED','REFUNDED','PARTIALLY_REFUNDED') THEN status
                   WHEN $2='CAPTURED' THEN 'CAPTURED' ELSE $2 END,
       provider_payload=provider_payload || $3::jsonb, updated_at=NOW()
       WHERE provider_order_id=$4 AND customer_id=$5
       RETURNING id,appointment_id,payment_purpose,status`,
      [paymentId, status, JSON.stringify({ checkoutVerified: true, providerStatus }), orderId, req.user.id]);
    if (result.rows[0]?.status === 'CAPTURED') {
      if (result.rows[0].payment_purpose === 'BOOKING_DEPOSIT') await pool.query('UPDATE appointments SET deposit_paid_paise=GREATEST(deposit_paid_paise,$2),updated_at=NOW() WHERE id=$1',[result.rows[0].appointment_id,existing.rows[0].amount_paise]);
      if (result.rows[0].payment_purpose === 'APPOINTMENT') await pool.query('UPDATE appointments SET deposit_paid_paise=GREATEST(deposit_paid_paise,deposit_due_paise),updated_at=NOW() WHERE id=$1',[result.rows[0].appointment_id]);
      if (result.rows[0].payment_purpose === 'NO_SHOW_FEE') await pool.query("UPDATE appointments SET no_show_fee_status='PAID',updated_at=NOW() WHERE id=$1",[result.rows[0].appointment_id]);
    }
    res.json({ payment: result.rows[0], providerStatus });
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
          const status = event.event === 'payment.captured' ? 'CAPTURED' : event.event === 'payment.authorized' ? 'AUTHORIZED' : event.event === 'payment.failed' ? 'FAILED' : null;
          if (status) await client.query(
            `UPDATE payments SET status=CASE WHEN status IN ('CAPTURED','REFUNDED','PARTIALLY_REFUNDED') THEN status
               WHEN $1='CAPTURED' THEN 'CAPTURED' ELSE $1 END,
             provider_payment_id=COALESCE($2,provider_payment_id),
             provider_payload=provider_payload || $3::jsonb, updated_at=NOW() WHERE provider_order_id=$4`,
            [status, entity.id || null, JSON.stringify({ webhookEvent: event.event }), entity.order_id]);
        }
        const refund = event.payload?.refund?.entity;
        if (refund?.id) {
          const updatedRefund = await client.query(
            `UPDATE payment_refunds SET status=CASE WHEN $1='refund.processed' THEN 'PROCESSED' WHEN $1='refund.failed' THEN 'FAILED' ELSE status END,
             provider_payload=provider_payload || $2::jsonb, updated_at=NOW()
             WHERE provider_refund_id=$3 RETURNING payment_id`,
            [event.event, JSON.stringify({ webhookEvent: event.event }), refund.id]);
          if (event.event === 'refund.processed' && updatedRefund.rowCount) {
            await client.query(
              `UPDATE payments p SET status=CASE
                 WHEN (SELECT COALESCE(SUM(r.amount_paise),0) FROM payment_refunds r
                       WHERE r.payment_id=p.id AND r.status='PROCESSED') >= p.amount_paise THEN 'REFUNDED'
                 ELSE 'PARTIALLY_REFUNDED' END, updated_at=NOW()
               WHERE p.id=$1 AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')`,
              [updatedRefund.rows[0].payment_id]);
            const refundedPayment=await client.query('SELECT appointment_id,payment_purpose FROM payments WHERE id=$1',[updatedRefund.rows[0].payment_id]);
            if(refundedPayment.rowCount&&['BOOKING_DEPOSIT','APPOINTMENT'].includes(refundedPayment.rows[0].payment_purpose)){
              await client.query(`UPDATE appointments a SET deposit_paid_paise=LEAST(a.deposit_due_paise,
                COALESCE((SELECT SUM(GREATEST(0,p.amount_paise-COALESCE((SELECT SUM(r.amount_paise) FROM payment_refunds r WHERE r.payment_id=p.id AND r.status='PROCESSED'),0)))
                  FROM payments p WHERE p.appointment_id=a.id AND p.payment_purpose IN('BOOKING_DEPOSIT','APPOINTMENT') AND p.status IN('CAPTURED','PARTIALLY_REFUNDED')),0)),updated_at=NOW()
                WHERE a.id=$1`,[refundedPayment.rows[0].appointment_id]);
            }
            if(refundedPayment.rowCount&&refundedPayment.rows[0].payment_purpose==='NO_SHOW_FEE'){
              await client.query(`UPDATE appointments SET no_show_fee_status=CASE WHEN $2>0 THEN 'DUE' ELSE 'NOT_DUE' END,updated_at=NOW()
                WHERE id=$1`,[refundedPayment.rows[0].appointment_id,Number((await client.query('SELECT no_show_fee_due_paise FROM appointments WHERE id=$1',[refundedPayment.rows[0].appointment_id])).rows[0]?.no_show_fee_due_paise||0)]);
            }
          }
        }
      }
      await client.query(`UPDATE appointments a SET
        deposit_paid_paise=CASE WHEN p.payment_purpose='BOOKING_DEPOSIT' AND p.status='CAPTURED' THEN GREATEST(a.deposit_paid_paise,p.amount_paise) WHEN p.payment_purpose='APPOINTMENT' AND p.status='CAPTURED' THEN GREATEST(a.deposit_paid_paise,a.deposit_due_paise) ELSE a.deposit_paid_paise END,
        no_show_fee_status=CASE WHEN p.payment_purpose='NO_SHOW_FEE' AND p.status='CAPTURED' THEN 'PAID' ELSE a.no_show_fee_status END,
        updated_at=CASE WHEN p.status='CAPTURED' AND p.payment_purpose IN('BOOKING_DEPOSIT','NO_SHOW_FEE') THEN NOW() ELSE a.updated_at END
        FROM payments p WHERE p.appointment_id=a.id AND p.provider_order_id=(SELECT event.payload->'payload'->'payment'->'entity'->>'order_id' FROM payment_webhook_events event WHERE event.provider_event_id=$1)
      `,[eventId]);
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
    if (refund.status === 'processed') {
      await pool.query(
        `UPDATE payments p SET status=CASE
           WHEN (SELECT COALESCE(SUM(r.amount_paise),0) FROM payment_refunds r
                 WHERE r.payment_id=p.id AND r.status='PROCESSED') >= p.amount_paise THEN 'REFUNDED'
           ELSE 'PARTIALLY_REFUNDED' END, updated_at=NOW()
         WHERE p.id=$1 AND p.status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')`,
        [paymentId]);
    }
    res.status(201).json({ refund: saved.rows[0] });
  }));

  router.get('/mine', ...signedIn, asyncRoute(async (req,res) => {
    const result = await pool.query('SELECT p.id,p.appointment_id,p.amount_paise,p.currency,p.status,p.payment_purpose,p.created_at,
      COALESCE((SELECT SUM(r.amount_paise) FROM payment_refunds r WHERE r.payment_id=p.id AND r.status='PROCESSED'),0)::bigint refunded_amount_paise
      FROM payments p WHERE p.customer_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]);
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
