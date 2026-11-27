-- WhatsApp AI receptionist, inbox, lead capture and human handoff.
ALTER TABLE shop_messaging_settings
  ADD COLUMN IF NOT EXISTS whatsapp_ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS whatsapp_ai_locale VARCHAR(8) NOT NULL DEFAULT 'en'
    CHECK (whatsapp_ai_locale IN ('en','hi','mr')),
  ADD COLUMN IF NOT EXISTS whatsapp_ai_greeting VARCHAR(500),
  ADD COLUMN IF NOT EXISTS whatsapp_handoff_keywords TEXT[] NOT NULL
    DEFAULT ARRAY['HUMAN','AGENT','PERSON','CALL ME','TALK TO STAFF']::text[];

CREATE TABLE IF NOT EXISTS shop_whatsapp_conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sender VARCHAR(40) NOT NULL,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'AI'
    CHECK (status IN ('AI','HUMAN','RESOLVED')),
  locale VARCHAR(8) NOT NULL DEFAULT 'en' CHECK(locale IN ('en','hi','mr')),
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop_id,sender)
);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_inbox_idx
  ON shop_whatsapp_conversations(shop_id,status,last_message_at DESC);

CREATE TABLE IF NOT EXISTS shop_whatsapp_conversation_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES shop_whatsapp_conversations(id) ON DELETE CASCADE,
  direction VARCHAR(8) NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
  body TEXT NOT NULL CHECK(length(body)<=4000),
  ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  provider_message_id VARCHAR(180),
  delivery_status VARCHAR(12) NOT NULL DEFAULT 'RECEIVED'
    CHECK(delivery_status IN ('RECEIVED','SENT','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS whatsapp_conversation_messages_idx
  ON shop_whatsapp_conversation_messages(conversation_id,created_at DESC);

CREATE TABLE IF NOT EXISTS shop_whatsapp_leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES shop_whatsapp_conversations(id) ON DELETE SET NULL,
  sender VARCHAR(40) NOT NULL,
  customer_name VARCHAR(120),
  interest VARCHAR(500),
  status VARCHAR(12) NOT NULL DEFAULT 'NEW'
    CHECK(status IN ('NEW','CONTACTED','CONVERTED','CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop_id,sender)
);
CREATE INDEX IF NOT EXISTS whatsapp_leads_inbox_idx
  ON shop_whatsapp_leads(shop_id,status,created_at DESC);

-- Inbound conversation content expires 180 days after the last activity.
ALTER TABLE shop_whatsapp_conversations
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '180 days';
ALTER TABLE shop_whatsapp_conversation_messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '180 days';
CREATE INDEX IF NOT EXISTS whatsapp_conversation_expiry_idx
  ON shop_whatsapp_conversations(expires_at) WHERE status<>'HUMAN';
