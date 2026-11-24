-- New rebooking reminder preferences are opt-in by default. Existing customer choices are preserved.
ALTER TABLE shop_customer_rebooking_profiles ALTER COLUMN enabled SET DEFAULT FALSE;

-- Isolated synthetic examples for the customer preferences and privacy UI.
-- These rows are deliberately not users, customer profiles, message-consent rows or privacy-consent events.
CREATE TABLE IF NOT EXISTS shop_demo_customer_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  demo_key VARCHAR(24) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  preferred_barber_label VARCHAR(120),
  preferred_service_label VARCHAR(120),
  care_notes VARCHAR(500),
  photo_storage_consent BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_reminders_consent BOOLEAN NOT NULL DEFAULT FALSE,
  sms_reminders_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shop_demo_customer_profiles_demo_only CHECK (demo_key LIKE 'DEMO-%'),
  CONSTRAINT shop_demo_customer_profiles_shop_key_unique UNIQUE(shop_id,demo_key)
);

INSERT INTO shop_demo_customer_profiles(shop_id,demo_key,display_name,preferred_barber_label,preferred_service_label,care_notes)
SELECT sh.id,v.demo_key,v.display_name,v.preferred_barber_label,v.preferred_service_label,v.care_notes
FROM shops sh CROSS JOIN (VALUES
  ('DEMO-001','Demo Customer Asha (SAMPLE)','Sample barber preference','Classic haircut','Synthetic sample notes: prefers a neat, low-maintenance style.'),
  ('DEMO-002','Demo Customer Rohan (SAMPLE)','No preference','Beard trim','Synthetic sample notes: asks for a tidy beard outline.'),
  ('DEMO-003','Demo Customer Meera (SAMPLE)','No preference','Hair wash','Synthetic sample notes: no additional service notes.')
) AS v(demo_key,display_name,preferred_barber_label,preferred_service_label,care_notes)
WHERE sh.is_active=TRUE
ON CONFLICT(shop_id,demo_key) DO NOTHING;
