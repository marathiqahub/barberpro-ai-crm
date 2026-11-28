'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createServer}=require('node:http');
const {Pool}=require('pg');
const {createOperationsRouter}=require('../src/routes/operationsRoutes');

test('shop-scoped customer creation API', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='bp_customer_create_'+process.pid+'_'+Date.now();
 await admin.query('CREATE SCHEMA '+schema);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 let server;
 try{
  await db.query(`
   CREATE TABLE shops(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name TEXT,is_active BOOLEAN NOT NULL DEFAULT TRUE);
   CREATE TABLE users(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,phone TEXT,password_hash TEXT NOT NULL,role TEXT NOT NULL,is_active BOOLEAN NOT NULL DEFAULT TRUE,imported_pending_activation BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
   CREATE TABLE refresh_tokens(user_id BIGINT,family_id TEXT,revoked_at TIMESTAMPTZ,expires_at TIMESTAMPTZ);
   CREATE TABLE shop_front_desk(shop_id BIGINT,user_id BIGINT,is_active BOOLEAN NOT NULL DEFAULT TRUE,PRIMARY KEY(shop_id,user_id));
   CREATE TABLE shop_customer_profiles(shop_id BIGINT,customer_id BIGINT,marketing_email_consent BOOLEAN NOT NULL DEFAULT FALSE,marketing_sms_consent BOOLEAN NOT NULL DEFAULT FALSE,consent_updated_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(shop_id,customer_id));
  `);
  const shop=(await db.query("INSERT INTO shops(name) VALUES('Assigned shop') RETURNING id")).rows[0].id;
  const otherShop=(await db.query("INSERT INTO shops(name) VALUES('Other shop') RETURNING id")).rows[0].id;
  const adminId=(await db.query("INSERT INTO users(name,email,password_hash,role) VALUES('Admin','admin@create.test','x','ADMIN') RETURNING id")).rows[0].id;
  const deskId=(await db.query("INSERT INTO users(name,email,password_hash,role) VALUES('Front desk','desk@create.test','x','FRONT_DESK') RETURNING id")).rows[0].id;
  const otherDeskId=(await db.query("INSERT INTO users(name,email,password_hash,role) VALUES('Other desk','otherdesk@create.test','x','FRONT_DESK') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO shop_front_desk(shop_id,user_id) VALUES($1,$2),($3,$4)",[shop,deskId,otherShop,otherDeskId]);
  await db.query("INSERT INTO refresh_tokens(user_id,family_id,expires_at) VALUES($1,'admin-family',NOW()+INTERVAL '1 day'),($2,'desk-family',NOW()+INTERVAL '1 day'),($3,'other-family',NOW()+INTERVAL '1 day')",[adminId,deskId,otherDeskId]);
  const tokenService={verifyAccessToken(token){const map={admin:{sub:adminId,familyId:'admin-family'},desk:{sub:deskId,familyId:'desk-family'},other:{sub:otherDeskId,familyId:'other-family'}};if(!map[token])throw Error('bad token');return map[token]}};
  const app=express();app.use(express.json());app.use('/api',createOperationsRouter(db,tokenService));
  server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(shopId,token,body)=>fetch(base+'/api/shops/'+shopId+'/customers',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  await t.test('admin creates a shop-linked pending customer account',async()=>{
   const res=await call(shop,'admin',{name:'Asha Customer',email:'asha@create.test',phone:'+919876543210'});
   const data=await res.json();assert.equal(res.status,201);assert.equal(data.customer.role,'CUSTOMER');assert.equal(data.created,true);
   const saved=await db.query('SELECT imported_pending_activation,is_active,phone FROM users WHERE id=$1',[data.customer.id]);
   assert.equal(saved.rows[0].imported_pending_activation,true);assert.equal(saved.rows[0].is_active,true);assert.equal(saved.rows[0].phone,'+919876543210');
   const profile=await db.query('SELECT 1 FROM shop_customer_profiles WHERE shop_id=$1 AND customer_id=$2',[shop,data.customer.id]);assert.equal(profile.rowCount,1);
  });
  await t.test('assigned front desk can create a customer but cannot access another shop',async()=>{
   const created=await call(shop,'desk',{name:'Bina Customer',email:'bina@create.test'});assert.equal(created.status,201);
   const denied=await call(shop,'other',{name:'Wrong shop',email:'wrong@create.test'});assert.equal(denied.status,404);
  });
  await t.test('existing customer is linked without creating a duplicate account',async()=>{
   const existing=(await db.query("INSERT INTO users(name,email,password_hash,role) VALUES('Existing','existing@create.test','x','CUSTOMER') RETURNING id")).rows[0].id;
   const res=await call(shop,'admin',{name:'Changed name ignored',email:'existing@create.test',phone:'+919999999999'});
   const data=await res.json();assert.equal(res.status,200);assert.equal(data.created,false);assert.equal(Number(data.customer.id),Number(existing));
   const count=await db.query("SELECT COUNT(*)::int count FROM users WHERE email='existing@create.test'");assert.equal(count.rows[0].count,1);
  });
  await t.test('staff account email cannot be converted into a customer',async()=>{
   const res=await call(shop,'admin',{name:'Impersonation',email:'desk@create.test'});assert.equal(res.status,409);
  });
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 }
});
