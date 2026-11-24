-- Phase 4: shop-scoped stock, suppliers, purchasing and staff attendance.
CREATE TABLE IF NOT EXISTS shop_suppliers (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 name VARCHAR(160) NOT NULL,
 contact_name VARCHAR(120),
 email VARCHAR(254),
 phone VARCHAR(30),
 gstin VARCHAR(15),
 address TEXT,
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,id)
);
CREATE INDEX IF NOT EXISTS shop_suppliers_shop_idx ON shop_suppliers(shop_id,is_active,name);

CREATE TABLE IF NOT EXISTS shop_inventory_items (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 sku VARCHAR(64) NOT NULL,
 name VARCHAR(160) NOT NULL,
 description VARCHAR(1000),
 unit VARCHAR(24) NOT NULL DEFAULT 'piece',
 quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(quantity>=0),
 reorder_level NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(reorder_level>=0),
 unit_cost_paise BIGINT NOT NULL DEFAULT 0 CHECK(unit_cost_paise>=0),
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,sku),
 UNIQUE(shop_id,id)
);
CREATE INDEX IF NOT EXISTS shop_inventory_low_stock_idx ON shop_inventory_items(shop_id,quantity,reorder_level) WHERE is_active=TRUE;

CREATE TABLE IF NOT EXISTS shop_purchase_orders (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
 supplier_id BIGINT NOT NULL,
 order_number VARCHAR(40) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ORDERED','PART_RECEIVED','RECEIVED','CANCELLED')),
 notes VARCHAR(1000),
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(shop_id,order_number),
 FOREIGN KEY(shop_id,supplier_id) REFERENCES shop_suppliers(shop_id,id)
);
CREATE TABLE IF NOT EXISTS shop_purchase_order_lines (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 purchase_order_id BIGINT NOT NULL REFERENCES shop_purchase_orders(id) ON DELETE RESTRICT,
 item_id BIGINT NOT NULL REFERENCES shop_inventory_items(id) ON DELETE RESTRICT,
 ordered_quantity NUMERIC(12,3) NOT NULL CHECK(ordered_quantity>0),
 received_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=ordered_quantity),
 unit_cost_paise BIGINT NOT NULL CHECK(unit_cost_paise>=0),
 UNIQUE(purchase_order_id,item_id)
);

CREATE TABLE IF NOT EXISTS shop_stock_movements (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL,
 item_id BIGINT NOT NULL,
 movement_type VARCHAR(16) NOT NULL CHECK(movement_type IN ('OPENING','PURCHASE','ADJUSTMENT','CONSUMPTION','RETURN')),
 quantity_delta NUMERIC(12,3) NOT NULL CHECK(quantity_delta<>0),
 unit_cost_paise BIGINT NOT NULL DEFAULT 0 CHECK(unit_cost_paise>=0),
 reference VARCHAR(120),
 note VARCHAR(500),
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(shop_id,item_id) REFERENCES shop_inventory_items(shop_id,id)
);
CREATE INDEX IF NOT EXISTS shop_stock_movements_item_idx ON shop_stock_movements(shop_id,item_id,created_at DESC);

CREATE TABLE IF NOT EXISTS shop_staff_attendance (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL,
 staff_id BIGINT NOT NULL,
 work_date DATE NOT NULL,
 clock_in_at TIMESTAMPTZ NOT NULL,
 clock_out_at TIMESTAMPTZ,
 note VARCHAR(500),
 recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(clock_out_at IS NULL OR clock_out_at>clock_in_at),
 FOREIGN KEY(shop_id,staff_id) REFERENCES shop_staff(shop_id,id),
 UNIQUE(staff_id,work_date)
);
CREATE INDEX IF NOT EXISTS shop_staff_attendance_date_idx ON shop_staff_attendance(shop_id,work_date DESC);
