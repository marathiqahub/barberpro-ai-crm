CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS shops (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(180) NOT NULL UNIQUE,
  address TEXT,
  phone VARCHAR(30),
  timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_staff (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  display_name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, user_id),
  UNIQUE (shop_id, id)
);

CREATE TABLE IF NOT EXISTS services (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, id)
);

CREATE TABLE IF NOT EXISTS staff_services (
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS staff_working_hours (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at TIME NOT NULL,
  closes_at TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (opens_at < closes_at),
  UNIQUE (staff_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS staff_time_off (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(240),
  CHECK (starts_at < ends_at)
);

CREATE TABLE IF NOT EXISTS appointments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  staff_id BIGINT NOT NULL REFERENCES shop_staff(id) ON DELETE RESTRICT,
  service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'BOOKED'
    CHECK (status IN ('BOOKED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW')),
  customer_notes VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (shop_id, staff_id) REFERENCES shop_staff(shop_id, id),
  FOREIGN KEY (shop_id, service_id) REFERENCES services(shop_id, id)
);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_staff_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('BOOKED', 'CONFIRMED'));

CREATE INDEX IF NOT EXISTS appointments_customer_starts_idx ON appointments(customer_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS appointments_shop_starts_idx ON appointments(shop_id, starts_at);
CREATE INDEX IF NOT EXISTS staff_working_hours_staff_day_idx ON staff_working_hours(staff_id, day_of_week);
CREATE INDEX IF NOT EXISTS staff_time_off_staff_range_idx ON staff_time_off USING gist (staff_id, tstzrange(starts_at, ends_at, '[)'));
