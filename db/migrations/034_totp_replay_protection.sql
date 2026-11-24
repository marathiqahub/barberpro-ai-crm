-- TOTP replay protection. Keep already-merged migration 032 immutable.
ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS last_verified_step BIGINT;
