const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');

const ID_RE = /^[1-9]\d*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createDashboardRouter(pool, tokenService) {
  const router = express.Router();
  const { authenticate, requireRole } = createAuthMiddleware(pool, tokenService);
  const admin = [authenticate, requireRole('ADMIN')];
  const barber = [authenticate, requireRole('BARBER')];
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const id = (value) => ID_RE.test(String(value)) ? Number(value) : null;
  const validDate = (value) => typeof value === 'string' && DATE_RE.test(value) &&
    !Number.isNaN(Date.parse(value + 'T00:00:00.000Z')) &&
    new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
  const range = (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    if ((from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to)) ||
        (from && to && from > to)) {
      res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates, with from not after to.' });
      return null;
    }
    return { from: from || new Date().toISOString().slice(0, 10), to: to || new Date().toISOString().slice(0, 10) };
  };

  // Public barber directory used by customer discovery and appointment selection.
  router.get('/shops/:shopId/staff', asyncRoute(async (req, res) => {
    const shopId = id(req.params.shopId);
    if (!shopId) return res.status(400).json({ error: 'Invalid shop id.' });
    const result = await pool.query(
      `SELECT st.id,st.display_name,
              COALESCE(json_agg(json_build_object('id',sv.id,'name',sv.name,'durationMinutes',sv.duration_minutes,'price',sv.price))
                FILTER (WHERE sv.id IS NOT NULL),'[]'::json) AS services
       FROM shop_staff st
       JOIN shops sh ON sh.id=st.shop_id AND sh.is_active=TRUE
       LEFT JOIN staff_services ss ON ss.staff_id=st.id
       LEFT JOIN services sv ON sv.id=ss.service_id AND sv.is_active=TRUE
       WHERE st.shop_id=$1 AND st.is_active=TRUE
       GROUP BY st.id,st.display_name ORDER BY st.display_name`,
      [shopId]
    );
    res.json({ staff: result.rows });
  }));

  // Admin overview spans every shop the platform operates.
  router.get('/admin/dashboard', ...admin, asyncRoute(async (req, res) => {
    const { from, to } = range(req, res) || {};
    if (!from) return;
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shops WHERE is_active = TRUE) AS active_shops,
         (SELECT COUNT(*)::int FROM shop_staff WHERE is_active = TRUE) AS active_barbers,
         (SELECT COUNT(*)::int FROM appointments WHERE starts_at >= $1::date AND starts_at < ($2::date + 1)) AS appointments,
         (SELECT COUNT(*)::int FROM appointments WHERE starts_at >= $1::date AND starts_at < ($2::date + 1) AND status = 'COMPLETED') AS completed,
         (SELECT COUNT(*)::int FROM appointments WHERE starts_at >= $1::date AND starts_at < ($2::date + 1) AND status = 'CANCELLED') AS cancelled,
         (SELECT COUNT(*)::int FROM appointments WHERE starts_at >= $1::date AND starts_at < ($2::date + 1) AND status = 'NO_SHOW') AS no_shows,
         (SELECT COALESCE(SUM(s.price), 0)::numeric(12,2)
            FROM appointments a JOIN services s ON s.id = a.service_id
           WHERE a.starts_at >= $1::date AND a.starts_at < ($2::date + 1) AND a.status = 'COMPLETED') AS gross_revenue`,
      [from, to]
    );
    const shops = await pool.query(
      `SELECT sh.id, sh.name, sh.slug, sh.is_active,
              COUNT(DISTINCT st.id)::int AS active_barbers,
              COUNT(DISTINCT a.id)::int AS appointments
       FROM shops sh LEFT JOIN shop_staff st ON st.shop_id = sh.id AND st.is_active = TRUE
       LEFT JOIN appointments a ON a.shop_id = sh.id
         AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
       GROUP BY sh.id ORDER BY sh.name`,
      [from, to]
    );
    res.json({ period: { from, to }, metrics: result.rows[0], shops: shops.rows });
  }));

  router.get('/admin/shops', ...admin, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT sh.id, sh.name, sh.slug, sh.address, sh.phone, sh.timezone, sh.is_active,
              COUNT(DISTINCT st.id)::int AS staff_count,
              COUNT(DISTINCT sv.id)::int AS service_count
       FROM shops sh LEFT JOIN shop_staff st ON st.shop_id = sh.id
       LEFT JOIN services sv ON sv.shop_id = sh.id
       GROUP BY sh.id ORDER BY sh.name`
    );
    res.json({ shops: result.rows });
  }));

  router.patch('/admin/shops/:shopId', ...admin, asyncRoute(async (req, res) => {
    const shopId = id(req.params.shopId);
    const { name, address, phone, timezone, isActive } = req.body || {};
    if (!shopId || !Object.keys(req.body || {}).length ||
        (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 160)) ||
        (address !== undefined && address !== null && typeof address !== 'string') ||
        (phone !== undefined && phone !== null && (typeof phone !== 'string' || phone.length > 30)) ||
        (timezone !== undefined && (typeof timezone !== 'string' || timezone.length > 80)) ||
        (isActive !== undefined && typeof isActive !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid shop update.' });
    }
    if (timezone !== undefined) {
      const valid = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
      if (!valid.rowCount) return res.status(400).json({ error: 'timezone must be a valid IANA timezone.' });
    }
    const result = await pool.query(
      `UPDATE shops SET name = COALESCE($2,name), address = CASE WHEN $3::boolean THEN $4 ELSE address END,
         phone = CASE WHEN $5::boolean THEN $6 ELSE phone END, timezone = COALESCE($7,timezone),
         is_active = COALESCE($8,is_active), updated_at = NOW()
       WHERE id = $1 RETURNING id,name,slug,address,phone,timezone,is_active`,
      [shopId, name?.trim() ?? null, address !== undefined, address ?? null, phone !== undefined, phone ?? null, timezone ?? null, isActive ?? null]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Shop not found.' });
    res.json({ shop: result.rows[0] });
  }));

  router.get('/admin/staff-performance', ...admin, asyncRoute(async (req, res) => {
    const period = range(req, res);
    if (!period) return;
    const result = await pool.query(
      `SELECT sh.id AS shop_id, sh.name AS shop_name, st.id AS staff_id, st.display_name,
              COUNT(a.id)::int AS appointments,
              COUNT(a.id) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
              COUNT(a.id) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows,
              COALESCE(SUM(s.price) FILTER (WHERE a.status = 'COMPLETED'),0)::numeric(12,2) AS revenue
       FROM shop_staff st JOIN shops sh ON sh.id = st.shop_id
       LEFT JOIN appointments a ON a.staff_id = st.id
         AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
       LEFT JOIN services s ON s.id = a.service_id
       GROUP BY sh.id, sh.name, st.id, st.display_name ORDER BY sh.name, revenue DESC, st.display_name`,
      [period.from, period.to]
    );
    res.json({ period, staff: result.rows });
  }));

  router.get('/admin/reports', ...admin, asyncRoute(async (req, res) => {
    const period = range(req, res);
    if (!period) return;
    const result = await pool.query(
      `SELECT sh.id AS shop_id, sh.name AS shop_name,
              COUNT(a.id)::int AS total_appointments,
              COUNT(a.id) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
              COUNT(a.id) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
              COUNT(a.id) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_shows,
              COALESCE(SUM(s.price) FILTER (WHERE a.status = 'COMPLETED'),0)::numeric(12,2) AS revenue
       FROM shops sh LEFT JOIN appointments a ON a.shop_id = sh.id
         AND a.starts_at >= $1::date AND a.starts_at < ($2::date + 1)
       LEFT JOIN services s ON s.id = a.service_id
       GROUP BY sh.id, sh.name ORDER BY sh.name`,
      [period.from, period.to]
    );
    res.json({ period, report: result.rows });
  }));

  router.get('/admin/services', ...admin, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT s.id,s.shop_id,sh.name AS shop_name,s.name,s.description,s.duration_minutes,s.price,s.is_active
       FROM services s JOIN shops sh ON sh.id = s.shop_id ORDER BY sh.name,s.name`
    );
    res.json({ services: result.rows });
  }));

  router.patch('/admin/services/:serviceId', ...admin, asyncRoute(async (req, res) => {
    const serviceId = id(req.params.serviceId);
    const { name, description, durationMinutes, price, isActive } = req.body || {};
    if (!serviceId || !Object.keys(req.body || {}).length ||
        (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) ||
        (description !== undefined && description !== null && typeof description !== 'string') ||
        (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240)) ||
        (price !== undefined && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) ||
        (isActive !== undefined && typeof isActive !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid service update.' });
    }
    const result = await pool.query(
      `UPDATE services SET name=COALESCE($2,name),
       description=CASE WHEN $3::boolean THEN $4 ELSE description END,
       duration_minutes=COALESCE($5,duration_minutes),price=COALESCE($6,price),
       is_active=COALESCE($7,is_active),updated_at=NOW()
       WHERE id=$1 RETURNING id,shop_id,name,description,duration_minutes,price,is_active`,
      [serviceId,name?.trim() ?? null,description !== undefined,description ?? null,durationMinutes ?? null,price ?? null,isActive ?? null]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Service not found.' });
    res.json({ service: result.rows[0] });
  }));

  // A barber is resolved through their authenticated user id, never a client-supplied staff id.
  router.get('/barber/dashboard', ...barber, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT st.id AS staff_id, st.shop_id, sh.name AS shop_name, sh.timezone,
              COUNT(a.id) FILTER (WHERE a.starts_at::date = (NOW() AT TIME ZONE sh.timezone)::date)::int AS today_appointments,
              COUNT(a.id) FILTER (WHERE a.status = 'COMPLETED' AND a.starts_at >= date_trunc('month', NOW()))::int AS completed_this_month
       FROM shop_staff st JOIN shops sh ON sh.id = st.shop_id
       LEFT JOIN appointments a ON a.staff_id = st.id
       WHERE st.user_id = $1 AND st.is_active = TRUE
       GROUP BY st.id,sh.id`,
      [req.user.id]
    );
    const upcoming = await pool.query(
      `SELECT a.id,a.starts_at,a.ends_at,a.status,a.customer_notes,
              u.id AS customer_id,u.name AS customer_name,u.email AS customer_email,
              sv.name AS service_name,sv.duration_minutes,sv.price,sh.id AS shop_id,sh.name AS shop_name
       FROM appointments a JOIN shop_staff st ON st.id=a.staff_id
       JOIN shops sh ON sh.id=a.shop_id JOIN services sv ON sv.id=a.service_id
       JOIN users u ON u.id=a.customer_id
       WHERE st.user_id=$1 AND st.is_active=TRUE AND a.starts_at >= NOW()
         AND a.status IN ('BOOKED','CONFIRMED')
       ORDER BY a.starts_at LIMIT 100`,
      [req.user.id]
    );
    res.json({ shops: result.rows, upcoming: upcoming.rows });
  }));

  router.get('/barber/appointments', ...barber, asyncRoute(async (req, res) => {
    const period = range(req, res);
    if (!period) return;
    const result = await pool.query(
      `SELECT a.id,a.starts_at,a.ends_at,a.status,a.customer_notes,
              u.id AS customer_id,u.name AS customer_name,u.email AS customer_email,
              sv.name AS service_name,sv.duration_minutes,sv.price,sh.id AS shop_id,sh.name AS shop_name
       FROM appointments a JOIN shop_staff st ON st.id=a.staff_id
       JOIN shops sh ON sh.id=a.shop_id JOIN services sv ON sv.id=a.service_id
       JOIN users u ON u.id=a.customer_id
       WHERE st.user_id=$1 AND st.is_active=TRUE
         AND a.starts_at >= $2::date AND a.starts_at < ($3::date + 1)
       ORDER BY a.starts_at`,
      [req.user.id, period.from, period.to]
    );
    res.json({ period, appointments: result.rows });
  }));

  router.patch('/barber/appointments/:appointmentId/status', ...barber, asyncRoute(async (req, res) => {
    const appointmentId = id(req.params.appointmentId);
    const { status } = req.body || {};
    if (!appointmentId || !['CONFIRMED','COMPLETED','NO_SHOW'].includes(status)) {
      return res.status(400).json({ error: 'status must be CONFIRMED, COMPLETED or NO_SHOW.' });
    }
    const result = await pool.query(
      `UPDATE appointments a SET status=$3,updated_at=NOW()
       FROM shop_staff st WHERE a.id=$1 AND a.staff_id=st.id AND st.user_id=$2 AND st.is_active=TRUE
         AND ((a.status='BOOKED' AND $3 IN ('CONFIRMED','NO_SHOW')) OR
              (a.status='CONFIRMED' AND $3 IN ('COMPLETED','NO_SHOW')))
       RETURNING a.id,a.status,a.starts_at,a.ends_at`,
      [appointmentId,req.user.id,status]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Appointment not found, not assigned to you, or transition is not allowed.' });
    res.json({ appointment: result.rows[0] });
  }));

  router.get('/barber/availability', ...barber, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT st.id AS staff_id,st.shop_id,wh.day_of_week,wh.opens_at,wh.closes_at,wh.is_active
       FROM shop_staff st LEFT JOIN staff_working_hours wh ON wh.staff_id=st.id
       WHERE st.user_id=$1 AND st.is_active=TRUE ORDER BY st.shop_id,wh.day_of_week`,
      [req.user.id]
    );
    const timeOff = await pool.query(
      `SELECT t.id,st.shop_id,t.starts_at,t.ends_at,t.reason
       FROM staff_time_off t JOIN shop_staff st ON st.id=t.staff_id
       WHERE st.user_id=$1 AND st.is_active=TRUE AND t.ends_at >= NOW()
       ORDER BY t.starts_at LIMIT 100`,
      [req.user.id]
    );
    res.json({ workingHours: result.rows, timeOff: timeOff.rows });
  }));

  router.post('/barber/time-off', ...barber, asyncRoute(async (req, res) => {
    const { staffId: rawStaffId, startsAt, endsAt, reason = null } = req.body || {};
    const staffId = id(rawStaffId);
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    if (!staffId || !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        (reason !== null && (typeof reason !== 'string' || reason.length > 240))) {
      return res.status(400).json({ error: 'Provide your staffId, valid ISO startsAt/endsAt and optional reason up to 240 characters.' });
    }
    const result = await pool.query(
      `INSERT INTO staff_time_off(staff_id,starts_at,ends_at,reason)
       SELECT id,$3,$4,$5 FROM shop_staff WHERE id=$1 AND user_id=$2 AND is_active=TRUE
       RETURNING id,staff_id,starts_at,ends_at,reason`,
      [staffId,req.user.id,new Date(start).toISOString(),new Date(end).toISOString(),reason]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Active staff membership not found.' });
    res.status(201).json({ timeOff: result.rows[0] });
  }));

  return router;
}

module.exports = { createDashboardRouter };
