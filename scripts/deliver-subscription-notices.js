'use strict';
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
async function run(){
 if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM){console.log('Subscription failure notices skipped: RESEND_API_KEY and MAIL_FROM are required.');return;}
 const failed=await pool.query(`SELECT ss.id,ss.shop_id,ss.failure_count,ss.last_payment_failed_at,sh.name shop_name,
   COALESCE(json_agg(DISTINCT u.email) FILTER(WHERE u.email IS NOT NULL),'[]'::json) emails
  FROM shop_subscriptions ss JOIN shops sh ON sh.id=ss.shop_id
  LEFT JOIN shop_billing_members bm ON bm.shop_id=ss.shop_id AND bm.role IN('SHOP_OWNER','BILLING_ADMIN')
  LEFT JOIN users u ON u.id=bm.user_id
  WHERE ss.last_payment_failed_at IS NOT NULL AND ss.reminder_sent_at IS NULL AND ss.status IN('ACTIVE','HALTED','PENDING')
  GROUP BY ss.id,sh.name ORDER BY ss.last_payment_failed_at LIMIT 100`);
 for(const row of failed.rows){
  const emails=row.emails.filter(Boolean);if(!emails.length)continue;
  let delivered=true;
  for(const to of emails){
   const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to,subject:'Action required: BarberPro subscription payment failed',text:`Payment for ${row.shop_name} did not complete. Please update the payment method or retry the subscription payment in Razorpay. Failed renewal attempts: ${row.failure_count}. Your shop's access may be interrupted if payment remains unresolved.`})});
   if(!response.ok){delivered=false;console.error('Subscription notice delivery failed',row.id,to,await response.text());}
  }
  if(delivered)await pool.query('UPDATE shop_subscriptions SET reminder_sent_at=NOW() WHERE id=$1 AND reminder_sent_at IS NULL',[row.id]);
 }
 console.log('Subscription failure notices processed:',failed.rowCount);
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
