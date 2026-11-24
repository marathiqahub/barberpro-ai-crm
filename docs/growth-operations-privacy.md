# Growth, booking retention and customer privacy workflows

This change extends the existing CRM, reminder worker, Razorpay checkout, POS, inventory and AI booking foundations. It is additive: it does not modify existing accounts, appointments, invoices or production data. The migration adds new policy, waitlist, profile, consent and data-rights structures and adds nullable/defaulted columns to existing records.

## 1. Appointment reminders and reply actions

New reminder template keys (create one active template per shop and channel):
- `APPOINTMENT_REMINDER_24H`
- `APPOINTMENT_REMINDER_2H`
- `WAITLIST_OFFER`
- `REBOOKING_NUDGE`
- `REVIEW_REQUEST` (WhatsApp only; replies are routed by the webhook)

For WhatsApp templates, configure the approved provider template name (Meta template name, or Twilio Content SID), and set the template language code (`en_US`, `hi`, `mr`, or a supported regional variant). The approved template should use one body variable for the reference number:
- Appointment reminder: `{{1}}` is the appointment ID. Include instructions to reply `CONFIRM {{1}}` or `CANCEL {{1}}`.
- Waitlist offer: `{{1}}` is the waitlist entry ID. Include instructions to reply `ACCEPT {{1}}` or `DECLINE {{1}}`; offers expire after 15 minutes.
- Review request: `{{1}}` is the completed appointment ID. Ask the customer to reply `RATE 1 {{1}}` through `RATE 5 {{1}}`. Ratings 4–5 receive the configured Google review link; ratings 1–3 are stored as private shop feedback.
- Rebooking nudge: `{{1}}` is the customer's most recent completed appointment reference.

For SMS/email templates, use `{{shop_name}}`, `{{customer_name}}`, `{{appointment_id}}` and, for waitlist offers, `{{waitlist_entry_id}}` in the saved message body. Template body text for WhatsApp is managed and approved in Meta/Twilio; the app passes the reference as template parameter 1.

Reminders are queued only when the customer has active channel consent, the channel is enabled for the shop, the destination matches the verified account contact, and an active matching template exists. The worker also checks consent again at send time. Transient provider failures retry with bounded backoff (up to five attempts); configuration/template failures are surfaced in the admin Failed reminders panel and can be manually requeued after setup.

### India SMS DLT gate

For domestic Indian (+91) SMS through Twilio, the worker refuses delivery unless:
- `TWILIO_DLT_PE_ID` is set to the registered Principal Entity ID.
- The SMS template's `providerTemplateName` contains the approved DLT Content Template ID.
- The shop has configured its sender and enabled SMS.

Set `TWILIO_DLT_PE_ID` in both the web service and reminder Cron service after DLT registration. Do not enable a non-DLT route unless the Twilio account is deliberately configured for an eligible international route. Template registration/approval is an external provider process; BarberPro does not register the business or obtain approvals.

### Worker scheduling

`npm run reminders:deliver` now:
- sends due 24-hour and 2-hour reminder jobs;
- expires 15-minute waitlist offers and offers the slot to the next matching customer;
- queues due rebooking nudges based on the customer's saved interval (new preference default: 21 days);
- queues post-visit WhatsApp review prompts two hours after a completed appointment.

The repository Blueprint declares `barberpro-reminder-delivery` as a Starter Cron service running every minute. This PR does not sync the Blueprint or create/upgrade a Render service. Confirm the Cron service exists and is deployed before expecting automated delivery.

## 2. Deposits, cancellation policy and no-show fees

Admin policy API:
- `GET /api/admin/shops/:shopId/booking-policy`
- `PUT /api/admin/shops/:shopId/booking-policy`

The workspace UI accepts fixed deposits in rupees or percentages. The API stores fixed deposits in paise and percentages in basis points. A configured deposit is written to the appointment when booked; the customer is directed to Razorpay checkout. Front-desk/WhatsApp confirmation is blocked until the deposit is captured.

The customer cancellation route and WhatsApp cancellation command enforce the shop's cancellation notice window. Admin/front-desk overrides remain available. The free-text policy is displayed in the customer workspace.

A no-show fee is recorded as due when staff mark an appointment NO_SHOW. The customer can pay it through Razorpay. BarberPro does **not** automatically charge a saved card or payment mandate, and does not automatically refund deposits on cancellation. Shops must write their refund/no-show terms clearly and collect any fee through an authorized checkout/POS flow.

## 3. Waitlist and slot auto-fill

Customers can join a shop/service/date waitlist with optional barber and time preferences. When a customer or front desk cancels an appointment, the oldest matching waitlist entry is offered that slot. The offer lasts 15 minutes. Declining, expiry, or a slot conflict moves the offer to the next matching customer. Acceptance rechecks the slot and applies any configured deposit before creating the appointment.

WhatsApp reply commands: `ACCEPT <waitlist-entry-id>` and `DECLINE <waitlist-entry-id>`. Customers can also accept/decline offers in the customer workspace.

## 4. Rebooking and reviews

Customer preference API:
- `PUT /api/customer/shops/:shopId/preferences`

The customer workspace captures preferred barber/service, usual interval, optional skin/allergy notes with explicit profile-notes consent, and before/after HTTPS photo references with separate photo consent. Photo binaries are **not uploaded** by this change; use an approved private object-storage service and provide protected HTTPS references. Do not use public image URLs for sensitive client photos.

Due customers are visible through `GET /api/admin/shops/:shopId/rebooking-due`. The reminder worker queues one nudge per completed appointment and channel, only with active consent and a matching approved template.

The customer review form and WhatsApp reply flow route high ratings to the configured Google review URL and store low ratings as private feedback.

## 5. POS retail products, walk-ins and close

Retail products reuse the shop inventory ledger:
- Set `retailPricePaise` when creating an inventory item or update it through `PUT /api/admin/shops/:shopId/inventory/items/:itemId/retail-price`.
- Read the POS catalog through `GET /api/admin/shops/:shopId/inventory/retail-products`.
- Send `inventoryItemId` on an invoice line to use the stored retail price. Checkout locks and deducts stock in the same invoice transaction and writes a CONSUMPTION stock movement. Checkout is rejected if stock is insufficient or the retail price is unset.

Existing walk-in appointment creation, cash/UPI/card/Razorpay split tenders and daily cash-close reconciliation are retained. The front-desk workspace now exposes the POS and daily cash-close forms directly; the admin invoice form also supports retail stock lines. Front-desk retail catalog: `GET /api/front-desk/shops/:shopId/retail-products`. A closed business date rejects subsequent invoices.

## 6. Live queue

Open `/queue/:shopId` on a tablet or TV. The screen refreshes every five seconds and shows ticket ID, service and barber only—no customer names or phone numbers.

## 7. AI receptionist booking handoff

When the receptionist detects booking intent, its response includes `bookingHandoff` with the live catalog/availability endpoints and customer booking workspace URL. The receptionist still does not create, modify or confirm a booking. Customers must sign in, choose a real slot and explicitly submit the booking in the booking workspace.

## 8. Consent, export and deletion requests

Consent events are append-only and record purpose, channel, choice, notice version and source for reminder, marketing, profile-note and photo consent. Customer data export is available at `GET /api/customer/data-export` (JSON). Customers can submit export/deletion requests at `POST /api/customer/data-rights-requests`; admins review them through the data-rights panel/API.

A deletion request is a review workflow, not an immediate destructive delete. The admin status action records review/closure but deliberately does not erase data. Accounting, GST, payment, fraud and dispute records may be subject to retention obligations. Determine the applicable DPDP Act/Rules duties, notices, timelines, lawful bases and deletion/retention exceptions with Indian privacy counsel before production rollout. This feature is not a legal-compliance certification.

## API additions summary

- Public booking policy: `GET /api/shops/:shopId/booking-policy`
- Customer waitlist: `POST /api/shops/:shopId/waitlist`, `GET /api/customer/waitlist`, `POST /api/customer/waitlist/:entryId/accept`, `POST /api/customer/waitlist/:entryId/decline`
- Admin waitlist: `GET /api/admin/shops/:shopId/waitlist`
- Queue data: `GET /api/public/shops/:shopId/queue`
- Customer preferences: `PUT /api/customer/shops/:shopId/preferences`
- Customer feedback: `POST /api/customer/appointments/:appointmentId/review`
- Consent history: `POST /api/customer/shops/:shopId/consent-events`, `GET /api/admin/shops/:shopId/consent-events`
- Data export/requests: `GET /api/customer/data-export`, `POST /api/customer/data-rights-requests`, `GET /api/admin/shops/:shopId/data-rights-requests`, `PATCH /api/admin/data-rights-requests/:requestId`
- No-show fee: `POST /api/admin/shops/:shopId/appointments/:appointmentId/mark-no-show`
