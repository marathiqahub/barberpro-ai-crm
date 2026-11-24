CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Messaging, booking assistant, payroll and localization foundation.
CREATE TABLE IF NOT EXISTS shop_messaging_settings (
 shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
 email_provider VARCHAR(20) NOT NULL DEFAULT 'RESEND' CHECK(email_provider IN ('RESEND','SMTP_API')),
 sms_provider VARCHAR(20) NOT NULL DEFAULT 'TWILIO' CHECK(sms_provider IN ('TWILIO')),
 whatsapp_provider VARCHAR(20) NOT NULL DEFAULT 'META' CHECK(whatsapp_provider IN ('META','TWILIO')),
 sender_email VARCHAR(254), sender_name VARCHAR(120), sms_from VARCHAR(40),
 whatsapp_phone_number_id VARCHAR(100), whatsapp_business_account_id VARCHAR(100),
 enabled_channels TEXT[] NOT NULL DEFAULT ARRAY['IN_APP']::text[],
 updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shop_message_consents (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel VARCHAR(12) NOT NULL CHECK(channel IN ('EMAIL','SMS','WHATSAPP')),
 destination VARCHAR(254) NOT NULL, consent BOOLEAN NOT NULL, consent_source VARCHAR(40) NOT NULL,
 consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ,
 UNIQUE(shop_id,customer_id,channel,destination)
);
CREATE TABLE IF NOT EXISTS shop_message_templates (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 channel VARCHAR(12) NOT NULL CHECK(channel IN ('EMAIL','SMS','WHATSAPP')),
 template_key VARCHAR(40) NOT NULL, subject VARCHAR(180), body TEXT NOT NULL,
 provider_template_name VARCHAR(100), is_active BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(shop_id,channel,template_key)
);
CREATE TABLE IF NOT EXISTS shop_message_delivery_attempts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, reminder_id BIGINT REFERENCES shop_customer_reminders(id) ON DELETE SET NULL,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE, channel VARCHAR(12) NOT NULL,
 destination VARCHAR(254) NOT NULL, provider VARCHAR(30) NOT NULL, status VARCHAR(12) NOT NULL CHECK(status IN ('SENT','FAILED')),
 provider_reference VARCHAR(180), error_code VARCHAR(80), attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shop_staff_payroll_profiles (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
 employment_type VARCHAR(20) NOT NULL CHECK(employment_type IN ('SALARIED','COMMISSION_ONLY')),
 effective_from DATE NOT NULL, monthly_gross_paise BIGINT NOT NULL DEFAULT 0 CHECK(monthly_gross_paise>=0),
 commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(commission_rate_bps BETWEEN 0 AND 10000),
 pf_applicable BOOLEAN NOT NULL DEFAULT FALSE, pf_employee_bps INTEGER NOT NULL DEFAULT 0 CHECK(pf_employee_bps BETWEEN 0 AND 10000),
 pf_employer_bps INTEGER NOT NULL DEFAULT 0 CHECK(pf_employer_bps BETWEEN 0 AND 10000),
 esi_applicable BOOLEAN NOT NULL DEFAULT FALSE, esi_employee_bps INTEGER NOT NULL DEFAULT 0 CHECK(esi_employee_bps BETWEEN 0 AND 10000),
 esi_employer_bps INTEGER NOT NULL DEFAULT 0 CHECK(esi_employer_bps BETWEEN 0 AND 10000),
 professional_tax_paise BIGINT NOT NULL DEFAULT 0 CHECK(professional_tax_paise>=0),
 tds_bps INTEGER NOT NULL DEFAULT 0 CHECK(tds_bps BETWEEN 0 AND 10000),
 other_deductions_paise BIGINT NOT NULL DEFAULT 0 CHECK(other_deductions_paise>=0),
 active BOOLEAN NOT NULL DEFAULT TRUE, created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,staff_id,effective_from)
);
CREATE INDEX IF NOT EXISTS staff_payroll_effective_idx ON shop_staff_payroll_profiles(shop_id,staff_id,effective_from DESC);
CREATE TABLE IF NOT EXISTS shop_payroll_runs (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 period_start DATE NOT NULL, period_end DATE NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','PAID','VOID')),
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 approved_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(period_end>=period_start), UNIQUE(shop_id,period_start,period_end)
);
CREATE TABLE IF NOT EXISTS shop_payslips (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payroll_run_id BIGINT NOT NULL REFERENCES shop_payroll_runs(id) ON DELETE CASCADE,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE, staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
 employment_type VARCHAR(20) NOT NULL, basic_gross_paise BIGINT NOT NULL, commission_paise BIGINT NOT NULL DEFAULT 0,
 tips_paise BIGINT NOT NULL DEFAULT 0, pf_employee_paise BIGINT NOT NULL DEFAULT 0, esi_employee_paise BIGINT NOT NULL DEFAULT 0,
 professional_tax_paise BIGINT NOT NULL DEFAULT 0, tds_paise BIGINT NOT NULL DEFAULT 0, other_deductions_paise BIGINT NOT NULL DEFAULT 0,
 employer_pf_paise BIGINT NOT NULL DEFAULT 0, employer_esi_paise BIGINT NOT NULL DEFAULT 0,
 gross_paise BIGINT NOT NULL, deductions_paise BIGINT NOT NULL, net_paise BIGINT NOT NULL,
 calculation JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(payroll_run_id,staff_id)
);
CREATE TABLE IF NOT EXISTS shop_ai_booking_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL, channel VARCHAR(12) NOT NULL CHECK(channel IN ('WEB','WHATSAPP')),
 external_id VARCHAR(160), state JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shop_whatsapp_inbound_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, provider_message_id VARCHAR(180) UNIQUE NOT NULL,
 sender VARCHAR(40) NOT NULL, phone_number_id VARCHAR(100), payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 processed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS shop_localization_preferences (
 shop_id BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
 default_locale VARCHAR(8) NOT NULL DEFAULT 'en' CHECK(default_locale IN ('en','mr')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
