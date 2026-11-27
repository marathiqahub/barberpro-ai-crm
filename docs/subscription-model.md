# BarberPro SaaS subscription model

BarberPro subscriptions are **per shop/outlet** and use the existing Razorpay Subscriptions integration. Plans are stored in `barberpro_subscription_plans`; each shop's provider subscription is stored in `shop_subscriptions`. Amounts are INR paise and feature entitlements are boolean JSON flags.

## Plan setup

Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` on the server. An ADMIN creates a plan; the API creates its Razorpay plan and stores the provider ID:

`POST /api/admin/subscription-plans`

```json
{
  "code": "solo-monthly",
  "name": "Solo",
  "billingPeriod": "MONTHLY",
  "amountPaise": 49900,
  "featureEntitlements": {
    "REFERENCE_PHOTOS": false,
    "CHEMICAL_CONSENT": false,
    "TIPS": false,
    "WORKFORCE": false,
    "ACCOUNTING_EXPORT": false,
    "CUSTOMER_IMPORT": false,
    "MESSAGING_LOCALIZATION": false
  }
}
```

The amount is in paise: ₹499 = 49900. Create separate monthly and yearly plan rows because Razorpay plans have a billing period.

## Shop subscription lifecycle

- `POST /api/admin/shops/:shopId/subscription/trial` — start a 14-day trial for an existing plan, passing `planId`. One trial per shop.
- `POST /api/admin/shops/:shopId/subscription` — create Razorpay checkout; response includes `checkoutUrl`. The subscription remains provider-pending until a signed webhook confirms its status.
- `GET /api/admin/shops/:shopId/subscription` — inspect current/latest status and feature entitlements.
- `PATCH /api/admin/shops/:shopId/subscription/cancel` — cancel trial immediately, or paid subscription at period end by default. Send `{"cancelAtCycleEnd": false}` to request immediate cancellation from Razorpay.
- `GET /api/shops/:shopId/feature-entitlements` — shop-accessible feature flags.
- `POST /api/admin/subscriptions/refresh-trials` — mark elapsed trials EXPIRED.

Razorpay webhook endpoint: `POST /api/subscriptions/webhook`. Configure the provider events `subscription.activated`, `subscription.authenticated`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, and `subscription.charged`. Set `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET` to the webhook signing secret; the existing `RAZORPAY_WEBHOOK_SECRET` is accepted as a fallback. Webhook signatures are checked against the raw request body.

## Feature gating and legacy shops

Advanced feature gates read the active plan's `feature_entitlements`. Trial subscriptions grant the selected plan's entitlements only until `trial_ends_at`. Expired/cancelled subscriptions do not grant gated features. Shops with no subscription record retain legacy access so rollout does not unexpectedly lock existing customers; provision a subscription record before enforcing billing on a shop.

A shop is not considered paid merely because checkout was created. Activate access only through the verified Razorpay webhook. The subscription tables and API do not represent GST invoices, accounting entries, refunds, or payment reconciliation; those remain separate financial workflows.

## Migration

Migration `033_subscription_trial_lifecycle.sql` adds trial expiry and cancellation fields. The migration runner applies numbered migrations in order. For an existing deployment, run the normal `npm run db:migrate` command with the production database URL configured.
