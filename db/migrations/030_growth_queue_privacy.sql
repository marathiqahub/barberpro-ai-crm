-- Additive growth, queue, customer preference and data-rights foundation.
CREATE TABLE IF NOT EXISTS shop_booking_policies (
  shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  deposit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  deposit_type VARCHAR(12) NOT NULL DEFAULT 'FIXED' CHECK (deposit_type IN ('FIXED','PERCENT')),
  deposit_value BIGINT NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  cancellation_notice_hours INTEGER NOT NULL DEFAULT 24 CHECK (cancellation_notice_hours BETWEEN 0 AND 720),
  no_show_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (no_show_fee_paise >= 0),
  policy_text VARCHAR(2000),
  google_review_url TEXT,
  review_requests_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (deposit_type <> 'PERCENT' OR deposit_value <= 10000)
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deposit_due_paise BIGINT NOT NULL DEFAULT 0 CHECK (deposit_due_paise >= 0),
  ADD COLUMN IF NOT EXISTS deposit_paid_paise BIGINT NOT NULL DEFAULT 0 CHECK (deposit_paid_paise >= 0),
  ADD COLUMN IF NOT EXISTS no_show_fee_due_paise BIGINT NOT NULL DEFAULT 0 CHECK (no_show_fee_due_paise >= 0),
  ADD COLUMN IF NOT EXISTS no_show_fee_status VARCHAR(12) NOT NULL DEFAULT 'NOT_DUE'
    CHECK (no_show_fee_status IN ('NOT_DUE','DUE','PAID','WAIVED'));

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_purpose VARCHAR(24) NOT NULL DEFAULT 'APPOINTMENT'
    CHECK (payment_purpose IN ('APPOINTMENT','BOOKING_DEPOSIT','NO_SHOW_FEE'));

CREATE INDEX IF NOT EXISTS payments_appointment_purpose_idx ON payments(appointment_id,payment_purpose,status);

CREATE TABLE IF NOT EXISTS shop_waitlist_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL,
  preferred_staff_id BIGINT,
  requested_date DATE NOT NULL,
  preferred_time_start TIME,
  preferred_time_end TIME,
  status VARCHAR(12) NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING','OFFERED','BOOKED','EXPIRED','CANCELLED')),
  offered_staff_id BIGINT,
  offered_starts_at TIMESTAMPTZ,
  offered_ends_at TIMESTAMPTZ,
  offer_expires_at TIMESTAMPTZ,
  accepted_appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(shop_id,service_id) REFERENCES services(shop_id,id),
  FOREIGN KEY(shop_id,preferred_staff_id) REFERENCES shop_staff(shop_id,id),
  FOREIGN KEY(shop_id,offered_staff_id) REFERENCES shop_staff(shop_id,id),
  CHECK (preferred_time_start IS NULL OR preferred_time_end IS NULL OR preferred_time_start < preferred_time_end)
);
CREATE INDEX IF NOT EXISTS shop_waitlist_match_idx
  ON shop_waitlist_entries(shop_id,service_id,requested_date,created_at)
  WHERE status='WAITING';

ALTER TABLE shop_customer_profiles
  ADD COLUMN IF NOT EXISTS preferred_staff_id BIGINT,
  ADD COLUMN IF NOT EXISTS preferred_service_id BIGINT,
  ADD COLUMN IF NOT EXISTS preferred_interval_days INTEGER CHECK(preferred_interval_days BETWEEN 7 AND 180),
  ADD COLUMN IF NOT EXISTS skin_notes VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS allergy_notes VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS photo_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS before_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS after_photo_url TEXT;
DO $$ BEGIN
  ALTER TABLE shop_customer_profiles ADD CONSTRAINT shop_customer_profiles_preferred_staff_fk
    FOREIGN KEY(shop_id,preferred_staff_id) REFERENCES shop_staff(shop_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE shop_customer_profiles ADD CONSTRAINT shop_customer_profiles_preferred_service_fk
    FOREIGN KEY(shop_id,preferred_service_id) REFERENCES services(shop_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS shop_data_rights_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT REFERENCES shops(id) ON DELETE SET NULL,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_type VARCHAR(12) NOT NULL CHECK(request_type IN ('EXPORT','DELETE')),
  status VARCHAR(16) NOT NULL DEFAULT 'REQUESTED'
    CHECK(status IN ('REQUESTED','IN_REVIEW','COMPLETED','REJECTED')),
  reason VARCHAR(1000),
  resolution_note VARCHAR(1000),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shop_data_rights_customer_idx
  ON shop_data_rights_requests(customer_id,requested_at DESC);

CREATE TABLE IF NOT EXISTS shop_review_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  channel VARCHAR(12) NOT NULL CHECK(channel IN ('EMAIL','SMS','WHATSAPP')),
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SENT','FAILED','CANCELLED')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(appointment_id,channel)
);
CREATE INDEX IF NOT EXISTS shop_review_requests_due_idx
  ON shop_review_requests(status,scheduled_at) WHERE status='PENDING';

ALTER TABLE shop_customer_reminders
  ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(160);
CREATE UNIQUE INDEX IF NOT EXISTS shop_customer_reminders_dedupe_idx
  ON shop_customer_reminders(dedupe_key) WHERE dedupe_key IS NOT NULL;
