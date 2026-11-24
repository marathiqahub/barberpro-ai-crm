# BarberPro retention, queue, deposits and data-rights operations

This release adds additive database objects and shop-scoped APIs. Existing customer accounts, bookings, invoices, payments, inventory, staff and production records are not rewritten.

## 1. Appointment reminders and replies

- Customer consent: POST /api/customer/shops/:shopId/message-consent
- Admin messaging settings: PUT /api/admin/shops/:shopId/messaging-settings
- Admin templates: PUT /api/admin/shops/:shopId/message-templates

WhatsApp reminders use separate APPOINTMENT_REMINDER_24H and APPOINTMENT_REMINDER_2H template keys. A template must be active, have a provider template name, and be marked APPROVED with a provider approval reference before it is queued. The worker sends the configured provider template locale. Include an appointment identifier and reply instructions in the approved template content, for example: “Reply CONFIRM {{appointment_id}} or CANCEL {{appointment_id}}.”

The signed WhatsApp webhook accepts customer-initiated CONFIRM <appointment-id> and CANCEL <appointment-id> replies. It matches the verified customer phone to the shop and appointment. A cancellation releases the slot to the first matching waitlist entry.

**Meta lead time:** create and submit the required utility templates in WhatsApp Manager, wait for Meta approval, then save the exact approved template name, language and approval reference in BarberPro. The application does not submit templates for Meta approval.

**India SMS / DLT:** SMS delivery is held pending until both TWILIO_SMS_DLT_ENTITY_ID and TWILIO_SMS_DLT_TEMPLATE_ID are configured. Register the principal entity, sender/header and message templates with the applicable DLT operator, obtain approval, and configure the approved IDs in Render. The reminder worker leaves SMS rows pending while these IDs are absent; it does not attempt unregistered SMS delivery.

The existing barberpro-reminder-delivery Render Cron definition runs npm run reminders:deliver every minute (UTC cron schedule). Confirm that this Cron service is actually provisioned and live in Render before expecting scheduled reminders, rebooking nudges or waitlist expiry processing. It is a separate Render service and may incur additional charges; this PR does not create or enable it.

## 2. Deposits, cancellation and no-show fees

Admin policy:
- GET/PUT /api/admin/shops/:shopId/appointment-policy

Customer checkout:
- POST /api/payments/deposits/orders
- POST /api/payments/extra/:paymentId/orders
- POST /api/payments/extra/:paymentId/verify
- GET /api/customer/payments/extra

New bookings create a deposit obligation when deposits are enabled. Razorpay orders are created only when the customer explicitly starts checkout. Razorpay signatures and provider payment amounts are verified, and webhook events reconcile extra payments. AUTHORIZED is kept distinct from PAID.

Cancellation fees are assessed only inside the configured cancellation window. No-show fees are assessed when staff mark an appointment NO_SHOW. These are not automatically charged: the customer must open checkout and pay. Publish clear cancellation/refund terms before enabling fees and obtain appropriate customer acceptance. The feature does not store or silently charge a customer's card.

## 3. Waitlist and slot recovery

- Customer: POST /api/customer/shops/:shopId/waitlist, GET /api/customer/waitlist-offers, POST /api/customer/waitlist-offers/:offerId/accept
- Admin: GET /api/admin/shops/:shopId/waitlist

A cancellation offers the released time to the first matching customer by service, local date, preferred barber and optional time window. The offer expires after 15 minutes. The customer must accept it; BarberPro does not silently create a booking. WhatsApp ACCEPT <offer-id> is also supported for verified customer numbers.

## 4. Rebooking nudges

Customer preference: PUT /api/customer/shops/:shopId/rebooking-preference

The reminder worker derives a usual interval from completed visit history (default 21 days when history is insufficient), while preserving a customer-selected manual interval. A nudge is queued only when the customer has an active channel consent, the shop has enabled that channel and a message template exists. WhatsApp rebooking messages additionally require an approved provider template.

## 5. Walk-in POS, split tenders and end-of-day close

The existing front-desk walk-in flow, GST invoice flow, CASH/UPI/CARD/RAZORPAY tender allocation, split tender reconciliation and daily cash close are reused; no duplicate cash ledger is created. This PR adds retail product lines to invoice checkout. Configure a product's retail price, HSN/SAC and GST rate before selling it. Stock is deducted transactionally with the invoice and a stock movement is recorded. Insufficient stock rolls the invoice transaction back.

## 6. Live queue display

Admin: POST /api/admin/shops/:shopId/queue-displays

The response returns a one-time display URL such as /queue.html?token=.... Open it on a tablet/TV. The token is stored as a hash; the public display returns masked customer initials, service, barber and current/next queue only. Keep the URL private. Disable the display if its URL is shared unexpectedly.

## 7. Customer profile and photos

Customer: PUT /api/customer/shops/:shopId/profile/preferences

Profiles can store preferred barber/service, care notes and photo consent. Admin photo metadata:
- POST /api/admin/shops/:shopId/customers/:customerId/photos
- GET /api/admin/shops/:shopId/customers/:customerId/photos

Photo upload/storage is not provided by this change. Before recording a photo URL, configure PRIVATE_MEDIA_HOSTS with the exact private object-storage host allowlist and integrate an authenticated private upload process. The API rejects arbitrary hosts and requires recorded customer consent. Do not use public image URLs for sensitive customer photos.

## 8. Feedback and Google reviews

When an appointment is marked completed, BarberPro queues a FEEDBACK_REQUEST for channels with active consent and an active template. The customer submits a 1–5 rating through the workspace. Ratings 1–3 remain private feedback; ratings 4–5 can receive the shop's configured Google review URL. Configure it in the appointment policy. Delivery still requires provider setup and approved templates.

## 9. Retail stock and low-stock alerts

Retail stock reuses shop_inventory_items and the existing movement ledger. GET /api/admin/shops/:shopId/inventory returns low-stock items using the configured reorder level. Retail checkout creates an invoice line with an inventory reference and deducts stock atomically.

## 10. AI receptionist booking handoff

The live booking assistant already reads actual shop services and availability. It now creates a short-lived proposal and displays the selected barber, service and time for customer review. Only the separate “Confirm and request booking” action creates the appointment. The old authenticated booking endpoint remains for backward compatibility; the workspace flow uses the proposal/confirm endpoints.

## 11. Data rights and consent records

Customer:
- POST /api/customer/shops/:shopId/privacy-consents
- GET /api/customer/shops/:shopId/data-export
- POST /api/customer/shops/:shopId/data-rights-requests

Admin:
- GET /api/admin/shops/:shopId/data-rights-requests
- PATCH /api/admin/data-rights-requests/:requestId

The export includes profile, appointment, payment, feedback, consent, preference, waitlist, photo metadata and reminder records for the selected shop. Erasure is a request-and-review workflow, not an immediate destructive delete. Verify identity, assess accounting/tax and other lawful retention requirements, and obtain qualified Indian privacy counsel's guidance on DPDP Act applicability, rules, commencement and retention before completing any erasure. This implementation is an operational foundation, not a legal-compliance certification.

## External setup still required

- Meta WhatsApp utility templates and approval references.
- India DLT entity/header/template registration and Twilio DLT environment values before SMS.
- A live Render reminder Cron service; check cost before enabling it.
- PRIVATE_MEDIA_HOSTS plus a private object-storage upload process before photo storage.
- Shop Google review URL and published cancellation/deposit terms.
- Per-shop message templates and explicit customer channel consent.

No provider credentials are committed to source control. No Render environment values are changed by this PR.
