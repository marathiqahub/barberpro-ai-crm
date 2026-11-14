# BarberPro AI CRM

A demo repository for a barber-focused CRM with a customer registration API built with Node.js, Express, and PostgreSQL.

## Docker Compose deployment

1. Install Docker Engine and the Docker Compose plugin.
2. Copy `.env.example` to `.env` and configure the port and PostgreSQL database/user values.
3. Create a local secret file, then replace its sample value with a long, unique random password:

   ```sh
   mkdir -p secrets
   cp secrets/db_password.txt.example secrets/db_password.txt
   chmod 600 secrets/db_password.txt
   ```

4. Start the services with `docker compose up --build -d`.
5. Check status with `docker compose ps` and logs with `docker compose logs -f`.

The API is bound to `127.0.0.1:3000` by default, suitable for a same-host reverse proxy. Set `PORT_BIND_ADDRESS` only if you intentionally need a different bind address. PostgreSQL is not published to the host. Both containers use health checks; the API waits for PostgreSQL readiness. The named database volume persists across ordinary `docker compose down` operations.

The database password is mounted as a Compose secret rather than passed in the container environment. Keep `.env` and `secrets/db_password.txt` private and never commit real credentials. Compose file-backed secrets are mounted read-only but are not an encrypted secrets manager; for production on an orchestrator, use its managed secret store. Configure TLS at a trusted reverse proxy, firewall inbound access, and establish tested backup/restore and monitoring procedures.

Useful commands:

```sh
docker compose logs -f api
docker compose logs -f db
docker compose down
# Destructive: also removes the database volume and all stored data
docker compose down -v
```

PostgreSQL runs SQL files in `db/migrations` only when initializing an empty data volume. For subsequent schema changes, use a proper migration tool or apply migrations as a controlled deployment step; do not assume the init scripts rerun on an existing volume.

## Local development

Requirements: Node.js 20+ and PostgreSQL.

1. Install dependencies with `npm install`.
2. Create a database and apply `db/migrations/001_create_customers.sql`.
3. Set `DATABASE_URL` in `.env`.
4. Start the server with `npm start` (or `npm run dev` during development).

## API

`POST /api/customers` registers a customer. `name` and `email` are required; `phone` is optional. Emails are trimmed, lowercased, and unique.

- `201 Created` — customer registered.
- `400 Bad Request` — invalid input or malformed JSON.
- `409 Conflict` — an account with that email already exists.
- `413 Content Too Large` — request body exceeds the 10 KB limit.
- `429 Too Many Requests` — more than 10 attempts in 15 minutes from the same client.
- `500 Internal Server Error` — unexpected server error.

Health checks: `/health/live` indicates the process is running; `/health/ready` verifies database connectivity and is used by Compose.

## API documentation

- Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI 3.0 JSON: `http://localhost:3000/openapi.json`
- Specification source: `src/openapi.json`
