const express = require('express');
const { createAuthMiddleware } = require('../auth/middleware');
function createWorkspaceRouter(pool, tokenService) {
  const router=express.Router();
  const {authenticate,requireRole}=createAuthMiddleware(pool,tokenService);
  const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  router.get('/barber/appointments',authenticate,requireRole('BARBER'),asyncRoute(async(req,res)=>{
    const date=typeof req.query.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(req.query.date)?req.query.date:new Date().toISOString().slice(0,10);
    const result=await pool.query(
      `SELECT a.id,a.starts_at,a.ends_at,a.status,a.customer_notes,u.name AS customer_name,u.email AS customer_email,
       sh.id AS shop_id,sh.name AS shop_name,sv.name AS service_name,sv.duration_minutes,sv.price,st.id AS staff_id,sh.timezone
       FROM appointments a JOIN users u ON u.id=a.customer_id JOIN shops sh ON sh.id=a.shop_id
       JOIN services sv ON sv.id=a.service_id JOIN shop_staff st ON st.id=a.staff_id
       WHERE st.user_id=$1 AND (a.starts_at AT TIME ZONE sh.timezone)::date=$2::date
       ORDER BY a.starts_at`,[req.user.id,date]);
    res.json({date,appointments:result.rows});
  }));
  router.patch('/barber/appointments/:id/status',authenticate,requireRole('BARBER'),asyncRoute(async(req,res)=>{
    const status=req.body?.status;
    if(!['CONFIRMED','COMPLETED','NO_SHOW'].includes(status))return res.status(400).json({error:'Status must be CONFIRMED, COMPLETED or NO_SHOW.'});
    const result=await pool.query(
      `UPDATE appointments a SET status=$1,updated_at=NOW()
       FROM shop_staff st WHERE a.id=$2 AND a.staff_id=st.id AND st.user_id=$3
       AND a.status IN ('BOOKED','CONFIRMED') RETURNING a.id,a.status`,[status,req.params.id,req.user.id]);
    if(!result.rowCount)return res.status(404).json({error:'Appointment not found or cannot be updated.'});
    res.json({appointment:result.rows[0]});
  }));
  router.get('/barber/shops',authenticate,requireRole('BARBER'),asyncRoute(async(req,res)=>{
    const result=await pool.query('SELECT st.id AS staff_id,st.display_name,sh.id AS shop_id,sh.name AS shop_name,sh.timezone FROM shop_staff st JOIN shops sh ON sh.id=st.shop_id WHERE st.user_id=$1 AND st.is_active AND sh.is_active ORDER BY sh.name',[req.user.id]);
    res.json({shops:result.rows});
  }));
  router.get('/admin/overview',authenticate,requireRole('ADMIN'),asyncRoute(async(req,res)=>{
    const [shops,staff,appointments,revenue,services]=await Promise.all([
      pool.query('SELECT id,name,slug,address,timezone,is_active FROM shops ORDER BY name'),
      pool.query('SELECT st.id,st.display_name,st.is_active,sh.id AS shop_id,sh.name AS shop_name,u.email FROM shop_staff st JOIN shops sh ON sh.id=st.shop_id JOIN users u ON u.id=st.user_id ORDER BY sh.name,st.display_name'),
      pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status IN ('BOOKED','CONFIRMED'))::int AS upcoming,COUNT(*) FILTER(WHERE status='COMPLETED')::int AS completed FROM appointments`),
      pool.query(`SELECT COALESCE(SUM(amount_paise) FILTER(WHERE status='CAPTURED'),0)::bigint AS captured_paise,COUNT(*) FILTER(WHERE status='CAPTURED')::int AS paid_count FROM payments`),
      pool.query('SELECT sv.id,sv.name,sv.price,sv.duration_minutes,sh.id AS shop_id,sh.name AS shop_name,sv.is_active FROM services sv JOIN shops sh ON sh.id=sv.shop_id ORDER BY sh.name,sv.name')
    ]);
    res.json({shops:shops.rows,staff:staff.rows,appointments:appointments.rows[0],revenue:revenue.rows[0],services:services.rows});
  }));
  router.get('/admin/reports',authenticate,requireRole('ADMIN'),asyncRoute(async(req,res)=>{
    const result=await pool.query(
      `SELECT sh.id AS shop_id,sh.name AS shop_name,COUNT(a.id)::int AS appointments,
       COUNT(a.id) FILTER(WHERE a.status='COMPLETED')::int AS completed,
       COALESCE(SUM(p.amount_paise) FILTER(WHERE p.status='CAPTURED'),0)::bigint AS revenue_paise
       FROM shops sh LEFT JOIN appointments a ON a.shop_id=sh.id LEFT JOIN payments p ON p.appointment_id=a.id
       GROUP BY sh.id ORDER BY sh.name`);
    res.json({reports:result.rows});
  }));
  router.get('/staff/:staffId/services',authenticate,requireRole('ADMIN'),asyncRoute(async(req,res)=>{
    const result=await pool.query('SELECT id,name,price,duration_minutes FROM services WHERE shop_id=(SELECT shop_id FROM shop_staff WHERE id=$1) AND is_active ORDER BY name',[req.params.staffId]);
    res.json({services:result.rows});
  }));
  return router;
}
module.exports={createWorkspaceRouter};
