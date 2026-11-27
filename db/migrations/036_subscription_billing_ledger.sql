-- Commercial billing ledger, shop-scoped billing roles and webhook idempotency.
CREATE TABLE IF NOT EXISTS shop_billing_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('SHOP_OWNER','BILLING_ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(shop_id,user_id)
);
CREATE INDEX IF NOT EXISTS shop_billing_members_user_idx ON shop_billing_members(user_id,shop_id);

CREATE TABLE IF NOT EXISTS subscription_webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_event_id VARCHAR(160) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS subscription_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id BIGINT REFERENCES shop_subscriptions(id) ON DELETE SET NULL,
  razorpay_payment_id VARCHAR(100) NOT NULL UNIQUE,
  razorpay_invoice_id VARCHAR(100),
  amount_paise BIGINT NOT NULL CHECK(amount_paise>=0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL CHECK(status IN ('CAPTURED','FAILED','REFUNDED')),
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subscription_payments_shop_idx ON subscription_payments(shop_id,created_at DESC);
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id BIGINT REFERENCES shop_subscriptions(id) ON DELETE SET NULL,
  payment_id BIGINT REFERENCES subscription_payments(id) ON DELETE SET NULL,
  provider_invoice_id VARCHAR(100) UNIQUE,
  invoice_number VARCHAR(80) NOT NULL UNIQUE,
  amount_paise BIGINT NOT NULL CHECK(amount_paise>=0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK(status IN ('ISSUED','PAID','VOID','FAILED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  receipt_url TEXT,
  invoice_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS subscription_invoices_shop_idx ON subscription_invoices(shop_id,issued_at DESC);

ALTER TABLE shop_subscriptions
  ADD COLUMN IF NOT EXISTS last_payment_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
