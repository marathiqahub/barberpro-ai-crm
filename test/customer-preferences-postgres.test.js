'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createServer}=require('node:http');
const {Pool}=require('pg');
const {createRetentionRouter}=require('../src/routes/retentionRoutes');
const {queueRebookingNudges}=require('../src/messaging/rebooking');

test('PostgreSQL customer preference integration', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='bp_pref_'+process.pid+'_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 let server;
 try{
  await db.query(`
   CREATE TABLE shops(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name TEXT,is_active BOOLEAN DEFAULT TRUE,timezone TEXT DEFAULT 'Asia/Kolkata');
   CREATE TABLE users(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name TEXT,email TEXT,phone TEXT,role TEXT,is_active BOOLEAN DEFAULT TRUE);
   CREATE TABLE refresh_tokens(user_id BIGINT,family_id TEXT,revoked_at TIMESTAMPTZ,expires_at TIMESTAMPTZ);
   CREATE TABLE shop_staff(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,display_name TEXT,is_active BOOLEAN DEFAULT TRUE);
   CREATE TABLE services(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,name TEXT,is_active BOOLEAN DEFAULT TRUE);
   CREATE TABLE shop_customer_profiles(shop_id BIGINT,customer_id BIGINT,preferred_staff_id BIGINT,preferred_service_id BIGINT,preferred_interval_days INT DEFAULT 21,skin_notes TEXT,allergy_notes TEXT,notes TEXT,photo_consent BOOLEAN DEFAULT FALSE,photo_consent_at TIMESTAMPTZ,before_photo_url TEXT,after_photo_url TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(shop_id,customer_id));
   CREATE TABLE shop_customer_consent_events(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,customer_id BIGINT,purpose TEXT,consent BOOLEAN,notice_version TEXT,recorded_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE shop_message_consents(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,customer_id BIGINT,channel TEXT,destination TEXT,consent BOOLEAN,consent_source TEXT,consented_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,UNIQUE(shop_id,customer_id,channel,destination));
   CREATE TABLE shop_customer_rebooking_profiles(shop_id BIGINT,customer_id BIGINT,interval_days INT DEFAULT 21,enabled BOOLEAN DEFAULT FALSE,interval_source TEXT,updated_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(shop_id,customer_id));
   CREATE TABLE shop_messaging_settings(shop_id BIGINT PRIMARY KEY,enabled_channels TEXT[]);
   CREATE TABLE shop_message_templates(shop_id BIGINT,channel TEXT,template_key TEXT,is_active BOOLEAN);
   CREATE TABLE appointments(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,customer_id BIGINT,starts_at TIMESTAMPTZ,status TEXT,service_id BIGINT);
   CREATE TABLE shop_customer_reminders(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,customer_id BIGINT,appointment_id BIGINT,channel TEXT,template_key TEXT,scheduled_at TIMESTAMPTZ,dedupe_key TEXT UNIQUE);
   CREATE TABLE shop_demo_customer_profiles(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,demo_key TEXT,display_name TEXT,preferred_barber_label TEXT,preferred_service_label TEXT,care_notes TEXT,photo_storage_consent BOOLEAN DEFAULT FALSE,marketing_consent BOOLEAN DEFAULT FALSE,whatsapp_reminders_consent BOOLEAN DEFAULT FALSE,sms_reminders_consent BOOLEAN DEFAULT FALSE,UNIQUE(shop_id,demo_key));
   CREATE TABLE shop_waitlist_entries(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,shop_id BIGINT,customer_id BIGINT,service_id BIGINT,preferred_staff_id BIGINT,requested_date DATE,preferred_time_start TIME,preferred_time_end TIME,status TEXT DEFAULT 'WAITING',created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  const shop=(await db.query("INSERT INTO shops(name) VALUES('Test shop') RETURNING id")).rows[0].id;
  const other=(await db.query("INSERT INTO shops(name) VALUES('Other shop') RETURNING id")).rows[0].id;
  const customer=(await db.query("INSERT INTO users(name,email,phone,role) VALUES('Customer','customer@test.invalid','+919876543210','CUSTOMER') RETURNING id")).rows[0].id;
  const adminUser=(await db.query("INSERT INTO users(name,email,role) VALUES('Admin','admin@test.invalid','ADMIN') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO refresh_tokens(user_id,family_id,expires_at) VALUES($1,'customer-family',NOW()+INTERVAL '1 day'),($2,'admin-family',NOW()+INTERVAL '1 day')",[customer,adminUser]);
  const staff=(await db.query("INSERT INTO shop_staff(shop_id,display_name) VALUES($1,'Barber') RETURNING id",[shop])).rows[0].id;
  const service=(await db.query("INSERT INTO services(shop_id,name) VALUES($1,'Cut') RETURNING id",[shop])).rows[0].id;
  const foreignStaff=(await db.query("INSERT INTO shop_staff(shop_id,display_name) VALUES($1,'Other barber') RETURNING id",[other])).rows[0].id;
  const foreignService=(await db.query("INSERT INTO services(shop_id,name) VALUES($1,'Other service') RETURNING id",[other])).rows[0].id;
  const app=express();app.use(express.json());
  app.use(createRetentionRouter(db,{verifyAccessToken:token=>token==='admin'?{sub:adminUser,familyId:'admin-family'}:{sub:customer,familyId:'customer-family'}}));
  server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(url,token='customer',method='GET',body)=>fetch(base+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const consentOff={preferredStaffId:null,preferredServiceId:null,photoConsent:false,profileNotesConsent:false,marketingConsent:false,whatsappConsent:false,smsConsent:false,whatsappDestination:null,smsDestination:null};

  await t.test('existing preferences load and absent consent defaults off',async()=>{
   await db.query("INSERT INTO shop_customer_profiles(shop_id,customer_id,preferred_staff_id,preferred_service_id,skin_notes,allergy_notes,notes) VALUES($1,$2,$3,$4,'skin','allergy','private')",[shop,customer,staff,service]);
   const res=await call('/customer/shops/'+shop+'/preferences');const data=await res.json();
   assert.equal(Number(data.profile.preferred_staff_id),Number(staff));assert.equal(data.consents.profileNotes,false);
   assert.equal(data.consents.marketing,false);assert.equal(data.consents.whatsapp,false);assert.equal(data.consents.sms,false);
   assert.equal(data.profile.skin_notes,null);assert.equal(data.profile.allergy_notes,null);assert.equal(data.profile.notes,null);
  });
  await t.test('withdrawal clears sensitive note columns and API redacts private notes',async()=>{
   await db.query("INSERT INTO shop_customer_consent_events(shop_id,customer_id,purpose,consent) VALUES($1,$2,'PROFILE_NOTES',TRUE)",[shop,customer]);
   const res=await call('/customer/shops/'+shop+'/preferences','customer','PUT',consentOff);assert.equal(res.status,200);
   const data=await (await call('/customer/shops/'+shop+'/preferences')).json();
   assert.equal(data.consents.profileNotes,false);assert.equal(data.profile.skin_notes,null);assert.equal(data.profile.allergy_notes,null);assert.equal(data.profile.notes,null);
   const saved=await db.query('SELECT skin_notes,allergy_notes FROM shop_customer_profiles WHERE shop_id=$1 AND customer_id=$2',[shop,customer]);
   assert.equal(saved.rows[0].skin_notes,null);assert.equal(saved.rows[0].allergy_notes,null);
  });
  await t.test('cross-shop barber and service IDs are rejected',async()=>{
   const res=await call('/customer/shops/'+shop+'/preferences','customer','PUT',{...consentOff,preferredStaffId:foreignStaff,preferredServiceId:foreignService});
   assert.equal(res.status,400);
  });
  await t.test('waitlist rejects invalid dates and times and cross-shop barbers',async()=>{
   const invalidDate=await call('/shops/'+shop+'/waitlist','customer','POST',{serviceId:service,requestedDate:'2026-02-31'});
   assert.equal(invalidDate.status,400);
   const invalidTime=await call('/shops/'+shop+'/waitlist','customer','POST',{serviceId:service,requestedDate:new Date(Date.now()+86400000).toISOString().slice(0,10),preferredTimeStart:'25:90'});
   assert.equal(invalidTime.status,400);
   const foreign=await call('/shops/'+shop+'/waitlist','customer','POST',{serviceId:service,preferredStaffId:foreignStaff,requestedDate:new Date(Date.now()+86400000).toISOString().slice(0,10)});
   assert.equal(foreign.status,404);
   const local=await call('/shops/'+shop+'/waitlist','customer','POST',{serviceId:service,preferredStaffId:staff,requestedDate:new Date(Date.now()+86400000).toISOString().slice(0,10)});
   assert.equal(local.status,201);
  });
  await t.test('rebooking queue remains empty until customer explicitly opts in',async()=>{
   await db.query("INSERT INTO appointments(shop_id,customer_id,starts_at,status,service_id) VALUES($1,$2,NOW()-INTERVAL '45 days','COMPLETED',$3)",[shop,customer,service]);
   await db.query("INSERT INTO shop_customer_rebooking_profiles(shop_id,customer_id,enabled) VALUES($1,$2,FALSE)",[shop,customer]);
   await db.query("INSERT INTO shop_message_consents(shop_id,customer_id,channel,destination,consent) VALUES($1,$2,'EMAIL','customer@test.invalid',TRUE)",[shop,customer]);
   await db.query("INSERT INTO shop_messaging_settings(shop_id,enabled_channels) VALUES($1,ARRAY['EMAIL'])",[shop]);
   await db.query("INSERT INTO shop_message_templates(shop_id,channel,template_key,is_active) VALUES($1,'EMAIL','REBOOKING_NUDGE',TRUE)",[shop]);
   await queueRebookingNudges(db);
   let rows=await db.query("SELECT id FROM shop_customer_reminders WHERE template_key='REBOOKING_NUDGE'");assert.equal(rows.rowCount,0);
   await db.query("UPDATE shop_customer_rebooking_profiles SET enabled=TRUE WHERE shop_id=$1 AND customer_id=$2",[shop,customer]);
   await queueRebookingNudges(db);
   rows=await db.query("SELECT id FROM shop_customer_reminders WHERE template_key='REBOOKING_NUDGE'");assert.equal(rows.rowCount,1);
  });
  await t.test('demo profile route writes only synthetic demo rows',async()=>{
   const before=await db.query('SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM shop_customer_profiles) profiles,(SELECT COUNT(*) FROM shop_customer_consent_events) consents');
   const res=await call('/admin/shops/'+shop+'/demo-customer-profiles','admin');assert.equal(res.status,200);
   const after=await db.query('SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM shop_customer_profiles) profiles,(SELECT COUNT(*) FROM shop_customer_consent_events) consents');
   assert.deepEqual(after.rows[0],before.rows[0]);
   const demos=await db.query('SELECT COUNT(*)::int n FROM shop_demo_customer_profiles WHERE shop_id=$1',[shop]);assert.equal(demos.rows[0].n,3);
  });
 } finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 }
});
