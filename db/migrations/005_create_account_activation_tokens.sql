CREATE TABLE IF NOT EXISTS account_activation_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_activation_tokens_user_id_idx
  ON account_activation_tokens(user_id);
CREATE INDEX IF NOT EXISTS account_activation_tokens_expires_at_idx
  ON account_activation_tokens(expires_at);
