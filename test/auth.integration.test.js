const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = test('PostgreSQL-backed API integration: auth lifecycle and customer registration', {
  skip: !databaseUrl,
  timeout: 60000
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  let serverProcess;
  let serverOutput = '';
  const port = 43187;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (const migration of ['001_create_customers.sql', '002_create_auth_tables.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', migration), 'utf8');
      await pool.query(sql);
    }

    serverProcess = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        JWT_ACCESS_SECRET: 'integration-access-secret-with-at-least-32-bytes',
        JWT_REFRESH_SECRET: 'integration-refresh-secret-different-and-long-enough'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
    serverProcess.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`API exited before becoming ready. Output: ${serverOutput}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health/ready`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, `API did not become ready. Output: ${serverOutput}`);

    async function request(route, { method = 'GET', body, token } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const emailA = `integration-a-${suffix}@example.test`;
    const password = 'integration-test-password-2026';

    // Registration persists an Argon2id hash and issues a usable token pair.
    const registered = await request('/api/auth/register', {
      method: 'POST',
      body: { name: 'Integration Customer', email: emailA, password }
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.email, emailA);
    assert.equal(registered.body.user.role, 'CUSTOMER');
    assert.ok(registered.body.tokens.accessToken);
    assert.ok(registered.body.tokens.refreshToken);

    const storedUser = await pool.query('SELECT password_hash FROM users WHERE email = $1', [emailA]);
    assert.match(storedUser.rows[0].password_hash, /^\$argon2id\$/);
    const storedRefresh = await pool.query(
      'SELECT token_hash FROM refresh_tokens WHERE user_id = $1',
      [registered.body.user.id]
    );
    assert.equal(storedRefresh.rowCount, 1);
    assert.match(storedRefresh.rows[0].token_hash, /^[a-f0-9]{64}$/);

    // Login returns tokens; /me accepts the access token.
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: emailA.toUpperCase(), password }
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, registered.body.user.id);
    const profile = await request('/api/auth/me', { token: login.body.tokens.accessToken });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.email, emailA);

    // Refresh rotates the token, and reuse of the old token revokes the family.
    const refreshed = await request('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.tokens.refreshToken }
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.tokens.refreshToken, login.body.tokens.refreshToken);
    const rotatedRows = await pool.query(
      'SELECT revoked_at, replaced_by FROM refresh_tokens WHERE id = $1',
      [(JSON.parse(Buffer.from(login.body.tokens.refreshToken.split('.')[1], 'base64url').toString())).jti]
    );
    assert.ok(rotatedRows.rows[0].revoked_at);
    assert.ok(rotatedRows.rows[0].replaced_by);

    const replay = await request('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.tokens.refreshToken }
    });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /reuse detected/i);
    const revokedProfile = await request('/api/auth/me', { token: refreshed.body.tokens.accessToken });
    assert.equal(revokedProfile.status, 401);

    // Logout revokes a separate session and immediately invalidates its access token.
    const emailB = `integration-b-${suffix}@example.test`;
    const registeredB = await request('/api/auth/register', {
      method: 'POST',
      body: { name: 'Logout Customer', email: emailB, password }
    });
    assert.equal(registeredB.status, 201);
    const logout = await request('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken: registeredB.body.tokens.refreshToken }
    });
    assert.equal(logout.status, 204);
    const afterLogout = await request('/api/auth/me', { token: registeredB.body.tokens.accessToken });
    assert.equal(afterLogout.status, 401);

    // Legacy customer registration remains public, normalized, and independent.
    const customerEmail = `legacy-customer-${suffix}@example.test`;
    const customer = await request('/api/customers', {
      method: 'POST',
      body: { name: 'Legacy Customer', email: `  ${customerEmail.toUpperCase()}  `, phone: '+91 98765 43210' }
    });
    assert.equal(customer.status, 201);
    assert.equal(customer.body.customer.email, customerEmail);
    assert.equal(customer.body.customer.phone, '+91 98765 43210');

    const duplicateCustomer = await request('/api/customers', {
      method: 'POST',
      body: { name: 'Duplicate Customer', email: customerEmail }
    });
    assert.equal(duplicateCustomer.status, 409);
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => serverProcess.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
    await pool.end();
  }
});

module.exports = integrationTest;
