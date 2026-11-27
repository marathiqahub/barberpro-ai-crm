-- BarberPro SaaS subscription plans and shop-level subscription lifecycle.
CREATE TABLE IF NOT EXISTS subscription_plans (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE,
 name VARCHAR(100) NOT NULL, description VARCHAR(500),
 price_monthly_paise BIGINT NOT NULL CHECK(price_monthly_paise>=0),
 price_yearly_paise BIGINT CHECK(price_yearly_paise IS NULL OR price_yearly_paise>=0),
 max_branches INTEGER CHECK(max_branches IS NULL OR max_branches>0),
 max_staff_per_branch INTEGER CHECK(max_staff_per_branch IS NULL OR max_staff_per_branch>0),
 features JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(features)='array'),
 trial_days INTEGER NOT NULL DEFAULT 0 CHECK(trial_days BETWEEN 0 AND 90),
 is_active BOOLEAN NOT NULL DEFAULT TRUE, display_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shop_subscriptions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 plan_id BIGINT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
 status VARCHAR(20) NOT NULL DEFAULT 'TRIALING' CHECK(status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED','PENDING_PAYMENT')),
 billing_cycle VARCHAR(10) NOT NULL DEFAULT 'MONTHLY' CHECK(billing_cycle IN ('MONTHLY','YEARLY')),
 starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), trial_ends_at TIMESTAMPTZ,
 current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(), current_period_end TIMESTAMPTZ,
 cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE, cancelled_at TIMESTAMPTZ,
 provider VARCHAR(30), provider_subscription_id VARCHAR(160) UNIQUE, provider_customer_id VARCHAR(160),
 last_payment_id VARCHAR(160), metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(trial_ends_at IS NULL OR trial_ends_at>=starts_at),
 CHECK(current_period_end IS NULL OR current_period_end>=current_period_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_subscriptions_one_live_idx ON shop_subscriptions(shop_id)
 WHERE status IN ('TRIALING','ACTIVE','PAST_DUE','PENDING_PAYMENT');
CREATE INDEX IF NOT EXISTS shop_subscriptions_status_period_idx ON shop_subscriptions(status,current_period_end);
INSERT INTO subscription_plans(code,name,description,price_monthly_paise,price_yearly_paise,max_branches,max_staff_per_branch,features,trial_days,display_order)
VALUES
 ('FREE','Free','Essential tools for a single barber shop',0,0,1,3,'["booking","customer_management","services","basic_dashboard"]'::jsonb,0,0),
 ('STARTER','Starter','For one growing barber shop',49900,499000,1,10,'["booking","customer_management","services","basic_dashboard","reminders"]'::jsonb,14,1),
 ('GROWTH','Growth','For shops operating multiple branches',99900,999000,3,25,'["booking","customer_management","services","reports","reminders","staff_performance"]'::jsonb,14,2),
 ('BUSINESS','Business','For larger multi-branch operations',199900,1999000,10,100,'["booking","customer_management","services","reports","reminders","staff_performance","advanced_analytics"]'::jsonb,14,3)
ON CONFLICT(code) DO NOTHING;
-- Preserve access for all existing shops without forcing an immediate paid upgrade.
INSERT INTO shop_subscriptions(shop_id,plan_id,status,billing_cycle,starts_at,current_period_start,metadata)
SELECT s.id,p.id,'ACTIVE','MONTHLY',NOW(),NOW(),'{"source":"migration_027_existing_shop_grandfathering"}'::jsonb
FROM shops s CROSS JOIN subscription_plans p WHERE p.code='FREE'
AND NOT EXISTS(SELECT 1 FROM shop_subscriptions ss WHERE ss.shop_id=s.id AND ss.status IN ('TRIALING','ACTIVE','PAST_DUE','PENDING_PAYMENT'));
CREATE OR REPLACE FUNCTION barberpro_refresh_subscription_status() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
 UPDATE shop_subscriptions SET status='EXPIRED',updated_at=NOW()
 WHERE status='TRIALING' AND trial_ends_at IS NOT NULL AND trial_ends_at<=NOW();
 GET DIAGNOSTICS affected=ROW_COUNT;
 UPDATE shop_subscriptions SET status='EXPIRED',updated_at=NOW()
 WHERE status='ACTIVE' AND current_period_end IS NOT NULL AND current_period_end<=NOW() AND cancel_at_period_end=TRUE;
 RETURN affected;
END; $$;
