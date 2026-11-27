# BarberPro SaaS subscription model

Subscriptions are per shop/outlet. Plan prices are INR paise and feature entitlements are boolean JSON flags.

## Platform plan administration
Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET` on the server. A platform ADMIN creates plans through `POST /api/admin/subscription-plans`. The API creates the Razorpay plan and persists its provider ID.

## Shop billing endpoints
A platform ADMIN, SHOP_OWNER or BILLING_ADMIN membership may manage that shop only:
- `POST /api/shops/:shopId/subscription/trial` — start one 14-day trial (body: `planId`).
- `POST /api/shops/:shopId/subscription` — create Razorpay checkout (body: `planId`); checkout creation does not activate access.
- `GET /api/shops/:shopId/subscription` — current/latest subscription and entitlements.
- `PATCH /api/shops/:shopId/subscription/cancel` — cancel trial immediately, or request provider cancellation at period end; set `cancelAtCycleEnd:false` for immediate cancellation.
- `GET /api/shops/:shopId/subscription/invoices` and `GET /api/shops/:shopId/subscription/payments` — invoice and provider payment history.
- `GET /api/shops/:shopId/feature-entitlements` — shop feature flags.

Platform administrators assign billing contacts through `POST /api/admin/shops/:shopId/billing-members` with `userId` and `role` (`SHOP_OWNER` or `BILLING_ADMIN`); removal uses DELETE on the matching member URL. A shop billing member cannot administer another shop.

## Razorpay webhook and reconciliation
Register `POST /api/subscriptions/webhook` for `subscription.authenticated`, `subscription.activated`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed` and `subscription.charged`. Signatures are verified against raw request bytes. Razorpay's event ID is stored under a unique constraint so duplicate deliveries are acknowledged without replaying state changes.

Captured/failed subscription payments are persisted in `subscription_payments`; provider invoice metadata is persisted in `subscription_invoices`. Compare these rows with the Razorpay dashboard before accounting close. Provider invoice/receipt links are surfaced where supplied. This is not a GST tax-invoice generator and does not replace GST validation or statutory accounting.

Failed renewals are persisted and the existing reminder Cron command now also runs `scripts/deliver-subscription-notices.js`. It requires `RESEND_API_KEY` and `MAIL_FROM`, and sends to shop billing contacts. A notice is marked sent only after all configured billing contacts have been notified.

## Server-side feature enforcement
Advanced feature routes enforce entitlements in the API using the current active/trial subscription. Shops without any subscription row retain legacy access during rollout; shops with an expired/cancelled subscription do not receive gated features. Do not create subscriptions for existing shops until the commercial billing cutover is approved.

## Browser session security
The workspace now uses Secure (production), HttpOnly, SameSite=Lax access and refresh cookies. Mutating authenticated requests require the readable CSRF cookie value in `X-CSRF-Token`. Browser JavaScript does not receive bearer or refresh tokens. Non-browser API clients may continue using Authorization Bearer tokens. Always use HTTPS outside local development.

## Migrations and tests
Apply migrations with `npm run db:migrate`. Migration 035 adds billing-member roles, webhook idempotency, payment ledger, invoices and failed-renewal state. CI provisions disposable PostgreSQL 17, applies all migrations and runs the database-backed lifecycle test. For local integration tests set `TEST_DATABASE_URL` to a disposable database.

## Production rollout
Do not merge/deploy until CI passes, the Razorpay webhook is configured with the matching secret, mail credentials are set, a shop-scoped billing admin is provisioned, and a verified backup/restore drill has completed. No live provider calls, database migration or deployment are performed by the code PR.
