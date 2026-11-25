# BarberPro production-readiness gate

**Status: not approved for real shop/customer data yet.** This document records the observed Render configuration and the checks required before onboarding paying shops. It deliberately does not change service plans, databases, or production data.

## Current deployment facts (checked 25 November 2026)

- Render web service `barberpro-ai-crm-cxm7` is on the **Free** plan. A free web service can spin down after inactivity, so it is not suitable for dependable paid-customer availability.
- PostgreSQL `barberpro-ai-crm-db-cxm7` is on the **Free** plan and reports expiry at **22 December 2026, 17:32 UTC**. Do not rely on this database for customer records. Upgrade the existing database before the expiry date; do not create a replacement and discard the current database.
- The database reports high availability disabled and an IP allow-list of `0.0.0.0/0`. Restrict database ingress to the required Render services/operators where the network setup permits.
- The live Render service inventory currently contains the web service only. The repository Blueprint declares a reminder cron service, but a live cron service was not present in the inventory at the time of this check. Therefore automated reminders, waitlist expiry/refill, and photo cleanup must be treated as **not operationally verified**.
- The CI workflow provisions PostgreSQL 17 and sets `TEST_DATABASE_URL`; `npm test` includes a real PostgreSQL-backed customer-preferences integration test. The test creates and drops an isolated schema. It does not connect to production.
- Database migrations through `034_totp_replay_protection.sql` are recorded as applied in the current database.
- No backup configuration or completed restore drill was established from the available Render service/database metadata. A successful health check or migration history is not proof of a recoverable backup.

## Required infrastructure before a paid-customer launch

1. **Database:** upgrade the existing PostgreSQL instance to a non-expiring paid plan with capacity appropriate to measured workload. Confirm automated backups/PITR and their retention window in the Render dashboard for the selected plan. Keep the same database identity/connection string where possible.
2. **Web service:** move the existing web service to a paid always-on plan. Verify the selected instance size, health check, deploy rollback path, and alerting. Keep the Singapore region consistent with the database unless a planned migration is approved.
3. **Network:** remove the broad database IP allow-list where possible; allow only required trusted sources. Keep database credentials and payment/provider secrets in Render's secret environment configuration, never in source control.
4. **Reminder worker:** create/verify the declared cron service, confirm it is running every minute, and inspect a successful run plus delivery-attempt records. Verify provider credentials, approved WhatsApp templates, and India SMS DLT settings before enabling customer messages.
5. **Monitoring:** configure deploy-failure notifications, database capacity/connection alerts, HTTP 5xx monitoring, and a periodic synthetic health/booking check.

**Cost approval is required** before changing Render plans or creating paid resources. This PR does not apply infrastructure changes.

## Backup and restore acceptance drill

Do not call backups verified until all of the following have been completed and recorded:

- Confirm backup/PITR is enabled and record its retention period and recovery-point objective.
- Take or identify a known-good backup at a quiet time.
- Restore it into a **separate temporary database**, not over production.
- Point a staging copy of the app at the restored database.
- Verify schema migration history, shops, users, appointments, invoices, payment references, consent history, and indexes/constraints.
- Run the smoke tests below against the restored copy.
- Record restore duration, data-loss window, operator, and cleanup of the temporary database.
- Repeat this drill periodically and after material schema/storage changes.

Never test restore by dropping, truncating, or overwriting the production database.

## Application verification matrix

| Area | Required verification | Current evidence / gap |
|---|---|---|
| Booking | Customer creates, reschedules, cancels; barber sees only assigned work; conflicting bookings are rejected | Unit/integration coverage exists in the repo, but authenticated live end-to-end booking has not been demonstrated in a non-production environment |
| Payment | Razorpay test order, signature verification, webhook idempotency, duplicate/out-of-order webhook handling, refund reconciliation | Do not infer success from reaching Checkout; run only with Razorpay test credentials and test appointments |
| Billing | Invoice totals, GST split/rounding, split tender, payment-to-invoice reconciliation, immutable audit history | Must be tested with representative fixtures and reviewed against the shop's GST configuration before using for tax invoices |
| Access control | Customer cannot read another customer's data; barber restricted to assigned shop/work; admin actions scoped to authorized shop(s) | Middleware enforces authenticated roles; preference APIs validate active shop and same-shop barber/service IDs. A full cross-route authorization audit remains required |
| Privacy/consent | Missing consent defaults off; consent updates are atomic; revocation stops queued delivery; private notes are redacted after withdrawal | PostgreSQL-backed customer preference tests cover defaults, withdrawal/redaction, same-shop IDs, waitlist, and opt-in rebooking. Expand coverage as APIs change |
| Data retention | Expired reference photos deleted; customer-uploaded media, reminders, audit logs, invoices, and payment records have explicit retention/legal-hold rules | Reference-photo schema has a 90-day expiry and worker cleanup code. `shop_customer_photos` currently has no expiry column or cleanup rule; retention job execution is not verified |
| Backup/restore | Restore to isolated DB and pass smoke tests | Not verified |
| Availability | Paid always-on web, non-expiring paid DB, live cron worker, monitoring | Current web and DB are Free; DB expires 22 Dec 2026; live cron was not found |

## Safe test procedure

1. Use a staging database and test-only customer/barber/admin accounts. Never share passwords or production tokens in chat or test logs.
2. Seed clearly synthetic records in staging only.
3. Run `npm run check` and `npm test` with `TEST_DATABASE_URL` set to an isolated PostgreSQL database.
4. Verify customer booking, barber work queue, admin billing, Razorpay test checkout/webhook, invoice reconciliation, consent withdrawal, and retention expiry.
5. Run the same smoke tests against the restored backup.
6. Capture evidence (CI run, test IDs, restore timestamp, deploy SHA) before enabling real shop data.

## Data-retention policy decisions still required

Before storing customer data, the product owner must approve retention periods for appointment reference photos, customer profile photos, care/allergy notes, reminder/delivery logs, audit events, invoices, and payment/refund records. Tax, accounting, payment-dispute, and other legal obligations may require retaining selected records after a customer erasure request. Deletion must be scoped, auditable, and must not silently remove legally required invoice/payment evidence.

## Release decision

BarberPro is **not production-ready for paid shops yet**. The reminder worker parser regression has been fixed and is covered by CI; CI also runs PostgreSQL-backed customer-preference tests. However, paid infrastructure, live cron verification, full booking/payment/billing E2E, backup restore, and the remaining media-retention policy are release blockers.
