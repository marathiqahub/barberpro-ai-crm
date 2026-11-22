# BarberPro AI CRM

A barber-focused CRM API built with Node.js, Express, and PostgreSQL. It provides customer registration plus user authentication with password hashing, short-lived JWT access tokens, and rotating refresh tokens.

## Docker Compose deployment

1. Install Docker Engine and the Docker Compose plugin.
2. Copy `.env.example` to `.env` and configure the port and PostgreSQL database/user values.
3. Create local secret files, then replace every sample value with a different, long, cryptographically random secret:

   ```sh
   mkdir -p secrets
   cp secrets/db_password.txt.example secrets/db_password.txt
   cp secrets/jwt_access_secret.txt.example secrets/jwt_access_secret.txt
   cp secrets/jwt_refresh_secret.txt.example secrets/jwt_refresh_secret.txt
   chmod 600 secrets/*.txt
   ```

   Generate independent values with a password manager or a cryptographically secure generator, for example `openssl rand -base64 48`. Never reuse the database password as either JWT secret.
4. Start the services with `docker compose up --build -d`.
5. Check status with `docker compose ps` and logs with `docker compose logs -f`.

The API is bound to `127.0.0.1:3000` by default, suitable for a same-host reverse proxy. Set `PORT_BIND_ADDRESS` only if you intentionally need a different bind address. PostgreSQL is not published to the host. Both containers use health checks; the API waits for PostgreSQL readiness. The named database volume persists across ordinary `docker compose down` operations.

Database and JWT secrets are mounted as Compose secrets rather than passed in container environment variables. Keep `.env` and all real files under `secrets/` private and never commit them. Compose file-backed secrets are mounted read-only but are not an encrypted secrets manager; for production on an orchestrator, use its managed secret store. Configure TLS at a trusted reverse proxy, firewall inbound access, and establish tested backup/restore and monitoring procedures.

Useful commands:

```sh
docker compose logs -f api
docker compose logs -f db
docker compose down
# Destructive: also removes the database volume and all stored data
docker compose down -v
```

PostgreSQL runs SQL files in `db/migrations` only when initializing an empty data volume. For an existing deployment, apply the new migration once using your database migration process (for example, `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_create_booking_tables.sql`). Do not delete the existing database volume to apply a schema change.

## Local development

Requirements: Node.js 20+ and PostgreSQL.

1. Install dependencies with `npm install`.
2. Apply both migrations in order: `db/migrations/001_create_customers.sql`, then `db/migrations/002_create_auth_tables.sql`, then `db/migrations/003_create_booking_tables.sql`.
3. Set `DATABASE_URL`, `JWT_ACCESS_SECRET`, and `JWT_REFRESH_SECRET` in your private `.env`. Use different random secrets of at least 32 bytes. Alternatively, set the corresponding `*_FILE` variables to readable secret files.
4. Start the server with `npm start` (or `npm run dev` during development).

The API refuses to start its authentication routes if either JWT secret is missing or shorter than 32 bytes.

## Booking and multi-shop API

Apply migration `003_create_booking_tables.sql` after the authentication migration. It creates shops, barber memberships, services, optional barber-to-service assignments, weekly working hours, time off, and appointments. Each shop stores an IANA timezone (defaults to `Asia/Kolkata`). Working-hour slots are calculated in that shop timezone; appointment timestamps sent to the API must be ISO 8601 timestamps.

Public discovery:
- `GET /api/shops` — list active shops.
- `GET /api/shops/:shopId/services` — list active services.
- `GET /api/shops/:shopId/availability?serviceId=1&date=YYYY-MM-DD&staffId=2` — list future 15-minute start slots that fit the service duration, staff schedule, time off and existing bookings.

ADMIN access:
- `POST /api/shops` — create a shop (`name`, unique URL-safe `slug`, optional `address`, `phone`, `timezone`).
- `POST /api/shops/:shopId/staff` — attach an active BARBER user (`userId`, `displayName`).
- `POST /api/shops/:shopId/services` — create a service (`name`, `durationMinutes`, `price`, optional `description`).
- `POST /api/staff/:staffId/services/:serviceId` — restrict a barber to selected services. If no service mapping exists for a barber, all shop services are eligible.
- `PUT /api/staff/:staffId/hours` — upsert one weekly schedule (`dayOfWeek` 0=Sunday through 6=Saturday, `opensAt`, `closesAt`, optional `isActive`).
- `POST /api/staff/:staffId/time-off` — add a time-off interval (`startsAt`, `endsAt`, optional `reason`).

Customer access:
- `POST /api/appointments` — book a slot (`shopId`, `serviceId`, `staffId`, ISO `startsAt`, optional `customerNotes`).
- `GET /api/appointments/mine` — list the signed-in customer's appointments.
- `PATCH /api/appointments/:appointmentId/cancel` — cancel an upcoming booking owned by the customer. ADMIN may cancel any upcoming booking.

Booking writes validate the shop's local working hours and service duration, enforce barber/service compatibility, exclude time off, and use a PostgreSQL GiST exclusion constraint to prevent overlapping active appointments even under concurrent requests. Public registration still cannot assign ADMIN or BARBER roles; provision privileged accounts through a trusted operator workflow.

## Authentication API

All authentication endpoints are under `/api/auth`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/register` | Create a CUSTOMER account and issue tokens |
| POST | `/login` | Verify credentials and issue tokens |
| POST | `/refresh` | Rotate a refresh token and issue a new pair |
| POST | `/logout` | Revoke the refresh-token family |
| GET | `/me` | Return the authenticated user's profile |

Registration accepts `name`, `email`, and `password`. Passwords must be 12–128 characters. New public registrations always receive the `CUSTOMER` role; the client cannot self-assign ADMIN or BARBER. Provision staff accounts through a trusted administrative process (for example, have an authorized operator create the user and set its role in a controlled admin workflow; never expose role assignment on public registration). Roles supported by the authorization middleware are `ADMIN`, `BARBER`, and `CUSTOMER`.

Passwords are hashed with Argon2id. Access JWTs expire after 15 minutes. Refresh JWTs expire after 7 days, are stored in the database only as SHA-256 hashes, rotate on every successful refresh, and share a family identifier so replay of a revoked token revokes the active family. Access JWTs are bound to that family too, and middleware checks the family is still active, so logout and detected refresh-token replay invalidate access tokens immediately. Access and refresh JWTs use different secrets and are verified with a fixed HS256 algorithm, issuer, and audience. Tokens contain identifiers and role metadata only; do not put secrets or sensitive personal data in JWT claims.

Send access tokens as `Authorization: Bearer <accessToken>`. Send the current refresh token in the JSON body to `/refresh` and `/logout`. Treat refresh tokens as credentials: keep them in secure client-side storage (or, for browser applications, preferably a backend-for-frontend using Secure, HttpOnly, SameSite cookies and appropriate CSRF protections). Always use HTTPS outside local development. Login, registration, and refresh endpoints have per-IP rate limits; the default in-memory limiter is per process, so use a shared store when deploying multiple API instances and configure Express proxy trust carefully behind a reverse proxy.

Example registration:

```sh
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alex Morgan","email":"alex@example.com","password":"a-long-unique-password"}'
```

Example authenticated profile request:

```sh
curl http://localhost:3000/api/auth/me \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
```

### Roles and authorization

The middleware exports `authenticate` and `requireRole(...roles)` for protecting future CRM routes. It rechecks that the user is still active in PostgreSQL on each authenticated request. Public registration intentionally cannot grant privileged roles. No existing customer endpoint was silently converted into an authenticated endpoint.

## Customer registration API (preserved)

`POST /api/customers` remains available with its original behavior. It registers a customer record independently of login accounts. `name` and `email` are required; `phone` is optional. Emails are trimmed, lowercased, and unique in the customers table.

- `201 Created` — customer registered.
- `400 Bad Request` — invalid input or malformed JSON.
- `409 Conflict` — a customer with this email already exists.
- `413 Content Too Large` — request body exceeds the 10 KB limit.
- `429 Too Many Requests` — more than 10 attempts in 15 minutes from the same client.
- `500 Internal Server Error` — unexpected server error.

Health checks: `/health/live` indicates the process is running; `/health/ready` verifies database connectivity and is used by Compose.

## API documentation

- Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI 3.0 JSON: `http://localhost:3000/openapi.json`
- Specification source: `src/openapi.json`

## Role-specific application APIs

The shared API now exposes separate authenticated surfaces for the three application experiences. All endpoints use the existing Bearer access token. Public registration remains CUSTOMER-only; ADMIN and BARBER accounts must be provisioned by a trusted operator.

### Customer app
The customer foundation is provided by the existing public shop/service/availability discovery endpoints, `POST /api/appointments`, `GET /api/appointments/mine`, and the customer-owned cancellation endpoint. The current payment integration is not enabled; appointment prices are read from the service catalogue and must not be treated as proof of payment.

### Barber app
- `GET /api/barber/dashboard` — the signed-in barber's shop metrics and upcoming assigned appointments, including customer and service details.
- `GET /api/barber/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD` — appointments assigned to the signed-in barber for a date range (defaults to today).
- `PATCH /api/barber/appointments/:appointmentId/status` — transition an assigned appointment to CONFIRMED, COMPLETED or NO_SHOW, subject to the booking state machine.
- `GET /api/barber/availability` — own weekly working hours and future time-off records.
- `POST /api/barber/time-off` — add time off to one of the signed-in barber's own shop memberships (`staffId`, `startsAt`, `endsAt`, optional `reason`).

A barber's membership is always resolved against the authenticated user; a client cannot read or update another barber's appointments or availability.

### Admin dashboard
- `GET /api/admin/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD` — cross-shop totals and shop-level activity.
- `GET /api/admin/shops` and `PATCH /api/admin/shops/:shopId` — list and update shop profile/active status.
- `GET /api/admin/staff-performance?from=...&to=...` — appointment outcomes and completed-service revenue per barber.
- `GET /api/admin/reports?from=...&to=...` — shop-level appointment and revenue report.
- `GET /api/admin/services` and `PATCH /api/admin/services/:serviceId` — service catalogue and updates.

Date ranges are inclusive and evaluated against appointment timestamps. Revenue is the sum of service catalogue prices for COMPLETED appointments; it is operational reporting, not a payment ledger. Payment capture, refunds, taxes and reconciliation require a payment provider and a dedicated payment ledger before being represented as paid revenue.


## Customer, barber and admin web workspaces

The browser application is served from `/`. Sign in with a CUSTOMER, BARBER or ADMIN account to open the corresponding workspace. Customer features include shop and service discovery, barber/slot selection, booking, checkout and history. Barber features include daily appointments, customer details and status actions. Admin features include multi-shop operations, staff overview, reports and payment reconciliation/refunds.

## Razorpay payment integration

Apply `db/migrations/004_create_payment_tables.sql` after migration 003. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` in the deployment secret manager. Register `https://YOUR_HOST/api/payments/webhook` with Razorpay for `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`. Checkout and webhook signatures are verified server-side; webhook event IDs are idempotent. Admin reconciliation is `GET /api/payments/reconciliation`; refunds use `POST /api/payments/:paymentId/refunds`. Never expose secret credentials to browsers. Checkout remains disabled until credentials are configured.

The initial SPA stores bearer tokens in local storage. Before production, move browser authentication behind a same-origin backend-for-frontend using Secure, HttpOnly, SameSite cookies and CSRF protection.