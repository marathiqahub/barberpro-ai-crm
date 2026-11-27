# Subscription commercial readiness implementation

## Billing API
Shop-scoped endpoints: `POST /api/shops/:shopId/subscription/trial`, `POST /api/shops/:shopId/subscription`, `GET /api/shops/:shopId/subscription`, `PATCH /api/shops/:shopId/subscription/cancel`, plus invoice/payment history endpoints. Platform administrators create plans at `POST /api/admin/subscription-plans`. Shop billing access is restricted to ADMIN or a row in `shop_billing_members` with SHOP_OWNER/BILLING_ADMIN.

Razorpay subscription webhook: `POST /api/subscriptions/webhook`; raw request bytes are signed with `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET` (fallback `RAZORPAY_WEBHOOK_SECRET`). Configure subscription authenticated, activated, pending, halted, cancelled, completed, charged events and include the Razorpay event ID header. Delivery is idempotent in PostgreSQL.

## Data and testing
Migration 035 adds billing memberships, webhook deduplication, provider payment ledger and subscription invoice records. Run `npm run db:migrate`, then `TEST_DATABASE_URL=... npm test`. Integration tests must use a disposable PostgreSQL database, never production.

## Operational limitations
Invoice/receipt rows mirror provider invoice metadata; this is not a GST tax-invoice engine. Reconciliation is represented by the provider payment ledger and must be reconciled against the Razorpay dashboard before accounting use. Failed-payment state is persisted for notification delivery; configure a mail provider and schedule the billing-notification job before enabling customer-facing failure notices. Do not infer a successful backup from a running PostgreSQL volume: take a pg_dump and perform a restore drill on an isolated database.

## Cookie migration
The legacy browser client currently stores bearer and refresh tokens in localStorage. This PR's browser-auth migration must be rolled out atomically with cookie issuance, CSRF validation and client fetch credentials; do not deploy only one side. Use HTTPS, Secure, HttpOnly, SameSite=Lax cookies and a synchronizer/double-submit CSRF token for state-changing requests.
