-- BarberPro retention, queue, deposit, privacy and retail completion.
-- Additive only: preserve all existing production rows and workflows.

ALTER TABLE shop_customer_profiles
  ADD COLUMN IF NOT EXISTS preferred_staff_id BIGINT,
  ADD COLUMN IF NOT EXISTS preferred_service_id BIGINT,
  ADD COLUMN IF NOT EXISTS care_notes TEXT,
  ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS photo_consent_at TIMESTAMPTZ;

ALTER TABLE shop_inventory_items
  ADD COLUMN IF NOT EXISTS retail_price_paise BIGINT NOT NULL DEFAULT 0
    CHECK (retail_price_paise >= 0);

ALTER TABLE sales_invoice_lines
  ADD COLUMN IF NOT EXISTS inventory_item_id BIGINT REFERENCES shop_inventory_items(id) ON DELETE RESTRICT;

ALTER TABLE shop_message_templates
  ADD COLUMN IF NOT EXISTS provider_template_language VARCHAR(16) NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS provider_template_status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK (provider_template_status IN ('PENDING','APPROVED','REJECTED')),
  ADD COLUMN IF NOT EXISTS provider_approval_reference VARCHAR(120);

CREATE TABLE IF NOT EXISTS shop_appointment_policies (
  shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  deposits_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  deposit_type VARCHAR(10) NOT NULL DEFAULT 'PERCENT'
    CHECK (deposit_type IN ('FIXED','PERCENT')),
  deposit_value INTEGER NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  cancellation_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (cancellation_window_hours BETWEEN 0 AND 720),
  cancellation_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (cancellation_fee_paise >= 0),
  no_show_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (no_show_fee_paise >= 0),
  google_review_url TEXT,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (deposit_type <> 'PERCENT' OR deposit_value <= 100)
);

CREATE TABLE IF NOT EXISTS appointment_extra_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('DEPOSIT','CANCELLATION_FEE','NO_SHOW_FEE')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  provider_order_id VARCHAR(100) UNIQUE,
  provider_payment_id VARCHAR(100) UNIQUE,
  status VARCHAR(16) NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','AUTHORIZED','PAID','FAILED','REFUNDED','WAIVED')),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (appointment_id,payment_type)
);

CREATE TABLE IF NOT EXISTS shop_waitlist_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  preferred_staff_id BIGINT,
  preferred_date DATE NOT NULL,
  preferred_from TIME,
  preferred_to TIME,
  status VARCHAR(12) NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','OFFERED','BOOKED','EXPIRED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (preferred_to IS NULL OR preferred_from IS NULL OR preferred_to > preferred_from)
);
-- 030_growth_queue_privacy.sql is the canonical initial waitlist schema.
-- Keep both generations of column names in sync while older and newer
-- application paths are being consolidated.
ALTER TABLE shop_waitlist_entries
  ADD COLUMN IF NOT EXISTS preferred_date DATE,
  ADD COLUMN IF NOT EXISTS preferred_from TIME,
  ADD COLUMN IF NOT EXISTS preferred_to TIME;

UPDATE shop_waitlist_entries
SET preferred_date=COALESCE(preferred_date,requested_date),
    preferred_from=COALESCE(preferred_from,preferred_time_start),
    preferred_to=COALESCE(preferred_to,preferred_time_end)
WHERE preferred_date IS NULL
   OR preferred_from IS DISTINCT FROM preferred_time_start
   OR preferred_to IS DISTINCT FROM preferred_time_end;

CREATE OR REPLACE FUNCTION sync_shop_waitlist_legacy_window()
RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.requested_date := COALESCE(NEW.requested_date,NEW.preferred_date);
    NEW.preferred_date := COALESCE(NEW.preferred_date,NEW.requested_date);
    NEW.preferred_time_start := COALESCE(NEW.preferred_time_start,NEW.preferred_from);
    NEW.preferred_from := COALESCE(NEW.preferred_from,NEW.preferred_time_start);
    NEW.preferred_time_end := COALESCE(NEW.preferred_time_end,NEW.preferred_to);
    NEW.preferred_to := COALESCE(NEW.preferred_to,NEW.preferred_time_end);
  ELSE
    IF NEW.requested_date IS DISTINCT FROM OLD.requested_date
       AND NEW.preferred_date IS NOT DISTINCT FROM OLD.preferred_date THEN
      NEW.preferred_date := NEW.requested_date;
    ELSIF NEW.preferred_date IS DISTINCT FROM OLD.preferred_date
       AND NEW.requested_date IS NOT DISTINCT FROM OLD.requested_date THEN
      NEW.requested_date := NEW.preferred_date;
    END IF;
    IF NEW.preferred_time_start IS DISTINCT FROM OLD.preferred_time_start
       AND NEW.preferred_from IS NOT DISTINCT FROM OLD.preferred_from THEN
      NEW.preferred_from := NEW.preferred_time_start;
    ELSIF NEW.preferred_from IS DISTINCT FROM OLD.preferred_from
       AND NEW.preferred_time_start IS NOT DISTINCT FROM OLD.preferred_time_start THEN
      NEW.preferred_time_start := NEW.preferred_from;
    END IF;
    IF NEW.preferred_time_end IS DISTINCT FROM OLD.preferred_time_end
       AND NEW.preferred_to IS NOT DISTINCT FROM OLD.preferred_to THEN
      NEW.preferred_to := NEW.preferred_time_end;
    ELSIF NEW.preferred_to IS DISTINCT FROM OLD.preferred_to
       AND NEW.preferred_time_end IS NOT DISTINCT FROM OLD.preferred_time_end THEN
      NEW.preferred_time_end := NEW.preferred_to;
    END IF;
  END IF;
  RETURN NEW;
END $body$;

DROP TRIGGER IF EXISTS shop_waitlist_window_compatibility ON shop_waitlist_entries;
CREATE TRIGGER shop_waitlist_window_compatibility
BEFORE INSERT OR UPDATE OF requested_date,preferred_date,preferred_time_start,preferred_from,preferred_time_end,preferred_to
ON shop_waitlist_entries
FOR EACH ROW EXECUTE FUNCTION sync_shop_waitlist_legacy_window();

CREATE INDEX IF NOT EXISTS waitlist_match_idx
  ON shop_waitlist_entries(shop_id,service_id,preferred_date,status,created_at);

CREATE TABLE IF NOT EXISTS shop_waitlist_offers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  waitlist_entry_id BIGINT NOT NULL REFERENCES shop_waitlist_entries(id) ON DELETE CASCADE,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'OFFERED'
    CHECK (status IN ('OFFERED','ACCEPTED','DECLINED','EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS waitlist_offer_expiry_idx
  ON shop_waitlist_offers(status,expires_at);

CREATE TABLE IF NOT EXISTS shop_customer_rebooking_profiles (
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interval_days INTEGER NOT NULL DEFAULT 21 CHECK (interval_days BETWEEN 7 AND 365),
  last_visit_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop_id,customer_id)
);
CREATE INDEX IF NOT EXISTS rebooking_due_idx
  ON shop_customer_rebooking_profiles(next_due_at) WHERE enabled=TRUE;

CREATE TABLE IF NOT EXISTS shop_customer_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  photo_kind VARCHAR(12) NOT NULL CHECK (photo_kind IN ('BEFORE','AFTER')),
  private_asset_url TEXT NOT NULL,
  consent_recorded_at TIMESTAMPTZ NOT NULL,
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_photos_lookup_idx
  ON shop_customer_photos(shop_id,customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS shop_review_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  channel VARCHAR(12) NOT NULL CHECK (channel IN ('EMAIL','SMS','WHATSAPP')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(appointment_id,channel)
);

CREATE TABLE IF NOT EXISTS shop_queue_displays (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  label VARCHAR(80) NOT NULL DEFAULT 'Live queue',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_privacy_consent_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(40) NOT NULL,
  consent BOOLEAN NOT NULL,
  notice_version VARCHAR(40) NOT NULL,
  source VARCHAR(30) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS privacy_consent_history_idx
  ON shop_privacy_consent_events(shop_id,customer_id,recorded_at DESC);

CREATE TABLE IF NOT EXISTS shop_data_rights_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type VARCHAR(12) NOT NULL CHECK (request_type IN ('EXPORT','ERASURE')),
  status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','IDENTITY_REVIEW','IN_PROGRESS','COMPLETED','DECLINED')),
  reason TEXT,
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS data_rights_requests_idx
  ON shop_data_rights_requests(shop_id,status,created_at);

CREATE TABLE IF NOT EXISTS shop_ai_booking_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','CONFIRMED','EXPIRED','CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS ai_booking_proposal_expiry_idx
  ON shop_ai_booking_proposals(status,expires_at);

ALTER TABLE shop_customer_reminders
  ADD COLUMN IF NOT EXISTS related_entity_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS related_entity_id BIGINT;

ALTER TABLE shop_customer_rebooking_profiles
  ADD COLUMN IF NOT EXISTS interval_source VARCHAR(10) NOT NULL DEFAULT 'AUTO'
    CHECK (interval_source IN ('AUTO','MANUAL')),
  ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;

ALTER TABLE shop_stock_movements DROP CONSTRAINT IF EXISTS shop_stock_movements_movement_type_check;
ALTER TABLE shop_stock_movements ADD CONSTRAINT shop_stock_movements_movement_type_check
  CHECK (movement_type IN ('OPENING','PURCHASE','ADJUSTMENT','CONSUMPTION','RETURN','SALE'));

ALTER TABLE shop_inventory_items
  ADD COLUMN IF NOT EXISTS retail_hsn_sac_code VARCHAR(8),
  ADD COLUMN IF NOT EXISTS retail_tax_rate_bps INTEGER NOT NULL DEFAULT 0
    CHECK (retail_tax_rate_bps BETWEEN 0 AND 10000);
