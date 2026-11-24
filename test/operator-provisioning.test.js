const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createServer } = require('node:http');

const secret = 'unit-test-operator-secret-at-least-32-bytes';

function createPool({ existingUsers = [], existingShops = [] } = {}) {
  let nextUserId = 1;
  let nextShopId = 101;
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'SELECT email FROM users WHERE email = ANY($1::text[])') return { rows: existingUsers, rowCount: existingUsers.length };
      if (sql === 'SELECT slug FROM shops WHERE slug = ANY($1::text[])') return { rows: existingShops, rowCount: existingShops.length };
      if (sql === 'SELECT 1 FROM pg_timezone_names WHERE name = $1') return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: nextUserId++, name: params[0], email: params[1], role: params[3] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO shops')) {
        return { rows: [{ id: nextShopId++, name: params[0], slug: params[1], timezone: params[2] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO shop_staff')) {
        return { rows: [{ id: 501, shop_id: params[0], user_id: params[1], display_name: params[2], is_active: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { queries, async connect() { return client; } };
}

async function withServer(pool, callback) {
  process.env.OPERATOR_PROVISIONING_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.use('/api/operator', require('../src/routes/operatorRoutes').createOperatorRouter(pool));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await callback('http://127.0.0.1:' + address.port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const payload = {
  admin: { firstName: 'Test', lastName: 'Admin', email: 'testAdmin@gmail.com' },
  shops: [
    { name: 'BranchOne', slug: 'branch-one', barber: { firstName: 'Barber', lastName: 'One', email: 'testbarberOne@gmail.com' } },
    { name: 'BranchTwo', slug: 'branch-two', barber: { firstName: 'Barber', lastName: 'Two', email: 'testbarberTwo@gmail.com' } },
    { name: 'BranchThree', slug: 'branch-three', barber: { firstName: 'Barber', lastName: 'Three', email: 'testbarberThree@gmail.com' } }
  ]
};

test('operator batch provisioning creates one admin, three shops and isolated barber memberships', async () => {
  const pool = createPool();
  await withServer(pool, async baseUrl => {
    const response = await fetch(baseUrl + '/api/operator/provision-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-secret': secret },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.admin.email, 'testadmin@gmail.com');
    assert.equal(body.admin.role, 'ADMIN');
    assert.equal(body.shops.length, 3);
    assert.equal(body.activationTokens.length, 4);
    assert.deepEqual(body.shops.map(item => item.shop.slug), ['branch-one', 'branch-two', 'branch-three']);
    assert.deepEqual(body.shops.map(item => item.barber.email), ['testbarberone@gmail.com', 'testbarbertwo@gmail.com', 'testbarberthree@gmail.com']);
    assert.ok(body.shops.every(item => item.membership.shop_id === item.shop.id));
    assert.ok(body.shops.every(item => item.membership.user_id === item.barber.id));
    assert.equal(pool.queries.filter(item => item.sql === 'COMMIT').length, 1);
  });
});

test('operator batch provisioning rejects a wrong secret and duplicate request emails', async () => {
  const pool = createPool();
  await withServer(pool, async baseUrl => {
    const unauthorized = await fetch(baseUrl + '/api/operator/provision-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-secret': 'incorrect-secret' },
      body: JSON.stringify(payload)
    });
    assert.equal(unauthorized.status, 404);
    const duplicate = structuredClone(payload);
    duplicate.shops[1].barber.email = duplicate.shops[0].barber.email;
    const invalid = await fetch(baseUrl + '/api/operator/provision-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-secret': secret },
      body: JSON.stringify(duplicate)
    });
    assert.equal(invalid.status, 400);
    assert.equal(pool.queries.length, 0);
  });
});

test('operator batch provisioning rolls back when an email already exists', async () => {
  const pool = createPool({ existingUsers: [{ email: 'testadmin@gmail.com' }] });
  await withServer(pool, async baseUrl => {
    const response = await fetch(baseUrl + '/api/operator/provision-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-secret': secret },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 409);
    assert.ok(pool.queries.some(item => item.sql === 'ROLLBACK'));
    assert.ok(!pool.queries.some(item => item.sql === 'COMMIT'));
  });
});
