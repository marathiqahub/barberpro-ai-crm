# Customer, barber and platform operations

Migration: `032_customer_barber_admin_suite.sql` (additive; preserves existing customer, shop, booking and payment rows).

## Customer workflows

- `PUT /api/customer/preferences` stores `preferredLocale` as `en`, `hi` or `mr`.
- `POST /api/appointments/:id/reschedule` moves a booked/confirmed appointment in place, retaining the original barber and service. The default cutoff is four hours before the original appointment. The shop can change it with `PUT /api/admin/shops/:shopId/reschedule-policy`. Reminder jobs are replaced for the new start time.
- `POST /api/appointments/:id/reference-photo` accepts JPEG/PNG/WebP base64 up to 512 KB and requires explicit consent. Images are stored privately as PostgreSQL BYTEA and are available only to the customer, assigned barber and admin. They expire after 90 days. `npm run reminders:deliver` purges expired images each time it runs; schedule the existing reminder worker at least daily to make the retention window operational.
- Chemical-service consent is collected at `POST /api/appointments/:id/chemical-consent`. The signature is a typed account name with timestamp, IP, notice version and structured allergy/scalp/patch-test answers. A database trigger prevents a service flagged as chemical from being completed until consent exists. This is an operational record, not a substitute for legal review or an appropriate consent notice.

## Barber workflows

- Each service has `cleanup_minutes`. Customer availability, booking validation, walk-in validation, rescheduling and the database exclusion constraint include the buffer. Admins configure it with `PATCH /api/admin/services/:serviceId/operations`.
- `POST /api/barber/appointments/:id/tip-link` creates a Razorpay Payment Link for a completed appointment. The barber shares the returned URL. Set the Razorpay payment webhook to `/api/payments/webhook` and subscribe to `payment_link.paid` and `payment_link.expired`. Only webhook-confirmed paid tips are included in payroll tip earnings. No live payment is initiated by this PR.
- `POST /api/barber/shift-requests` submits time-off or shift-swap requests. Admins review them at `/api/admin/shift-requests` and approve/decline through `/api/admin/shift-requests/:id/review`. Approved changes are applied as dated schedule overrides or time-off rows and written to the audit log. Swaps require both barbers to have a scheduled shift and no conflicting appointments.

## Admin and platform workflows

- `GET /api/admin/shops/:shopId/accounting-export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD` exports invoice, tax and payment-allocation totals in a CSV layout suitable for accountant review and Tally mapping. Validate ledger mapping, place-of-supply and GST treatment with the shop's accountant before filing/importing.
- `POST /api/admin/shops/:shopId/customers/import` accepts `.csv` or `.xlsx` (maximum 3 MB; up to 5,000 rows), with optional `columnMapping`. It detects duplicates by normalized email or phone. New imported contacts are marked as pending account claim; the customer claims the same email through the normal registration form and sets their own password.
- TOTP is implemented for ADMIN/BARBER accounts. Configure `TOTP_ENCRYPTION_KEY` with a randomly generated secret of at least 32 bytes. Users enroll from their workspace; after enrollment, login requires a current six-digit authenticator code. To enforce enrollment for every privileged account, set `TOTP_REQUIRED_FOR_PRIVILEGED=true` after configuring the encryption key and communicating the rollout. Required-enrollment login uses a short-lived one-time enrollment token. There are no backup codes in this release; retain an administrator recovery procedure before enforcing the policy.
- Admins create Razorpay plans through `POST /api/admin/subscription-plans`, create a shop subscription through `POST /api/admin/shops/:shopId/subscription`, and inspect current status at `GET /api/admin/shops/:shopId/subscription`. Configure Razorpay subscription webhooks to `/api/subscriptions/webhook` for activated, authenticated, pending, halted, cancelled, completed and charged events. Plan feature entitlements are boolean JSON flags; active subscriptions gate the advanced photo, tip, workforce, accounting export, import, chemical-consent and localized-messaging workflows. Existing shops without an active subscription remain in legacy/trial mode.
- Customer language preference selects a shop's translation in `shop_message_template_translations`; admins configure translations in the workspace. WhatsApp sends remain blocked until the exact Meta template name/language is approved. India domestic SMS remains blocked until DLT PE ID and the matching approved DLT template ID are configured.

## Operational configuration and rollout

1. Deploy the application with migration 032 through the normal reviewed deployment path. The migration adds columns/tables, a cleanup-aware appointment exclusion constraint and a chemical-consent completion trigger. It does not reset or delete existing business records.
2. Configure `TOTP_ENCRYPTION_KEY` in the existing Render service before enrolling users. Do not reuse the JWT secrets as the TOTP encryption key.
3. Configure Razorpay payment-link and subscription webhook endpoints and event subscriptions. Use Razorpay test mode first.
4. Set up the existing `reminders:deliver` worker on a daily schedule. It also performs expired reference-photo deletion and reminder delivery. No new Render service or paid cron resource is created by this PR.
5. Configure and obtain provider approval for the exact WhatsApp templates and DLT templates in each language/channel before enabling outbound messages.
6. Have legal counsel review chemical-service consent wording, privacy notices and retention/deletion requirements. Have the accountant validate GST/Tally ledger mapping.

## API safety notes

- Reference images are deliberately capped at 512 KB and stored in the primary database; use an object-storage migration if larger volumes or image libraries are expected.
- Imported customer accounts have a generated unknown password and must be claimed by the customer with the same email. Passwords are never generated for or sent to the shop operator.
- TOTP secrets are encrypted at rest using AES-256-GCM; the encryption key must remain stable and backed up securely. Losing it prevents enrolled users from validating TOTP.
- The typed chemical consent signature records an authenticated account name; it is not a qualified electronic signature.
- Subscription feature gating applies to the new advanced operations in this release. Existing legacy routes remain available for existing shops until a subscription is activated.
