# Secure batch workspace provisioning

This operator-only endpoint provisions an additional administrator, multiple shops, one barber account per shop, active staff memberships, and one-time account activation tokens in a single database transaction.

## Endpoint

After this code is deployed and migration 005 is present, send an HTTPS POST to `/api/operator/provision-workspace` with the `x-operator-secret` header. Use the existing `OPERATOR_PROVISIONING_SECRET` configured in Render. Never paste that secret into chat, a URL, or source control.

Example body:

```json
{
  "admin": {
    "firstName": "Test",
    "lastName": "Admin",
    "email": "testAdmin@gmail.com"
  },
  "shops": [
    {
      "name": "BranchOne",
      "slug": "branch-one",
      "timezone": "Asia/Kolkata",
      "barber": {
        "firstName": "Barber",
        "lastName": "One",
        "email": "testbarberOne@gmail.com"
      }
    }
  ]
}
```

Provide one to ten shops. Each shop requires a unique URL-safe slug and exactly one barber identity. Timezone defaults to `Asia/Kolkata`. The endpoint normalizes email addresses to lowercase.

## Safety and activation

- All account, shop, membership and activation-token writes occur in one transaction.
- Existing email addresses, existing shop slugs, and duplicates within the request are rejected. No partial records are committed.
- Accounts start inactive with random placeholder password hashes. No password is generated or disclosed by the operator endpoint.
- Four users in the requested example receive four separate, single-use activation tokens.
- Each user must privately activate their account at `POST /api/operator/activate` and choose their own password (12–128 characters).
- Tokens are returned only once and expire after 48 hours. Share each token only with its intended account holder; never post tokens in shared chat, tickets, or logs.
