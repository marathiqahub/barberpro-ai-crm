# BarberPro AI CRM

A demo repository for a barber-focused CRM with AI-assisted workflows. This repository includes a customer registration API built with Node.js, Express, and PostgreSQL, with interactive Swagger documentation.

## Customer registration API

### Requirements

- Node.js 20 or newer
- PostgreSQL

### Setup

1. Install dependencies with `npm install`.
2. Create a PostgreSQL database, then apply `db/migrations/001_create_customers.sql`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to your database connection string.
4. Start the server with `npm start` (or `npm run dev` during development).

The API listens on port `3000` by default; set `PORT` to change it.

## API documentation

- Interactive Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI 3.0 JSON: `http://localhost:3000/openapi.json`
- The source specification is `src/openapi.json`.

## `POST /api/customers`

Register a customer by sending JSON:

```json
{
  "name": "Alex Morgan",
  "email": "alex@example.com",
  "phone": "+1 555 010 1234"
}
```

`name` and `email` are required. `phone` is optional. Email addresses are normalized to lowercase and must be unique.

- `201 Created` — customer registered; returns the customer record.
- `400 Bad Request` — invalid input or malformed JSON.
- `409 Conflict` — an account with that email already exists.
- `413 Content Too Large` — request body exceeds the 10 KB limit.
- `429 Too Many Requests` — more than 10 registration attempts in 15 minutes from the same client.
- `500 Internal Server Error` — unexpected server error.

Example:

```sh
curl -X POST http://localhost:3000/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alex Morgan","email":"alex@example.com"}'
```

Use HTTPS in production, keep database credentials secret, and configure appropriate access controls and abuse monitoring before exposing the API publicly.
