-- TOTP replay protection. Keep already-merged migration 032 immutable.
ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS last_verified_step BIGINT;

-- Prevent concurrent duplicate pending/active subscriptions for a shop.
CREATE UNIQUE INDEX IF NOT EXISTS shop_subscriptions_one_current_idx
  ON shop_subscriptions(shop_id)
  WHERE status IN('CREATED','AUTHENTICATED','ACTIVE','PENDING');
