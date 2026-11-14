# BarberPro AI CRM

A demo repository for a barber-focused CRM with a customer registration API built with Node.js, Express, and PostgreSQL. Docker Compose starts the API and database together.

## Run with Docker Compose

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` with a strong, unique password. Do not commit `.env`.
3. Run `docker compose up --build -d`.
4. Open Swagger UI at `http://localhost:3000/api-docs` or the OpenAPI document at `http://localhost:3000/openapi.json`.

The API waits for PostgreSQL to pass its health check before starting. On first database initialization, PostgreSQL runs the SQL scripts in `db/migrations` automatically. The database data is stored in the `postgres_data` named volume.

Useful commands:

```sh
docker compose logs -f api
docker compose logs -f db
docker compose down
```

`docker compose down` preserves the database volume. To permanently remove the database data as well, run `docker compose down -v`.

PostgreSQL is not published to the host by default; the API accesses it over the private Compose network. Do not use the example password in production. For production deployments, use managed secrets, backups, and a TLS-terminating reverse proxy.

## Run without Docker

Requirements: Node.js 20+ and PostgreSQL.

1. Install dependencies with `npm install`.
2. Create a database and apply `db/migrations/001_create_customers.sql`.
3. Set `DATABASE_URL` in `.env` to your PostgreSQL connection string.
4. Start the server with `npm start` (or `npm run dev` during development).

## Customer registration API

`POST /api/customers` registers a customer. `name` and `email` are required; `phone` is optional. Emails are trimmed, lowercased, and unique.

```json
{
  "name": "Alex Morgan",
  "email": "alex@example.com",
  "phone": "+1 555 010 1234"
}
```

- `201 Created` — customer registered.
- `400 Bad Request` — invalid input or malformed JSON.
- `409 Conflict` — an account with that email already exists.
- `413 Content Too Large` — request body exceeds the 10 KB limit.
- `429 Too Many Requests` — more than 10 attempts in 15 minutes from the same client.
- `500 Internal Server Error` — unexpected server error.

## API documentation

- Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI 3.0 JSON: `http://localhost:3000/openapi.json`
- Specification source: `src/openapi.json`
