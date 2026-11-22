# Secure initial workspace provisioning

This one-time bootstrap creates the initial BarberPro administrator, barber, shop and staff membership in one database transaction. It does not set or disclose user passwords.

## Configure

Set `OPERATOR_PROVISIONING_SECRET` in Render to a cryptographically random value of at least 32 bytes (for example, generate one locally with `openssl rand -base64 48`). Store it only in Render's secret environment settings. Do not commit it, paste it into chat, or put it in a URL.

## Bootstrap

After the release and migration 005 are live, send an HTTPS POST to:

`/api/operator/bootstrap`

Include header `x-operator-secret: YOUR_SECRET` and an empty JSON body. The operation is available only while no ADMIN user exists. It provisions:

- Vasundhara Kadam — `testvasu@gmail.com` — ADMIN
- Kimaya Kadam — `testkimaya@gmail.com` — BARBER
- Aai Ekveera — slug `aai-ekveera`, address `Hiwara, Maharashtra, India`, timezone `Asia/Kolkata`
- Kimaya's active staff membership at Aai Ekveera

The response contains two random, single-use activation tokens. They are stored in the database only as SHA-256 hashes and expire after 48 hours. The plaintext tokens are returned once only; share each token privately with its intended account holder. Do not save them in logs, tickets, source control, or shared chat.

## Activate

Each user submits their own token and a new password (12–128 characters) to `POST /api/operator/activate` with JSON:

```json
{ "token": "THE_PRIVATE_ONE_TIME_TOKEN", "password": "A_NEW_UNIQUE_PASSWORD" }
```

Successful activation consumes the token and enables that account. The user can then sign in at the normal login endpoint. An activation token cannot be reused. If a token expires, an operator must securely rotate/reissue it using a future administrative workflow; do not reactivate accounts by setting passwords manually in SQL.

## Security notes

- Public registration remains CUSTOMER-only.
- The bootstrap route returns 404 when the operator secret is missing, too short, or incorrect.
- The bootstrap is deliberately one-time: it refuses to run once any ADMIN exists.
- Never send the operator secret or either activation token through public channels.
