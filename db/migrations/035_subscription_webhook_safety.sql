-- Durable webhook idempotency and provider event ordering for SaaS subscriptions.
-- Additive only: existing shops, plans and subscription rows are preserved.
ALTER TABLE shop_subscriptions
  ADD COLUMN IF NOT EXISTS last_webhook_created_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS shop_subscription_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  razorpay_subscription_id VARCHAR(100),
  provider_created_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_subscription_webhook_events_subscription_idx
  ON shop_subscription_webhook_events(razorpay_subscription_id, received_at DESC);

-- A shop may have only one live trial or paid subscription at a time.
DROP INDEX IF EXISTS shop_subscriptions_one_current_idx;
CREATE UNIQUE INDEX shop_subscriptions_one_current_idx
  ON shop_subscriptions(shop_id)
  WHERE status IN('TRIALING','CREATED','AUTHENTICATED','ACTIVE','PENDING');
