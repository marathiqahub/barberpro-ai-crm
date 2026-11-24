const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');
const { scheduleAppointmentReminders } = require('../messaging/reminders');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[1-9]\d*$/;

function createBookingRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const admin = [authenticate, requireRole('ADMIN')];
  const signedIn = [authenticate];

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const validId = (value) => ID_RE.test(String(value));
  const parseId = (value) => validId(value) ? Number(value) : null;

  router.get('/shops', asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, slug, address, phone, timezone
       FROM shops WHERE is_active = TRUE ORDER BY name`
    );
    res.json({ shops: result.rows });
  }));

  router.get('/shops/:shopId/services', asyncRoute(async (req, res) => {
    const shopId = parseId(req.params.shopId);
    if (!shopId) return res.status(400).json({ error: 'Invalid shop id.' });
    const result = await pool.query(
      `SELECT id, name, description, duration_minutes, price
       FROM services WHERE shop_id = $1 AND is_active = TRUE ORDER BY name`,
      [shopId]
    );
    res.json({ services: result.rows });
  }));

  router.get('/shops/:shopId/availability', asyncRoute(async (req, res) => {
    const shopId = parseId(req.params.shopId);
    const serviceId = parseId(req.query.serviceId);
    const staffId = req.query.staffId === undefined ? null : parseId(req.query.staffId);
    const date = req.query.date;
    if (!shopId || !serviceId || (req.query.staffId !== undefined && !staffId) || typeof date !== 'string' || !DATE_RE.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00.000Z')) || new Date(date + 'T00:00:00.000Z').toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'Provide valid shopId, serviceId and date (YYYY-MM-DD); staffId is optional.' });
    }

    const result = await pool.query(
      `WITH context AS (
         SELECT s.id AS shop_id, s.timezone, sv.id AS service_id, sv.duration_minutes
         FROM shops s JOIN services sv ON sv.shop_id = s.id
         WHERE s.id = $1 AND s.is_active = TRUE AND sv.id = $2 AND sv.is_active = TRUE
       ),
       candidates AS (
         SELECT st.id AS staff_id, st.display_name,
                slot AS starts_at,
                slot + make_interval(mins => c.duration_minutes) AS ends_at,
                c.timezone
         FROM context c
         JOIN shop_staff st ON st.shop_id = c.shop_id AND st.is_active = TRUE
         JOIN staff_working_hours wh ON wh.staff_id = st.id
           AND wh.day_of_week = EXTRACT(DOW FROM $3::date)::int AND wh.is_active = TRUE
         CROSS JOIN LATERAL generate_series(
           (($3::date + wh.opens_at) AT TIME ZONE c.timezone),
           ((($3::date + wh.closes_at) - make_interval(mins => c.duration_minutes)) AT TIME ZONE c.timezone),
           INTERVAL '15 minutes'
         ) slot
         WHERE ($4::bigint IS NULL OR st.id = $4)
           AND (NOT EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id)
                OR EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id AND ss.service_id = c.service_id))
       )
       SELECT c.staff_id, c.display_name, c.starts_at, c.ends_at
       FROM candidates c
       WHERE c.starts_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM appointments a
           WHERE a.staff_id = c.staff_id AND a.status IN ('BOOKED','CONFIRMED')
             AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(c.starts_at, c.ends_at, '[)')
         )
         AND NOT EXISTS (
           SELECT 1 FROM staff_time_off t
           WHERE t.staff_id = c.staff_id
             AND tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(c.starts_at, c.ends_at, '[)')
         )
       ORDER BY c.starts_at, c.display_name`,
      [shopId, serviceId, date, staffId]
    );
    res.json({ date, slots: result.rows });
  }));

  router.post('/shops', ...admin, asyncRoute(async (req, res) => {
    const { name, slug, address = null, phone = null, timezone = 'Asia/Kolkata' } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 160 ||
        typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
        typeof timezone !== 'string' || timezone.length > 80) {
      return res.status(400).json({ error: 'Valid name, URL-safe slug and IANA timezone are required.' });
    }
    const validTimezone = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
    if (!validTimezone.rowCount) return res.status(400).json({ error: 'timezone must be a valid IANA timezone.' });
    try {
      const result = await pool.query(
        `INSERT INTO shops (name, slug, address, phone, timezone)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, slug, address, phone, timezone, is_active`,
        [name.trim(), slug, address, phone, timezone]
      );
      res.status(201).json({ shop: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Shop slug already exists.' });
      if (error.code === '22023') return res.status(400).json({ error: 'Invalid timezone.' });
      throw error;
    }
  }));

  router.post('/shops/:shopId/staff', ...admin, asyncRoute(async (req, res) => {
    const shopId = parseId(req.params.shopId);
    const userId = parseId(req.body?.userId);
    const displayName = req.body?.displayName;
    if (!shopId || !userId || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 120) {
      return res.status(400).json({ error: 'Valid shopId, userId and displayName are required.' });
    }
    const result = await pool.query(
      `INSERT INTO shop_staff (shop_id, user_id, display_name)
       SELECT sh.id, u.id, $3 FROM shops sh CROSS JOIN users u
       WHERE sh.id = $1 AND sh.is_active = TRUE
         AND u.id = $2 AND u.role = 'BARBER' AND u.is_active = TRUE
       RETURNING id, shop_id, user_id, display_name, is_active`,
      [shopId, userId, displayName.trim()]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Active BARBER user or shop not found.' });
    res.status(201).json({ staff: result.rows[0] });
  }));

  router.post('/shops/:shopId/services', ...admin, asyncRoute(async (req, res) => {
    const shopId = parseId(req.params.shopId);
    const { name, description = null, durationMinutes, price } = req.body ?? {};
    if (!shopId || typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240 ||
        typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Provide shop, name, durationMinutes (5–240) and a non-negative numeric price.' });
    }
    const result = await pool.query(
      `INSERT INTO services (shop_id, name, description, duration_minutes, price)
       SELECT id, $2, $3, $4, $5 FROM shops WHERE id = $1 AND is_active = TRUE
       RETURNING id, shop_id, name, description, duration_minutes, price, is_active`,
      [shopId, name.trim(), description, durationMinutes, price]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Active shop not found.' });
    res.status(201).json({ service: result.rows[0] });
  }));

  // Weekly hours recur on every matching weekday in the shop's timezone.
  router.get('/staff/:staffId/hours', ...admin, asyncRoute(async (req, res) => {
    const staffId = parseId(req.params.staffId);
    if (!staffId) return res.status(400).json({ error: 'Invalid staff id.' });
    const staff = await pool.query('SELECT id FROM shop_staff WHERE id = $1', [staffId]);
    if (!staff.rowCount) return res.status(404).json({ error: 'Staff member not found.' });
    const result = await pool.query(
      `SELECT staff_id, day_of_week, opens_at, closes_at, is_active FROM staff_working_hours WHERE staff_id = $1 ORDER BY day_of_week`,
      [staffId]
    );
    res.json({ staffId, weeklySchedule: result.rows });
  }));

  router.put('/staff/:staffId/hours/weekly', ...admin, asyncRoute(async (req, res) => {
    const staffId = parseId(req.params.staffId);
    const days = req.body?.weeklySchedule;
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!staffId || !Array.isArray(days) || days.length !== 7) return res.status(400).json({ error: 'Provide weeklySchedule with exactly seven day entries (0=Sunday…6=Saturday).' });
    const seen = new Set();
    for (const day of days) {
      if (!day || !Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 0 || day.dayOfWeek > 6 || seen.has(day.dayOfWeek) || typeof day.opensAt !== 'string' || !timePattern.test(day.opensAt) || typeof day.closesAt !== 'string' || !timePattern.test(day.closesAt) || day.opensAt >= day.closesAt || typeof day.isActive !== 'boolean') {
        return res.status(400).json({ error: 'Each day needs a unique dayOfWeek (0–6), valid opensAt/closesAt, and boolean isActive. Use isActive=false for a closed day.' });
      }
      seen.add(day.dayOfWeek);
    }
    if (seen.size !== 7) return res.status(400).json({ error: 'Every day from Sunday (0) through Saturday (6) must be included.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const staff = await client.query('SELECT id FROM shop_staff WHERE id = $1 FOR UPDATE', [staffId]);
      if (!staff.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Staff member not found.' }); }
      for (const day of days) {
        await client.query(
          `INSERT INTO staff_working_hours (staff_id, day_of_week, opens_at, closes_at, is_active) VALUES ($1, $2, $3::time, $4::time, $5) ON CONFLICT (staff_id, day_of_week) DO UPDATE SET opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at, is_active = EXCLUDED.is_active`,
          [staffId, day.dayOfWeek, day.opensAt, day.closesAt, day.isActive]
        );
      }
      const result = await client.query('SELECT staff_id, day_of_week, opens_at, closes_at, is_active FROM staff_working_hours WHERE staff_id = $1 ORDER BY day_of_week', [staffId]);
      await client.query('COMMIT');
      res.json({ staffId, weeklySchedule: result.rows, recurring: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
  router.put('/staff/:staffId/hours', ...admin, asyncRoute(async (req, res) => {
    const staffId = parseId(req.params.staffId);
    const { dayOfWeek, opensAt, closesAt, isActive = true } = req.body ?? {};
    if (!staffId || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 ||
        typeof opensAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(opensAt) ||
        typeof closesAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(closesAt) ||
        opensAt >= closesAt || typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'Provide dayOfWeek (0=Sunday…6=Saturday), opensAt, closesAt and optional isActive.' });
    }
    const result = await pool.query(
      `INSERT INTO staff_working_hours (staff_id, day_of_week, opens_at, closes_at, is_active)
       SELECT id, $2, $3::time, $4::time, $5 FROM shop_staff WHERE id = $1
       ON CONFLICT (staff_id, day_of_week) DO UPDATE
       SET opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at, is_active = EXCLUDED.is_active
       RETURNING *`,
      [staffId, dayOfWeek, opensAt, closesAt, isActive]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Staff member not found.' });
    res.json({ workingHours: result.rows[0] });
  }));

  router.post('/staff/:staffId/services/:serviceId', ...admin, asyncRoute(async (req, res) => {
    const staffId = parseId(req.params.staffId);
    const serviceId = parseId(req.params.serviceId);
    if (!staffId || !serviceId) return res.status(400).json({ error: 'Invalid staff or service id.' });
    const result = await pool.query(
      `INSERT INTO staff_services (staff_id, service_id)
       SELECT st.id, sv.id FROM shop_staff st JOIN services sv ON sv.shop_id = st.shop_id
       WHERE st.id = $1 AND sv.id = $2
       ON CONFLICT DO NOTHING RETURNING staff_id, service_id`,
      [staffId, serviceId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Staff member or matching shop service not found.' });
    res.status(201).json({ staffService: result.rows[0] });
  }));

  router.post('/staff/:staffId/time-off', ...admin, asyncRoute(async (req, res) => {
    const staffId = parseId(req.params.staffId);
    const { startsAt, endsAt, reason = null } = req.body ?? {};
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!staffId || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return res.status(400).json({ error: 'Valid ISO startsAt and endsAt are required.' });
    }
    const result = await pool.query(
      `INSERT INTO staff_time_off (staff_id, starts_at, ends_at, reason)
       SELECT id, $2, $3, $4 FROM shop_staff WHERE id = $1
       RETURNING *`,
      [staffId, new Date(start).toISOString(), new Date(end).toISOString(), reason]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Staff member not found.' });
    res.status(201).json({ timeOff: result.rows[0] });
  }));

  router.post('/appointments', ...signedIn, asyncRoute(async (req, res) => {
    if (req.user.role !== 'CUSTOMER') return res.status(403).json({ error: 'Only customer accounts can book appointments.' });
    const { shopId: rawShopId, serviceId: rawServiceId, staffId: rawStaffId, startsAt, customerNotes = null } = req.body ?? {};
    const shopId = parseId(rawShopId);
    const serviceId = parseId(rawServiceId);
    const staffId = parseId(rawStaffId);
    const startMs = Date.parse(startsAt);
    if (!shopId || !serviceId || !staffId || !Number.isFinite(startMs) || typeof startsAt !== 'string' || !startsAt.includes('T') || (customerNotes !== null && (typeof customerNotes !== 'string' || customerNotes.length > 1000))) {
      return res.status(400).json({ error: 'Provide shopId, serviceId, staffId and an ISO startsAt timestamp.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const slot = await client.query(
        `SELECT sh.timezone, sv.duration_minutes, wh.opens_at, wh.closes_at,
                (($4::timestamptz AT TIME ZONE sh.timezone)::date) AS local_date
         FROM shops sh
         JOIN services sv ON sv.shop_id = sh.id AND sv.id = $2 AND sv.is_active = TRUE
         JOIN shop_staff st ON st.shop_id = sh.id AND st.id = $3 AND st.is_active = TRUE
         JOIN staff_working_hours wh ON wh.staff_id = st.id
           AND wh.day_of_week = EXTRACT(DOW FROM ($4::timestamptz AT TIME ZONE sh.timezone))::int
           AND wh.is_active = TRUE
         WHERE sh.id = $1 AND sh.is_active = TRUE
           AND ($3::bigint IS NOT NULL)
           AND ($4::timestamptz AT TIME ZONE sh.timezone) >=
               ((($4::timestamptz AT TIME ZONE sh.timezone)::date + wh.opens_at))
           AND (($4::timestamptz AT TIME ZONE sh.timezone) + make_interval(mins => sv.duration_minutes)) <=
               ((($4::timestamptz AT TIME ZONE sh.timezone)::date + wh.closes_at))
           AND EXTRACT(MINUTE FROM ($4::timestamptz AT TIME ZONE sh.timezone))::int % 15 = 0
           AND EXTRACT(SECOND FROM ($4::timestamptz AT TIME ZONE sh.timezone)) = 0
           AND (NOT EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id)
                OR EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id AND ss.service_id = sv.id))
           AND NOT EXISTS (SELECT 1 FROM staff_time_off t WHERE t.staff_id = st.id
             AND tstzrange(t.starts_at,t.ends_at,'[)') && tstzrange($4::timestamptz,$4::timestamptz + make_interval(mins => sv.duration_minutes),'[)'))
           AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.staff_id = st.id
             AND a.status IN ('BOOKED','CONFIRMED')
             AND tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange($4::timestamptz,$4::timestamptz + make_interval(mins => sv.duration_minutes),'[)'))
         FOR UPDATE OF st`,
        [shopId, serviceId, staffId, new Date(startMs).toISOString()]
      );
      if (!slot.rowCount || startMs <= Date.now()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'That appointment slot is unavailable. Refresh availability and choose another time.' });
      }
      const inserted = await client.query(
        `INSERT INTO appointments (shop_id, staff_id, service_id, customer_id, starts_at, ends_at, customer_notes)
         VALUES ($1,$2,$3,$4,$5,$5::timestamptz + make_interval(mins => $6),$7)
         RETURNING id, shop_id, staff_id, service_id, customer_id, starts_at, ends_at, status, customer_notes, created_at`,
        [shopId, staffId, serviceId, req.user.id, new Date(startMs).toISOString(), slot.rows[0].duration_minutes, customerNotes]
      );
      await scheduleAppointmentReminders(client,inserted.rows[0],{transactional:true});
      await client.query('COMMIT');
      res.status(201).json({ appointment: inserted.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23P01' || error.code === '23505') {
        return res.status(409).json({ error: 'That appointment slot was just booked. Choose another time.' });
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/appointments/mine', ...signedIn, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.customer_notes,
              sh.id AS shop_id, sh.name AS shop_name, sh.address AS shop_address,
              sv.id AS service_id, sv.name AS service_name, sv.duration_minutes, sv.price,
              st.id AS staff_id, st.display_name AS staff_name
       FROM appointments a JOIN shops sh ON sh.id = a.shop_id
       JOIN services sv ON sv.id = a.service_id
       JOIN shop_staff st ON st.id = a.staff_id
       WHERE a.customer_id = $1 ORDER BY a.starts_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ appointments: result.rows });
  }));

  router.patch('/appointments/:appointmentId/cancel', ...signedIn, asyncRoute(async (req, res) => {
    const appointmentId = parseId(req.params.appointmentId);
    if (!appointmentId) return res.status(400).json({ error: 'Invalid appointment id.' });
    const result = await pool.query(
      `UPDATE appointments SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND status IN ('BOOKED','CONFIRMED')
         AND starts_at > NOW()
         AND (customer_id = $2 OR $3 = 'ADMIN')
       RETURNING id, status, starts_at, ends_at`,
      [appointmentId, req.user.id, req.user.role]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Upcoming appointment not found or cannot be cancelled.' });
    await pool.query("UPDATE shop_customer_reminders SET status='CANCELLED',processing_at=NULL WHERE appointment_id=$1 AND status IN ('PENDING','PROCESSING')",[appointmentId]);
    res.json({ appointment: result.rows[0] });
  }));

  return router;
}

module.exports = { createBookingRouter };
