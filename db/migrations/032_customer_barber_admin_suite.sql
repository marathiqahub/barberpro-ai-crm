-- Customer, barber and platform operations completion. Additive and reversible by retention policy.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_locale VARCHAR(2) NOT NULL DEFAULT 'en'
    CHECK (preferred_locale IN ('en','hi','mr')),
  ADD COLUMN IF NOT EXISTS imported_pending_activation BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS cleanup_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (cleanup_minutes BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS chemical_consent_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS shop_reschedule_policies (
  shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  free_reschedule_before_hours INTEGER NOT NULL DEFAULT 4 CHECK(free_reschedule_before_hours BETWEEN 0 AND 720),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_appointment_reschedules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  old_starts_at TIMESTAMPTZ NOT NULL,
  new_starts_at TIMESTAMPTZ NOT NULL,
  free_of_charge BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS appointment_reschedules_lookup_idx
  ON shop_appointment_reschedules(appointment_id,created_at DESC);

CREATE TABLE IF NOT EXISTS shop_appointment_reference_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type VARCHAR(40) NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  image_bytes BYTEA NOT NULL CHECK(octet_length(image_bytes) BETWEEN 1 AND 524288),
  consent_version VARCHAR(40) NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS appointment_reference_photo_retention_idx
  ON shop_appointment_reference_photos(retention_until);

CREATE TABLE IF NOT EXISTS shop_chemical_service_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  answers JSONB NOT NULL,
  signature_name VARCHAR(120) NOT NULL,
  notice_version VARCHAR(40) NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signer_ip INET,
  UNIQUE(appointment_id,customer_id)
);
CREATE INDEX IF NOT EXISTS chemical_consents_shop_signed_idx
  ON shop_chemical_service_consents(shop_id,signed_at DESC);

CREATE TABLE IF NOT EXISTS shop_barber_tips (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
  amount_paise BIGINT NOT NULL CHECK(amount_paise BETWEEN 100 AND 10000000),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  razorpay_payment_link_id VARCHAR(100) UNIQUE,
  razorpay_payment_id VARCHAR(100) UNIQUE,
  short_url TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','PAID','FAILED','EXPIRED')),
  paid_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS barber_tips_earnings_idx
  ON shop_barber_tips(shop_id,staff_id,status,paid_at);

CREATE TABLE IF NOT EXISTS shop_staff_shift_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
  request_type VARCHAR(12) NOT NULL CHECK(request_type IN ('TIME_OFF','SWAP')),
  target_staff_id BIGINT REFERENCES shop_staff(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(500),
  status VARCHAR(12) NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','DECLINED','CANCELLED')),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(ends_at>starts_at),
  CHECK((request_type='TIME_OFF' AND target_staff_id IS NULL) OR (request_type='SWAP' AND target_staff_id IS NOT NULL AND target_staff_id<>staff_id))
);
CREATE INDEX IF NOT EXISTS staff_shift_requests_review_idx
  ON shop_staff_shift_requests(shop_id,status,created_at);

CREATE TABLE IF NOT EXISTS shop_staff_shift_overrides (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  opens_at TIME,
  closes_at TIME,
  is_working_day BOOLEAN NOT NULL,
  source_request_id BIGINT REFERENCES shop_staff_shift_requests(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(staff_id,work_date),
  CHECK((is_working_day=FALSE AND opens_at IS NULL AND closes_at IS NULL) OR (is_working_day=TRUE AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at<closes_at))
);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT,
  pending_secret_encrypted TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enrollment_token_hash CHAR(64),
  enrollment_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS barberpro_subscription_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  billing_period VARCHAR(10) NOT NULL CHECK(billing_period IN ('MONTHLY','YEARLY')),
  amount_paise BIGINT NOT NULL CHECK(amount_paise>=100),
  razorpay_plan_id VARCHAR(100) UNIQUE,
  feature_entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  plan_id BIGINT NOT NULL REFERENCES barberpro_subscription_plans(id) ON DELETE RESTRICT,
  razorpay_subscription_id VARCHAR(100) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'CREATED'
    CHECK(status IN ('CREATED','AUTHENTICATED','ACTIVE','PENDING','HALTED','CANCELLED','COMPLETED','EXPIRED')),
  current_start TIMESTAMPTZ,
  current_end TIMESTAMPTZ,
  next_charge_at TIMESTAMPTZ,
  short_url TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_subscriptions_current_idx
  ON shop_subscriptions(shop_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS users_imported_pending_idx
  ON users(imported_pending_activation,email) WHERE imported_pending_activation=TRUE;

-- Expired booking reference images are purged by the daily retention task.
