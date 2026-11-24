# Payroll and messaging setup

## Payroll profiles

Admin endpoints:
- `PUT /api/admin/shops/:shopId/staff/:staffId/payroll-profile`
- `POST /api/admin/shops/:shopId/payroll-runs`
- `GET /api/admin/shops/:shopId/payroll-runs/:runId/payslips`
- `POST /api/admin/shops/:shopId/payroll-runs/:runId/approve`
- `GET /api/barber/payslips`

Set `employmentType` to `SALARIED` or `COMMISSION_ONLY` per barber. Salaried profiles support base monthly gross, commission, tips, PF/ESI applicability and configured employee/employer rates, Professional Tax, TDS withholding basis points and other deductions. Commission-only profiles calculate commission from eligible service sales and tips and do not apply salaried statutory deductions. Rates and applicability are intentionally configured by the shop administrator; obtain current Maharashtra/India payroll advice before use. The calculation is a payroll worksheet, not statutory filing, tax advice, bank transfer or guaranteed legal compliance. Review salary thresholds, wage definitions, contribution caps, PT slabs, TDS regime and effective dates with a qualified payroll professional.

## Reminders and providers

The reminder delivery worker is `npm run reminders:deliver`; schedule it as a Render Cron Job (once per minute). It claims due rows with row locks, checks active channel consent, uses shop templates and records provider attempts. Failed messages are recorded for admin review; the current worker does not auto-retry failed rows.

Configure Render secrets:
- Email: `RESEND_API_KEY`, `MAIL_FROM`
- Phone verification: `TWILIO_VERIFY_SERVICE_SID` (required before enabling SMS/WhatsApp on a customer profile)
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`
- WhatsApp Meta: `META_WHATSAPP_TOKEN`, `META_WHATSAPP_VERIFY_TOKEN`, `META_APP_SECRET`
- Optional Twilio WhatsApp: `TWILIO_WHATSAPP_FROM`

Admin configures sender IDs, templates and enabled channels through `PUT /api/admin/shops/:shopId/messaging-settings` and `PUT /api/admin/shops/:shopId/message-templates`. Customer opt-in/out is recorded at `POST /api/customer/shops/:shopId/message-consent`. WhatsApp Cloud API templates and Meta approval are required for business-initiated messages outside the customer service window.

## Customer AI booking

The customer workspace adds a guided booking assistant. It lists services, checks live availability and creates a booking request for the signed-in customer. The shop still confirms bookings. WhatsApp webhook supports SERVICES and BOOK commands; customers must add their phone to their BarberPro profile. Configure Meta webhook URL `https://YOUR-DOMAIN/api/webhooks/whatsapp`, verify token and app secret. Meta webhook signature verification is mandatory.

## Marathi

The workspace has a persistent English/मराठी language toggle and initial Marathi translations. The translation dictionary is incremental; review every screen and add missing copy before claiming full localization. Customer-entered and shop-configured content is not automatically translated.
