-- Phase 3: shop-scoped customer CRM, explicit marketing consent, loyalty ledger and campaign drafts.
CREATE TABLE IF NOT EXISTS shop_customer_profiles (
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketing_email_consent BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_sms_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_updated_at TIMESTAMPTZ,
  notes VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop_id,customer_id)
);
CREATE INDEX IF NOT EXISTS shop_customer_profiles_consent_idx
  ON shop_customer_profiles(shop_id,marketing_email_consent,marketing_sms_consent);

CREATE TABLE IF NOT EXISTS shop_loyalty_accounts (
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance_points INTEGER NOT NULL DEFAULT 0 CHECK(balance_points >= 0),
  lifetime_earned_points INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_earned_points >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop_id,customer_id)
);

CREATE TABLE IF NOT EXISTS shop_loyalty_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  points INTEGER NOT NULL CHECK(points <> 0),
  transaction_type VARCHAR(12) NOT NULL CHECK(transaction_type IN ('EARN','REDEEM','ADJUST')),
  reason VARCHAR(240) NOT NULL,
  reference VARCHAR(120),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(shop_id,customer_id) REFERENCES shop_loyalty_accounts(shop_id,customer_id) ON DELETE CASCADE,
  CHECK((transaction_type='EARN' AND points>0) OR (transaction_type='REDEEM' AND points<0) OR transaction_type='ADJUST')
);
CREATE INDEX IF NOT EXISTS shop_loyalty_transactions_customer_idx
  ON shop_loyalty_transactions(shop_id,customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS shop_marketing_campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  channel VARCHAR(12) NOT NULL CHECK(channel IN ('EMAIL','SMS')),
  subject VARCHAR(200),
  message VARCHAR(2000) NOT NULL,
  audience VARCHAR(20) NOT NULL DEFAULT 'ALL_CONSENTED'
    CHECK(audience IN ('ALL_CONSENTED','NO_VISIT_30_DAYS','LOYALTY_MEMBERS')),
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','READY','ARCHIVED')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_marketing_campaigns_shop_idx
  ON shop_marketing_campaigns(shop_id,status,created_at DESC);
