'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {calculatePayslip}=require('../src/payroll/calculator');
test('salaried payroll calculates configured employee and employer contributions',()=>{
 const result=calculatePayslip({employment_type:'SALARIED',monthly_gross_paise:5000000,pf_applicable:true,pf_employee_bps:1200,pf_employer_bps:1200,esi_applicable:true,esi_employee_bps:75,esi_employer_bps:325,professional_tax_paise:20000,tds_bps:500,other_deductions_paise:10000},{commissionPaise:200000,tipsPaise:50000});
 assert.equal(result.grossPaise,5250000);assert.equal(result.pfEmployeePaise,600000);assert.equal(result.esiEmployeePaise,39375);assert.equal(result.professionalTaxPaise,20000);assert.equal(result.tdsPaise,262500);assert.equal(result.netPaise,result.grossPaise-result.deductionsPaise);
});
test('commission-only profile does not apply salaried statutory deductions',()=>{
 const result=calculatePayslip({employment_type:'COMMISSION_ONLY',monthly_gross_paise:0,pf_applicable:true,pf_employee_bps:1200,esi_applicable:true,esi_employee_bps:75,professional_tax_paise:20000,tds_bps:1000,other_deductions_paise:5000},{commissionPaise:1500000,tipsPaise:100000});
 assert.equal(result.grossPaise,1600000);assert.equal(result.deductionsPaise,0);assert.equal(result.netPaise,1600000);
});
test('rejects deductions greater than gross earnings',()=>{
 assert.throws(()=>calculatePayslip({employment_type:'SALARIED',monthly_gross_paise:100,pf_applicable:false,esi_applicable:false,professional_tax_paise:200,tds_bps:0,other_deductions_paise:0},{}),/exceed gross/);
});
