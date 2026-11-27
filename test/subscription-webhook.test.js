'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  EVENT_STATUSES,
  verifyRazorpayWebhook,
  normalizeSubscriptionWebhook
} = require('../src/subscriptions/webhook');

test('Razorpay webhook signature validates the exact raw request bytes', () => {
  const secret = 'test-webhook-secret';
  const raw = Buffer.from('{"event":"subscription.activated"}');
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyRazorpayWebhook(secret, raw, signature), true);
  assert.equal(verifyRazorpayWebhook(secret, Buffer.from(raw.toString() + ' '), signature), false);
  assert.equal(verifyRazorpayWebhook(secret, raw, 'not-a-signature'), false);
  assert.equal(verifyRazorpayWebhook('', raw, signature), false);
  assert.equal(verifyRazorpayWebhook(secret, null, signature), false);
});

test('subscription webhook maps provider events to known lifecycle states', () => {
  assert.equal(EVENT_STATUSES['subscription.activated'], 'ACTIVE');
  assert.equal(EVENT_STATUSES['subscription.charged'], 'ACTIVE');
  assert.equal(EVENT_STATUSES['subscription.halted'], 'HALTED');
  assert.equal(EVENT_STATUSES['subscription.expired'], 'EXPIRED');
  assert.equal(EVENT_STATUSES['subscription.unknown'], undefined);
});

test('webhook normalization preserves provider event identity and timestamps', () => {
  const raw = Buffer.from('provider-payload');
  const event = {
    id: 'evt_test_123',
    event: 'subscription.activated',
    created_at: 1795800000,
    payload: { subscription: { entity: { id: 'sub_test_123', current_start: 1795800000 } } }
  };
  const normalized = normalizeSubscriptionWebhook(event, raw);
  assert.equal(normalized.eventId, 'evt_test_123');
  assert.equal(normalized.eventType, 'subscription.activated');
  assert.equal(normalized.subscriptionId, 'sub_test_123');
  assert.equal(normalized.status, 'ACTIVE');
  assert.equal(normalized.providerCreatedAt, new Date(1795800000 * 1000).toISOString());
});

test('webhook normalization ignores invalid provider timestamps', () => {
  const normalized = normalizeSubscriptionWebhook({ id: 'evt_without_time', event: 'subscription.pending', created_at: 0 }, Buffer.from('{}'));
  assert.equal(normalized.providerCreatedAt, null);
});

test('webhook normalization has a stable raw-body hash when provider event id is absent', () => {
  const raw = Buffer.from('same-raw-body');
  const first = normalizeSubscriptionWebhook({ event: 'subscription.pending' }, raw);
  const second = normalizeSubscriptionWebhook({ event: 'subscription.pending' }, raw);
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.eventId, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(first.subscriptionId, null);
  assert.equal(first.status, 'PENDING');
});
