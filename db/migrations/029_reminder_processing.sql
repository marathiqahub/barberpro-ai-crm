ALTER TABLE shop_customer_reminders DROP CONSTRAINT IF EXISTS shop_customer_reminders_status_check;
ALTER TABLE shop_customer_reminders ADD CONSTRAINT shop_customer_reminders_status_check CHECK(status IN ('PENDING','PROCESSING','SENT','FAILED','CANCELLED'));
ALTER TABLE shop_customer_reminders ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
