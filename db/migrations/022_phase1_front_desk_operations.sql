-- Phase 1: front-desk appointment lifecycle and immutable operational audit events.
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('BOOKED','CONFIRMED','IN_PROGRESS','READY_TO_BILL','COMPLETED','CANCELLED','NO_SHOW'));

CREATE TABLE IF NOT EXISTS appointment_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL CHECK (event_type IN ('WALK_IN_CREATED','STATUS_CHANGED')),
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS appointment_events_shop_created_idx
  ON appointment_events(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS appointment_events_appointment_idx
  ON appointment_events(appointment_id, created_at);
