'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const migration=fs.readFileSync(path.join(root,'db/migrations/033_customer_preferences_demo_profiles.sql'),'utf8');
const routes=fs.readFileSync(path.join(root,'src/routes/retentionRoutes.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'public/retention-tools.js'),'utf8');

test('demo customer profiles are isolated from real customer accounts and consent ledgers',()=>{
 assert.match(migration,/CREATE TABLE IF NOT EXISTS shop_demo_customer_profiles/);
 assert.match(migration,/UNIQUE\(shop_id,demo_key\)/);
 assert.match(migration,/photo_storage_consent BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(migration,/marketing_consent BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(migration,/whatsapp_reminders_consent BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(migration,/sms_reminders_consent BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(migration,/ALTER COLUMN enabled SET DEFAULT FALSE/);
 const worker=fs.readFileSync(path.join(root,'scripts/deliver-reminders.js'),'utf8');
 assert.match(worker,/JOIN shop_customer_rebooking_profiles rp/);
 assert.match(worker,/rp\.enabled=TRUE/);
 assert.doesNotMatch(migration,/INSERT INTO (users|shop_customer_profiles|shop_message_consents|shop_customer_consent_events)/i);
 assert.match(routes,/\/admin\/shops\/:shopId\/demo-customer-profiles/);
 assert.match(routes,/const activeShop=await pool\.query/);
});

test('customer preferences endpoint returns persisted values and neutral consent defaults',()=>{
 assert.match(routes,/\/customer\/shops\/:shopId\/preferences/);
 assert.match(routes,/messaging:byChannel/);
 assert.match(routes,/marketing:byPurpose\.MARKETING\?\?false/);
 assert.match(routes,/whatsapp:!!byChannel\.WHATSAPP\?\.consent/);
 assert.match(routes,/sms:!!byChannel\.SMS\?\.consent/);
 assert.match(ui,/profile\.preferred_staff_id/);
 assert.match(ui,/elements\.marketing\.checked=!!consents\.marketing/);
 assert.match(ui,/elements\.whatsapp\.checked=!!consents\.whatsapp/);
 assert.match(ui,/elements\.sms\.checked=!!consents\.sms/);
 assert.match(ui,/consents\.profileNotes\?\(profile\.skin_notes/);
 assert.match(ui,/name="enabled"/);
});
