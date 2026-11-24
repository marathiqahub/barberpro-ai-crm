-- Consolidated completion: payroll/tips/targets, stock recipes, feedback/reminders,
-- memberships, stored-value wallets, gift vouchers and immutable audit events.
ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS tip_paise BIGINT NOT NULL DEFAULT 0 CHECK (tip_paise >= 0);

CREATE TABLE IF NOT EXISTS shop_staff_targets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  target_sales_paise BIGINT NOT NULL DEFAULT 0 CHECK(target_sales_paise>=0),
  target_services INTEGER NOT NULL DEFAULT 0 CHECK(target_services>=0),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(period_end>=period_start),
  FOREIGN KEY(shop_id,staff_id) REFERENCES shop_staff(shop_id,id),
  UNIQUE(shop_id,staff_id,period_start,period_end)
);

CREATE TABLE IF NOT EXISTS shop_service_inventory_recipes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  item_id BIGINT NOT NULL,
  quantity_per_service NUMERIC(12,3) NOT NULL CHECK(quantity_per_service>0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(shop_id,item_id) REFERENCES shop_inventory_items(shop_id,id),
  UNIQUE(shop_id,service_id,item_id)
);

CREATE TABLE IF NOT EXISTS shop_membership_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  price_paise BIGINT NOT NULL CHECK(price_paise>0),
  validity_days INTEGER NOT NULL CHECK(validity_days BETWEEN 1 AND 730),
  included_visits INTEGER CHECK(included_visits IS NULL OR included_visits>0),
  discount_bps INTEGER NOT NULL DEFAULT 0 CHECK(discount_bps BETWEEN 0 AND 10000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop_id,id)
);
CREATE TABLE IF NOT EXISTS shop_customer_memberships (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id BIGINT NOT NULL,
  starts_at DATE NOT NULL,
  expires_at DATE NOT NULL,
  visits_remaining INTEGER,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','EXPIRED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(shop_id,plan_id) REFERENCES shop_membership_plans(shop_id,id),
  CHECK(expires_at>=starts_at),
  CHECK(visits_remaining IS NULL OR visits_remaining>=0)
);
CREATE INDEX IF NOT EXISTS customer_membership_lookup_idx ON shop_customer_memberships(shop_id,customer_id,status,expires_at);

CREATE TABLE IF NOT EXISTS shop_customer_wallets (
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK(balance_paise>=0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop_id,customer_id)
);
CREATE TABLE IF NOT EXISTS shop_wallet_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  amount_paise BIGINT NOT NULL CHECK(amount_paise<>0),
  transaction_type VARCHAR(12) NOT NULL CHECK(transaction_type IN ('CREDIT','DEBIT','REFUND')),
  reason VARCHAR(240) NOT NULL,
  reference VARCHAR(120),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(shop_id,customer_id) REFERENCES shop_customer_wallets(shop_id,customer_id),
  CHECK((transaction_type='DEBIT' AND amount_paise<0) OR (transaction_type IN ('CREDIT','REFUND') AND amount_paise>0))
);

CREATE TABLE IF NOT EXISTS shop_gift_vouchers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  code_last4 CHAR(4) NOT NULL,
  issued_value_paise BIGINT NOT NULL CHECK(issued_value_paise>0),
  balance_paise BIGINT NOT NULL CHECK(balance_paise>=0 AND balance_paise<=issued_value_paise),
  expires_at DATE,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REDEEMED','EXPIRED','CANCELLED')),
  issued_to_customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gift_voucher_shop_status_idx ON shop_gift_vouchers(shop_id,status,expires_at);

CREATE TABLE IF NOT EXISTS shop_customer_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment VARCHAR(1500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(appointment_id,customer_id)
);
CREATE TABLE IF NOT EXISTS shop_customer_reminders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  channel VARCHAR(12) NOT NULL CHECK(channel IN ('EMAIL','SMS','WHATSAPP','IN_APP')),
  template_key VARCHAR(40) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED','CANCELLED')),
  provider_reference VARCHAR(160),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_reminder_queue_idx ON shop_customer_reminders(status,scheduled_at) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS shop_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT REFERENCES shops(id) ON DELETE SET NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_audit_events_shop_date_idx ON shop_audit_events(shop_id,created_at DESC);
