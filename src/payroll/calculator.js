'use strict';
function money(value){if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Payroll amounts must be non-negative whole paise.');return value}
function pct(base,bps){return Math.round(base*bps/10000)}
function calculatePayslip(profile,earnings){
 const commission=money(earnings.commissionPaise||0),tips=money(earnings.tipsPaise||0);
 const base=profile.employment_type==='SALARIED'?money(Number(profile.monthly_gross_paise)):0;
 const gross=base+commission+tips;
 const pf=profile.employment_type==='SALARIED'&&profile.pf_applicable?pct(base,Number(profile.pf_employee_bps)):0;
 const esi=profile.employment_type==='SALARIED'&&profile.esi_applicable?pct(gross,Number(profile.esi_employee_bps)):0;
 const pt=profile.employment_type==='SALARIED'?money(Number(profile.professional_tax_paise)):0;
 const tds=profile.employment_type==='SALARIED'?pct(gross,Number(profile.tds_bps)):0;
 const other=profile.employment_type==='SALARIED'?money(Number(profile.other_deductions_paise)):0;
 const deductions=pf+esi+pt+tds+other;
 if(deductions>gross)throw new RangeError('Configured deductions exceed gross earnings.');
 return {employmentType:profile.employment_type,basicGrossPaise:base,commissionPaise:commission,tipsPaise:tips,pfEmployeePaise:pf,esiEmployeePaise:esi,professionalTaxPaise:pt,tdsPaise:tds,otherDeductionsPaise:other,employerPfPaise:profile.pf_applicable?pct(base,Number(profile.pf_employer_bps)):0,employerEsiPaise:profile.esi_applicable?pct(gross,Number(profile.esi_employer_bps)):0,grossPaise:gross,deductionsPaise:deductions,netPaise:gross-deductions};
}
module.exports={calculatePayslip};
