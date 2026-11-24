-- Front-desk access, shop tax configuration, sales documents and GST export foundation.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('ADMIN', 'BARBER', 'FRONT_DESK', 'CUSTOMER'));

CREATE TABLE IF NOT EXISTS shop_front_desk (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, user_id)
);
CREATE INDEX IF NOT EXISTS shop_front_desk_user_idx ON shop_front_desk(user_id, shop_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS shop_tax_profiles (
  shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  gst_registered BOOLEAN NOT NULL DEFAULT FALSE,
  gstin CHAR(15),
  legal_name VARCHAR(200),
  trade_name VARCHAR(200),
  address TEXT,
  state_code CHAR(2),
  invoice_prefix VARCHAR(12) NOT NULL DEFAULT 'BP',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((gst_registered = FALSE AND gstin IS NULL) OR
         (gst_registered = TRUE AND gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' AND state_code ~ '^[0-9]{2}$'))
);

CREATE TABLE IF NOT EXISTS shop_document_sequences (
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('INVOICE','CREDIT_NOTE')),
  financial_year VARCHAR(9) NOT NULL,
  last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (shop_id, document_type, financial_year)
);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  invoice_number VARCHAR(40) NOT NULL,
  financial_year VARCHAR(9) NOT NULL,
  document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('TAX_INVOICE','BILL_OF_SUPPLY')),
  issue_date DATE NOT NULL,
  seller_gstin CHAR(15),
  seller_legal_name VARCHAR(200),
  seller_trade_name VARCHAR(200),
  seller_address TEXT,
  seller_state_code CHAR(2),
  customer_name VARCHAR(160) NOT NULL,
  customer_email VARCHAR(254),
  customer_phone VARCHAR(30),
  customer_gstin CHAR(15),
  place_of_supply_state_code CHAR(2),
  subtotal_paise BIGINT NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise BIGINT NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise BIGINT NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise BIGINT NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise BIGINT NOT NULL CHECK (total_paise >= 0),
  amount_paid_paise BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_paise >= 0),
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_mode IN ('CASH','UPI','CARD','RAZORPAY','MIXED','UNPAID')),
  status VARCHAR(12) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','VOID')),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, invoice_number),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK (amount_paid_paise <= total_paise)
);
CREATE INDEX IF NOT EXISTS sales_invoices_shop_date_idx ON sales_invoices(shop_id, issue_date DESC);

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  description VARCHAR(240) NOT NULL,
  hsn_sac_code VARCHAR(8),
  quantity NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  unit_price_paise BIGINT NOT NULL CHECK (unit_price_paise >= 0),
  discount_paise BIGINT NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  taxable_paise BIGINT NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise BIGINT NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise BIGINT NOT NULL CHECK (total_paise >= 0)
);

CREATE TABLE IF NOT EXISTS sales_credit_notes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  credit_note_number VARCHAR(40) NOT NULL,
  financial_year VARCHAR(9) NOT NULL,
  issue_date DATE NOT NULL,
  reason VARCHAR(240) NOT NULL,
  taxable_paise BIGINT NOT NULL CHECK (taxable_paise >= 0),
  cgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise BIGINT NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise BIGINT NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise BIGINT NOT NULL CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, credit_note_number)
);
CREATE INDEX IF NOT EXISTS sales_credit_notes_shop_date_idx ON sales_credit_notes(shop_id, issue_date DESC);
