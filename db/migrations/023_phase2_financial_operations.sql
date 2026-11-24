-- Phase 2: invoice payment allocations, barber commission snapshots and daily cash close.
ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS staff_id BIGINT REFERENCES shop_staff(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS commission_rate_bps INTEGER NOT NULL DEFAULT 0
    CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS commission_paise BIGINT NOT NULL DEFAULT 0
    CHECK (commission_paise >= 0);

ALTER TABLE shop_staff
  ADD COLUMN IF NOT EXISTS commission_rate_bps INTEGER NOT NULL DEFAULT 0
    CHECK (commission_rate_bps BETWEEN 0 AND 10000);

CREATE TABLE IF NOT EXISTS sales_invoice_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  method VARCHAR(20) NOT NULL CHECK (method IN ('CASH','UPI','CARD','RAZORPAY')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  reference VARCHAR(120),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sales_invoice_payments_received_idx
  ON sales_invoice_payments(received_at DESC);

CREATE TABLE IF NOT EXISTS shop_daily_closures (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  business_date DATE NOT NULL,
  opening_float_paise BIGINT NOT NULL CHECK (opening_float_paise >= 0),
  cash_paid_out_paise BIGINT NOT NULL DEFAULT 0 CHECK (cash_paid_out_paise >= 0),
  cash_deposited_paise BIGINT NOT NULL DEFAULT 0 CHECK (cash_deposited_paise >= 0),
  cash_counted_paise BIGINT NOT NULL CHECK (cash_counted_paise >= 0),
  expected_cash_paise BIGINT NOT NULL CHECK (expected_cash_paise >= 0),
  variance_paise BIGINT NOT NULL,
  note VARCHAR(1000),
  closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop_id,business_date)
);
CREATE INDEX IF NOT EXISTS shop_daily_closures_date_idx
  ON shop_daily_closures(shop_id,business_date DESC);
