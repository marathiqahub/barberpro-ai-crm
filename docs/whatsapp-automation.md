# BarberPro WhatsApp automation

## What this module does

- Receives Meta WhatsApp Cloud API webhooks and verifies `X-Hub-Signature-256` against the raw request body.
- Answers inbound customer enquiries with a shop-scoped AI receptionist when the shop enables it.
- Uses only active services, published prices, active barber names and the configured booking policy as AI context. It does not invent availability or claim that a booking is confirmed.
- Reuses the existing WhatsApp commands for live service lists, slot lookup and booking requests: `SERVICES`, `SLOTS <service-id> <YYYY-MM-DD>`, and `BOOK <service-id> <staff-id> <ISO date/time>`.
- Captures unknown inbound contacts as leads, provides an inbox, and pauses AI when a customer requests a person or an admin takes over.
- Lets an admin send a human reply from the inbox. Meta's customer-service window still applies.
- Expires conversation records after 180 days of inactivity when the reminder/retention worker runs. Human-owned conversations are not purged until they leave HUMAN status.

## Required configuration

Set these values as secrets/environment variables on the existing BarberPro web service:

| Variable | Purpose |
|---|---|
| `META_APP_SECRET` | Meta app secret used to verify webhook signatures |
| `META_WHATSAPP_VERIFY_TOKEN` | Random verification token configured in Meta webhook setup |
| `META_WHATSAPP_TOKEN` | Permanent/system-user access token used for Cloud API delivery |
| `OPENAI_API_KEY` | Enables natural-language AI replies |
| `OPENAI_MODEL` | Optional model override; defaults to `gpt-4o-mini` |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible API base URL |

Never put provider secrets in the admin form or source control.

## Meta setup

1. Create/configure a Meta app with the WhatsApp product and connect the shop's WhatsApp Business Account and phone number.
2. Configure the webhook callback URL as `https://<your-app-host>/api/webhooks/whatsapp`.
3. Subscribe the WhatsApp Business Account to the `messages` webhook field.
4. Set the same verification token in Meta and `META_WHATSAPP_VERIFY_TOKEN`; set `META_APP_SECRET` and `META_WHATSAPP_TOKEN` in Render.
5. In BarberPro Admin → Customer reminders & messaging, enter the phone-number ID and enable WHATSAPP for the shop.
6. In WhatsApp AI receptionist, select the shop and language, configure the greeting and handoff keywords, then enable AI.
7. Send a customer-initiated test message from a real test number and confirm that the inbox, lead capture, AI response and handoff all work.

The AI setting does not enable the WhatsApp channel by itself. The shop must have a phone-number ID and WHATSAPP in enabled channels. This prevents an admin from accidentally activating an unconnected channel.

## Booking flow

- Customers can ask questions in natural language. The AI answers only using shop facts.
- For authoritative availability, the customer uses `SERVICES`, then `SLOTS <service-id> <YYYY-MM-DD>`.
- A booking request uses the existing validated `BOOK` command. It checks active shop/service/barber, working hours, time off and slot conflicts, then leaves the booking in the existing BOOKED state for the shop to confirm.
- Deposit and confirmation rules remain owned by the existing BarberPro booking/payment flows. The AI cannot bypass them.

## Consent and messaging rules

- AI replies are reactive to inbound messages; this module does not run promotional campaigns or initiate outbound marketing.
- Appointment reminders and rebooking messages continue to use the existing message-consent checks and Meta-approved template requirements.
- A free-form reply from an agent is subject to Meta's customer-service messaging window. If it has closed, use an approved template through the existing template workflow.
- Ask customers for only the information needed to handle their enquiry. Never request OTPs, passwords or payment-card details in chat.

## Validation and rollout

Run `npm run check` and `npm test`. Apply migration `035_whatsapp_ai_receptionist.sql` through the existing migration process. Configure Meta and OpenAI secrets only after reviewing this PR. Test using a dedicated WhatsApp test number and synthetic customer data before enabling any shop's production channel.

This PR does not modify Render resources, production environment variables, Meta settings, customer records, or deployment state.
