'use strict';
const express=require('express');
const {createAuthMiddleware}=require('../auth/middleware');
const {calculatePayslip}=require('../payroll/calculator');
function createPayrollRouter(pool,tokens){
 const r=express.Router(),{authenticate,requireRole}=createAuthMiddleware(pool,tokens),admin=[authenticate,requireRole('ADMIN')];
 const wrap=fn=>(q,s,n)=>Promise.resolve(fn(q,s)).catch(n),id=v=>/^[1-9]\\d*$/.test(String(v))?Number(v):null,date=v=>typeof v==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(v);
 r.put('/admin/shops/:shopId/staff/:staffId/payroll-profile',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),staff=id(q.params.staffId),b=q.body||{};
  if(!shop||!staff||!['SALARIED','COMMISSION_ONLY'].includes(b.employmentType)||!date(b.effectiveFrom))return s.status(400).json({error:'Valid shop, staff, employmentType and effectiveFrom are required.'});
  const num=(v,d=0)=>v===undefined?d:v;
  const values=[num(b.monthlyGrossPaise),num(b.commissionRateBps),num(b.pfEmployeeBps),num(b.pfEmployerBps),num(b.esiEmployeeBps),num(b.esiEmployerBps),num(b.professionalTaxPaise),num(b.tdsBps),num(b.otherDeductionsPaise)];
  if(values.some(v=>!Number.isSafeInteger(v)||v<0)||values[1]>10000||values[2]>10000||values[3]>10000||values[4]>10000||values[5]>10000||values[7]>10000)return s.status(400).json({error:'Payroll values must be non-negative integers; percentage rates cannot exceed 10000 bps.'});
  const out=await pool.query(`INSERT INTO shop_staff_payroll_profiles(shop_id,staff_id,employment_type,effective_from,monthly_gross_paise,commission_rate_bps,pf_applicable,pf_employee_bps,pf_employer_bps,esi_applicable,esi_employee_bps,esi_employer_bps,professional_tax_paise,tds_bps,other_deductions_paise,created_by)
  SELECT $1,st.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16 FROM shop_staff st WHERE st.id=$2 AND st.shop_id=$1 AND st.is_active=TRUE RETURNING *`,
  [shop,staff,b.employmentType,b.effectiveFrom,values[0],values[1],b.pfApplicable===true,values[2],values[3],b.esiApplicable===true,values[4],values[5],values[6],values[7],values[8],q.user.id]);
  if(!out.rowCount)return s.status(404).json({error:'Active barber not found in this shop.'});s.status(201).json({profile:out.rows[0]});
 }));
 r.post('/admin/shops/:shopId/payroll-runs',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),{periodStart,periodEnd}=q.body||{};
  if(!shop||!date(periodStart)||!date(periodEnd)||periodStart>periodEnd||periodStart.slice(0,7)!==periodEnd.slice(0,7))return s.status(400).json({error:'Provide a valid single-calendar-month period.'});
  const c=await pool.connect();try{await c.query('BEGIN');
   const run=await c.query("INSERT INTO shop_payroll_runs(shop_id,period_start,period_end,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(shop_id,period_start,period_end) DO NOTHING RETURNING *",[shop,periodStart,periodEnd,q.user.id]);
   if(!run.rowCount){await c.query('ROLLBACK');return s.status(409).json({error:'Payroll run already exists for this period.'})}
   const staff=await c.query(`SELECT DISTINCT ON(st.id) st.id,pp.* FROM shop_staff st JOIN shop_staff_payroll_profiles pp ON pp.staff_id=st.id AND pp.shop_id=st.shop_id
    WHERE st.shop_id=$1 AND st.is_active=TRUE AND pp.active=TRUE AND pp.effective_from<=$3 ORDER BY st.id,pp.effective_from DESC`,[shop,periodStart,periodEnd]);
   for(const p of staff.rows){
    const sales=await c.query(`SELECT COALESCE(SUM(l.taxable_paise),0)::bigint taxable,COALESCE(SUM(l.tip_paise),0)::bigint tips
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.invoice_id WHERE i.shop_id=$1 AND l.staff_id=$2 AND i.status='ISSUED' AND i.issue_date BETWEEN $3 AND $4`,[shop,p.staff_id,periodStart,periodEnd]);
    const earning={commissionPaise:Math.round(Number(sales.rows[0].taxable)*Number(p.commission_rate_bps)/10000),tipsPaise:Number(sales.rows[0].tips)}
    const slip=calculatePayslip(p,earning);
    await c.query(`INSERT INTO shop_payslips(payroll_run_id,shop_id,staff_id,employment_type,basic_gross_paise,commission_paise,tips_paise,pf_employee_paise,esi_employee_paise,professional_tax_paise,tds_paise,other_deductions_paise,employer_pf_paise,employer_esi_paise,gross_paise,deductions_paise,net_paise,calculation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
    [run.rows[0].id,shop,p.staff_id,slip.employmentType,slip.basicGrossPaise,slip.commissionPaise,slip.tipsPaise,slip.pfEmployeePaise,slip.esiEmployeePaise,slip.professionalTaxPaise,slip.tdsPaise,slip.otherDeductionsPaise,slip.employerPfPaise,slip.employerEsiPaise,slip.grossPaise,slip.deductionsPaise,slip.netPaise,JSON.stringify(slip)]);
   }
   await c.query('COMMIT');s.status(201).json({payrollRun:run.rows[0],payslipCount:staff.rows.length});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 r.get('/admin/shops/:shopId/payroll-runs/:runId/payslips',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),run=id(q.params.runId);if(!shop||!run)return s.status(400).json({error:'Invalid shop or payroll run.'});
  const out=await pool.query(`SELECT p.*,st.display_name FROM shop_payslips p JOIN shop_staff st ON st.id=p.staff_id WHERE p.shop_id=$1 AND p.payroll_run_id=$2 ORDER BY st.display_name`,[shop,run]);
  s.json({payslips:out.rows});
 }));
 r.post('/admin/shops/:shopId/payroll-runs/:runId/approve',...admin,wrap(async(q,s)=>{
  const shop=id(q.params.shopId),run=id(q.params.runId);const out=await pool.query("UPDATE shop_payroll_runs SET status='APPROVED',approved_by=$3,approved_at=NOW() WHERE id=$2 AND shop_id=$1 AND status='DRAFT' RETURNING *",[shop,run,q.user.id]);
  if(!out.rowCount)return s.status(409).json({error:'Draft payroll run not found.'});s.json({payrollRun:out.rows[0]});
 }));
 return r;
}
module.exports={createPayrollRouter};
