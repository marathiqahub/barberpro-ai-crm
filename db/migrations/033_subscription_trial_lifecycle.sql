-- Subscription trial and cancellation lifecycle additions.
ALTER TABLE shop_subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE shop_subscriptions DROP CONSTRAINT IF EXISTS shop_subscriptions_status_check;
ALTER TABLE shop_subscriptions ADD CONSTRAINT shop_subscriptions_status_check
  CHECK (status IN ('CREATED','AUTHENTICATED','ACTIVE','PENDING','HALTED','CANCELLED','COMPLETED','EXPIRED','TRIALING'));

CREATE INDEX IF NOT EXISTS shop_subscriptions_trial_expiry_idx
  ON shop_subscriptions(trial_ends_at) WHERE status='TRIALING';

-- A trial is active only while its timestamp is in the future; the daily/admin
-- refresh endpoint marks expired trial rows for reporting and clean state.
