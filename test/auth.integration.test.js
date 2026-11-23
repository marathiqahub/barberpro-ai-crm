const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
    for (const migration of ['001_create_customers.sql', '002_create_auth_tables.sql', '003_create_booking_tables.sql', '004_create_payment_tables.sql', '005_create_account_activation_tokens.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', migration), 'utf8');
      await pool.query(sql);
    }

    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barberpro-razorpay-'));
    const mockPath = path.join(mockDir, 'mock-razorpay.cjs');
    fs.writeFileSync(mockPath, `
      let lastOrder;
      global.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target === 'https://api.razorpay.com/v1/orders' && options.method === 'POST') {
          const input = JSON.parse(options.body);
          lastOrder = { id: 'order_test_' + input.receipt, amount: input.amount, currency: input.currency, status: 'created' };
          return new Response(JSON.stringify(lastOrder), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target.includes('/payments/pay_test_capture_001') && options.method === 'GET') {
          if (!lastOrder) return new Response(JSON.stringify({ error: { description: 'Order missing' } }), { status: 404 });
          return new Response(JSON.stringify({
            id: 'pay_test_capture_001', order_id: lastOrder.id, amount: lastOrder.amount,
            currency: lastOrder.currency, status: 'captured'
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target.includes('/payments/pay_test_capture_001/refunds') && options.method === 'POST') {
          const input = JSON.parse(options.body);
          return new Response(JSON.stringify({
            id: 'rfnd_test_001', payment_id: 'pay_test_capture_001', amount: input.amount, status: 'processed'
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (target === 'https://api.openai.com/v1/chat/completions' && options.method === 'POST') {
          const input = JSON.parse(options.body);
          const userMessage = input.messages.find(message => message.role === 'user');
          const context = JSON.parse(userMessage.content);
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              summary: 'Bookings and captured revenue are available for the selected shops.',
              risks: ['Monitor cancellations and no-shows.'],
              opportunities: ['Review the most-booked services.'],
              actions: [{ priority: 'high', action: 'Review weekly schedule coverage', reason: 'Match staffing to booked demand.' }]
            }) } }]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: { description: 'Unexpected mocked provider request' } }), { status: 500 });
      };
    `);
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        JWT_ACCESS_SECRET: 'integration-access-secret-with-at-least-32-bytes',
        JWT_REFRESH_SECRET: 'integration-refresh-secret-different-and-long-enough',
        RAZORPAY_KEY_ID: 'rzp_test_integration_key',
        RAZORPAY_KEY_SECRET: 'integration-razorpay-key-secret',
        RAZORPAY_WEBHOOK_SECRET: 'integration-razorpay-webhook-secret',
        OPERATOR_PROVISIONING_SECRET: 'integration-operator-secret-with-at-least-32-bytes',
        OPENAI_API_KEY: 'integration-openai-api-key',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require', mockPath].filter(Boolean).join(' ')
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

    // Create a separate customer identity for appointment booking.
    const bookingCustomer = await request('/api/auth/register', {
      method: 'POST',
      body: { name: 'Booking Customer', email: `booking-${suffix}@example.test`, password }
    });
    assert.equal(bookingCustomer.status, 201);

    // Exercise multi-shop setup, barber schedules, service availability and conflict-safe booking.
    await pool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [registered.body.user.id]);
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { email: emailA, password }
    });
    assert.equal(adminLogin.status, 200);
    const shopResponse = await request('/api/shops', {
      method: 'POST',
      token: adminLogin.body.tokens.accessToken,
      body: { name: 'Integration Barber Shop', slug: `integration-${suffix}`, timezone: 'Asia/Kolkata' }
    });
    assert.equal(shopResponse.status, 201);
    const shopId = shopResponse.body.shop.id;

    const barberEmail = `barber-${suffix}@example.test`;
    const barberRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: { name: 'Integration Barber', email: barberEmail, password }
    });
    assert.equal(barberRegistration.status, 201);
    await pool.query("UPDATE users SET role = 'BARBER' WHERE id = $1", [barberRegistration.body.user.id]);

    const serviceResponse = await request(`/api/shops/${shopId}/services`, {
      method: 'POST',
      token: adminLogin.body.tokens.accessToken,
      body: { name: 'Classic Haircut', durationMinutes: 30, price: 350 }
    });
    assert.equal(serviceResponse.status, 201);
    const serviceId = serviceResponse.body.service.id;

    const staffResponse = await request(`/api/shops/${shopId}/staff`, {
      method: 'POST',
      token: adminLogin.body.tokens.accessToken,
      body: { userId: barberRegistration.body.user.id, displayName: 'Integration Barber' }
    });
    assert.equal(staffResponse.status, 201);
    const staffId = staffResponse.body.staff.id;

    // A single barber can serve a second shop through a separate membership.
    const secondShopResponse = await request('/api/shops', {
      method: 'POST', token: adminLogin.body.tokens.accessToken,
      body: { name: 'Integration Second Shop', slug: `integration-second-${suffix}`, timezone: 'Asia/Kolkata' }
    });
    assert.equal(secondShopResponse.status, 201);
    const secondShopId = secondShopResponse.body.shop.id;
    const secondServiceResponse = await request(`/api/shops/${secondShopId}/services`, {
      method: 'POST', token: adminLogin.body.tokens.accessToken,
      body: { name: 'Beard Trim', durationMinutes: 30, price: 200 }
    });
    assert.equal(secondServiceResponse.status, 201);
    const secondServiceId = secondServiceResponse.body.service.id;
    const secondStaffResponse = await request(`/api/shops/${secondShopId}/staff`, {
      method: 'POST', token: adminLogin.body.tokens.accessToken,
      body: { userId: barberRegistration.body.user.id, displayName: 'Integration Barber - Annex' }
    });
    assert.equal(secondStaffResponse.status, 201);
    const secondStaffId = secondStaffResponse.body.staff.id;
    const secondStaffService = await request(`/api/staff/${secondStaffId}/services/${secondServiceId}`, {
      method: 'POST', token: adminLogin.body.tokens.accessToken
    });
    assert.equal(secondStaffService.status, 201);

    const shopList = await request('/api/admin/shops', { token: adminLogin.body.tokens.accessToken });
    assert.equal(shopList.status, 200);
    assert.ok(shopList.body.shops.some(shop => String(shop.id) === String(shopId)));
    assert.ok(shopList.body.shops.some(shop => String(shop.id) === String(secondShopId)));
    const shopUpdate = await request(`/api/admin/shops/${secondShopId}`, {
      method: 'PATCH', token: adminLogin.body.tokens.accessToken,
      body: { address: 'Hiwara, Maharashtra', phone: '+91 98765 43210' }
    });
    assert.equal(shopUpdate.status, 200);
    assert.equal(shopUpdate.body.shop.address, 'Hiwara, Maharashtra');
    const serviceUpdate = await request(`/api/admin/services/${secondServiceId}`, {
      method: 'PATCH', token: adminLogin.body.tokens.accessToken,
      body: { price: 225, isActive: true }
    });
    assert.equal(serviceUpdate.status, 200);
    assert.equal(Number(serviceUpdate.body.service.price), 225);
    const customerCannotAdminister = await request('/api/admin/shops', {
      token: bookingCustomer.body.tokens.accessToken
    });
    assert.equal(customerCannotAdminister.status, 403);

    const staffService = await request(`/api/staff/${staffId}/services/${serviceId}`, {
      method: 'POST',
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(staffService.status, 201);

    const bookingDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const dayOfWeek = new Date(`${bookingDate}T00:00:00.000Z`).getUTCDay();
    const hours = await request(`/api/staff/${staffId}/hours`, {
      method: 'PUT',
      token: adminLogin.body.tokens.accessToken,
      body: { dayOfWeek, opensAt: '00:00', closesAt: '23:59' }
    });
    assert.equal(hours.status, 200);

    // A complete seven-day schedule is saved atomically and recurs each week.
    const weeklySchedule = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek, opensAt: '00:00', closesAt: '23:59', isActive: true
    }));
    const closedDay = (dayOfWeek + 1) % 7;
    weeklySchedule[closedDay].isActive = false; // One non-booking weekday is closed.
    const savedWeek = await request(`/api/staff/${staffId}/hours/weekly`, {
      method: 'PUT', token: adminLogin.body.tokens.accessToken,
      body: { weeklySchedule }
    });
    assert.equal(savedWeek.status, 200);
    assert.equal(savedWeek.body.recurring, true);
    assert.equal(savedWeek.body.weeklySchedule.length, 7);
    assert.equal(savedWeek.body.weeklySchedule[closedDay].is_active, false);
    const readWeek = await request(`/api/staff/${staffId}/hours`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(readWeek.status, 200);
    assert.equal(readWeek.body.weeklySchedule.length, 7);
    const invalidWeek = await request(`/api/staff/${staffId}/hours/weekly`, {
      method: 'PUT', token: adminLogin.body.tokens.accessToken,
      body: { weeklySchedule: weeklySchedule.slice(0, 6) }
    });
    assert.equal(invalidWeek.status, 400);

    const secondWeek = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek, opensAt: '00:00', closesAt: '23:59', isActive: true
    }));
    const secondWeeklyHours = await request(`/api/staff/${secondStaffId}/hours/weekly`, {
      method: 'PUT', token: adminLogin.body.tokens.accessToken,
      body: { weeklySchedule: secondWeek }
    });
    assert.equal(secondWeeklyHours.status, 200);

    const availability = await request(`/api/shops/${shopId}/availability?serviceId=${serviceId}&staffId=${staffId}&date=${bookingDate}`);
    assert.equal(availability.status, 200);
    assert.ok(availability.body.slots.length > 0);
    const startsAt = `${bookingDate}T04:30:00.000Z`; // 10:00 in the shop's Asia/Kolkata timezone.
    const booking = await request('/api/appointments', {
      method: 'POST',
      token: bookingCustomer.body.tokens.accessToken,
      body: { shopId, serviceId, staffId, startsAt, customerNotes: 'Integration test booking' }
    });
    assert.equal(booking.status, 201);
    const duplicateBooking = await request('/api/appointments', {
      method: 'POST',
      token: bookingCustomer.body.tokens.accessToken,
      body: { shopId, serviceId, staffId, startsAt }
    });
    assert.equal(duplicateBooking.status, 409);

    // The same customer can book and view appointments from a second shop.
    const secondBooking = await request('/api/appointments', {
      method: 'POST', token: bookingCustomer.body.tokens.accessToken,
      body: { shopId: secondShopId, serviceId: secondServiceId, staffId: secondStaffId, startsAt }
    });
    assert.equal(secondBooking.status, 201);
    const myAppointments = await request('/api/appointments/mine', { token: bookingCustomer.body.tokens.accessToken });
    assert.ok(myAppointments.body.appointments.some(item => String(item.id) === String(booking.body.appointment.id)));
    assert.ok(myAppointments.body.appointments.some(item => String(item.id) === String(secondBooking.body.appointment.id)));
    assert.ok(myAppointments.body.appointments.some(item => item.shop_name === 'Integration Second Shop'));
    const secondShopCancel = await request(`/api/appointments/${secondBooking.body.appointment.id}/cancel`, {
      method: 'PATCH', token: bookingCustomer.body.tokens.accessToken
    });
    assert.equal(secondShopCancel.status, 200);
    assert.equal(secondShopCancel.body.appointment.status, 'CANCELLED');

    // Razorpay test-mode order, checkout signature and provider capture verification.
    const orderResponse = await request('/api/payments/orders', {
      method: 'POST', token: bookingCustomer.body.tokens.accessToken,
      body: { appointmentId: booking.body.appointment.id }
    });
    assert.equal(orderResponse.status, 201);
    assert.equal(orderResponse.body.order.amount, 35000);
    const orderId = orderResponse.body.order.id;
    const paymentId = 'pay_test_capture_001';
    const signature = crypto.createHmac('sha256', 'integration-razorpay-key-secret')
      .update(orderId + '|' + paymentId).digest('hex');
    const verified = await request('/api/payments/verify', {
      method: 'POST', token: bookingCustomer.body.tokens.accessToken,
      body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.payment.status, 'CAPTURED');

    // Barber route is date/shop scoped; invalid BOOKED -> COMPLETED is rejected.
    const barberLogin = await request('/api/auth/login', {
      method: 'POST', body: { email: barberEmail, password }
    });
    assert.equal(barberLogin.status, 200);
    const barberDashboard = await request('/api/barber/dashboard', { token: barberLogin.body.tokens.accessToken });
    assert.equal(barberDashboard.status, 200);
    assert.ok(barberDashboard.body.shops.some(item => String(item.shop_id) === String(shopId)));
    assert.ok(barberDashboard.body.shops.some(item => String(item.shop_id) === String(secondShopId)));
    const barberAppointments = await request(
      `/api/barber/appointments?from=${bookingDate}&to=${bookingDate}&shopId=${shopId}`,
      { token: barberLogin.body.tokens.accessToken }
    );
    assert.equal(barberAppointments.status, 200);
    assert.ok(barberAppointments.body.appointments.some(item => String(item.id) === String(booking.body.appointment.id)));
    assert.ok(barberAppointments.body.appointments.every(item => String(item.shop_id) === String(shopId)));

    // Barber self-service break management: own membership only, no overlap with
    // booked appointments, visible in availability, and cancellable by its owner.
    const overlappingBreak = await request('/api/barber/time-off', {
      method: 'POST', token: barberLogin.body.tokens.accessToken,
      body: { staffId, startsAt: booking.body.appointment.starts_at, endsAt: booking.body.appointment.ends_at, reason: 'Should be rejected' }
    });
    assert.equal(overlappingBreak.status, 409);
    const createdBreak = await request('/api/barber/time-off', {
      method: 'POST', token: barberLogin.body.tokens.accessToken,
      body: { staffId, startsAt: `${bookingDate}T07:30:00.000Z`, endsAt: `${bookingDate}T08:00:00.000Z`, reason: 'Lunch break' }
    });
    assert.equal(createdBreak.status, 201);
    assert.equal(createdBreak.body.timeOff.reason, 'Lunch break');
    const barberAvailability = await request('/api/barber/availability', {
      token: barberLogin.body.tokens.accessToken
    });
    assert.ok(barberAvailability.body.timeOff.some(item => String(item.id) === String(createdBreak.body.timeOff.id)));
    const slotsDuringBreak = await request(
      `/api/shops/${shopId}/availability?serviceId=${serviceId}&staffId=${staffId}&date=${bookingDate}`
    );
    assert.equal(slotsDuringBreak.status, 200);
    assert.ok(!slotsDuringBreak.body.slots.some(slot => new Date(slot.starts_at).toISOString() === `${bookingDate}T07:30:00.000Z`));
    const removedBreak = await request(`/api/barber/time-off/${createdBreak.body.timeOff.id}`, {
      method: 'DELETE', token: barberLogin.body.tokens.accessToken
    });
    assert.equal(removedBreak.status, 200);
    assert.equal(removedBreak.body.deleted, true);

    const invalidTransition = await request(`/api/barber/appointments/${booking.body.appointment.id}/status`, {
      method: 'PATCH', token: barberLogin.body.tokens.accessToken, body: { status: 'COMPLETED' }
    });
    assert.equal(invalidTransition.status, 404);
    const confirmed = await request(`/api/barber/appointments/${booking.body.appointment.id}/status`, {
      method: 'PATCH', token: barberLogin.body.tokens.accessToken, body: { status: 'CONFIRMED' }
    });
    assert.equal(confirmed.status, 200);
    const completed = await request(`/api/barber/appointments/${booking.body.appointment.id}/status`, {
      method: 'PATCH', token: barberLogin.body.tokens.accessToken, body: { status: 'COMPLETED' }
    });
    assert.equal(completed.status, 200);

    // Admin shop, staff and revenue reports reconcile with the captured payment.
    const adminDashboard = await request(`/api/admin/dashboard?from=${bookingDate}&to=${bookingDate}`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(adminDashboard.status, 200);
    assert.ok(Number(adminDashboard.body.metrics.completed) >= 1);
    assert.equal(Number(adminDashboard.body.metrics.captured_revenue_paise), 35000);
    const staffReport = await request(`/api/admin/staff-performance?from=${bookingDate}&to=${bookingDate}`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(staffReport.status, 200);
    const staffMetric = staffReport.body.staff.find(item => String(item.staff_id) === String(staffId));
    assert.ok(staffMetric);
    assert.equal(Number(staffMetric.completed), 1);
    assert.equal(Number(staffMetric.appointments), 1);
    assert.equal(Number(staffMetric.completion_rate), 100);
    assert.equal(Number(staffMetric.captured_revenue_paise), 35000);
    assert.equal(Number(staffMetric.revenue_per_completed_paise), 35000);
    assert.ok(staffReport.body.comparisonPeriod.from);
    assert.ok(staffMetric.comparison);
    assert.equal(Number(staffMetric.previous_appointments), 0);
    const shopReport = await request(`/api/admin/reports?from=${bookingDate}&to=${bookingDate}`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(shopReport.status, 200);
    assert.equal(Number(shopReport.body.report.find(item => String(item.shop_id) === String(shopId)).captured_revenue_paise), 35000);
    const reconciliation = await request('/api/payments/reconciliation', { token: adminLogin.body.tokens.accessToken });
    assert.equal(reconciliation.status, 200);
    const capturedRow = reconciliation.body.payments.find(item => String(item.appointment_id) === String(booking.body.appointment.id));
    assert.equal(capturedRow.status, 'CAPTURED');

    // A processed refund updates both refund ledger and payment reconciliation.
    const refund = await request(`/api/payments/${capturedRow.id}/refunds`, {
      method: 'POST', token: adminLogin.body.tokens.accessToken, body: { reason: 'Integration test refund' }
    });
    assert.equal(refund.status, 201);
    const afterRefund = await request('/api/payments/reconciliation', { token: adminLogin.body.tokens.accessToken });
    const refundedRow = afterRefund.body.payments.find(item => String(item.id) === String(capturedRow.id));
    assert.equal(refundedRow.status, 'REFUNDED');
    assert.equal(Number(refundedRow.refunded_paise), 35000);
    const netReport = await request(`/api/admin/reports?from=${bookingDate}&to=${bookingDate}`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(Number(netReport.body.report.find(item => String(item.shop_id) === String(shopId)).captured_revenue_paise), 0);
    const netStaffReport = await request(`/api/admin/staff-performance?from=${bookingDate}&to=${bookingDate}`, {
      token: adminLogin.body.tokens.accessToken
    });
    assert.equal(Number(netStaffReport.body.staff.find(item => String(item.staff_id) === String(staffId)).captured_revenue_paise), 0);

    // AI insights use aggregate shop data only and are protected by the Admin role.
    const aiInsights = await request('/api/admin/ai/insights', {
      method: 'POST', token: adminLogin.body.tokens.accessToken,
      body: { from: bookingDate, to: bookingDate, question: 'What should the owner improve next week?' }
    });
    assert.equal(aiInsights.status, 200);
    assert.equal(aiInsights.body.model, 'gpt-4o-mini');
    assert.match(aiInsights.body.analysis.summary, /Bookings and captured revenue/);
    const shopScopedAi = await request('/api/admin/ai/insights', {
      method: 'POST', token: adminLogin.body.tokens.accessToken,
      body: { from: bookingDate, to: bookingDate, shopId: secondShopId, question: 'How is this shop performing?' }
    });
    assert.equal(shopScopedAi.status, 200);
    assert.equal(shopScopedAi.body.scope, 'one selected shop');
    const customerAiDenied = await request('/api/admin/ai/insights', {
      method: 'POST', token: bookingCustomer.body.tokens.accessToken,
      body: { from: bookingDate, to: bookingDate, question: 'Show me all business insights.' }
    });
    assert.equal(customerAiDenied.status, 403);

    // Customer cancellation remains available for a separate unpaid booking.
    const secondStartsAt = `${bookingDate}T05:00:00.000Z`;
    const secondBooking = await request('/api/appointments', {
      method: 'POST', token: bookingCustomer.body.tokens.accessToken,
      body: { shopId, serviceId, staffId, startsAt: secondStartsAt }
    });
    assert.equal(secondBooking.status, 201);
    const cancelled = await request(`/api/appointments/${secondBooking.body.appointment.id}/cancel`, {
      method: 'PATCH', token: bookingCustomer.body.tokens.accessToken
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.appointment.status, 'CANCELLED');
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
