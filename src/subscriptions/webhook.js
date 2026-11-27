'use strict';

const crypto = require('node:crypto');

const EVENT_STATUSES = Object.freeze({
  'subscription.activated': 'ACTIVE',
  'subscription.authenticated': 'AUTHENTICATED',
  'subscription.pending': 'PENDING',
  'subscription.halted': 'HALTED',
  'subscription.cancelled': 'CANCELLED',
  'subscription.completed': 'COMPLETED',
  'subscription.expired': 'EXPIRED',
  'subscription.charged': 'ACTIVE'
});

function verifyRazorpayWebhook(secret, rawBody, signature) {
  if (typeof secret !== 'string' || !secret || !Buffer.isBuffer(rawBody)) return false;
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

function normalizeSubscriptionWebhook(event, rawBody) {
  const payload = event && typeof event === 'object' ? event : {};
  const entity = payload.payload?.subscription?.entity;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(JSON.stringify(payload));
  const created = Number(payload.created_at);
  return {
    eventId: typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : crypto.createHash('sha256').update(raw).digest('hex'),
    eventType: typeof payload.event === 'string' ? payload.event : 'unknown',
    subscriptionId: typeof entity?.id === 'string' ? entity.id : null,
    status: EVENT_STATUSES[payload.event] || null,
    providerCreatedAt: Number.isSafeInteger(created) && created > 0
      ? new Date(created * 1000).toISOString()
      : null,
    entity
  };
}

module.exports = { EVENT_STATUSES, verifyRazorpayWebhook, normalizeSubscriptionWebhook };
