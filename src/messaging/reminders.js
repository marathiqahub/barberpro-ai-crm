'use strict';
async function scheduleAppointmentReminders(db,appointment,options={}){
 if(options.transactional)await db.query('SAVEPOINT reminder_schedule');
 try{
  const result=await db.query(`WITH reminder_types(template_key,hours_before) AS (
    VALUES ('APPOINTMENT_REMINDER_24H',24),('APPOINTMENT_REMINDER_2H',2)
   )
   INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key)
   SELECT $1,$2,$3,c.channel,rt.template_key,GREATEST(NOW(),$4::timestamptz-make_interval(hours=>rt.hours_before)),
     'appointment:'||($3::bigint)::text||':'||c.channel||':'||rt.template_key||':'||to_char($4::timestamptz,'YYYYMMDDHH24MISS')
   FROM shop_message_consents c
   JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND c.channel=ANY(m.enabled_channels)
   JOIN reminder_types rt ON TRUE
   JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key=rt.template_key AND t.is_active=TRUE
   JOIN users u ON u.id=c.customer_id
   WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.consent=TRUE AND c.revoked_at IS NULL
   AND ($4::timestamptz >= NOW()+make_interval(hours=>rt.hours_before) OR rt.hours_before=2)
   AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN ('SMS','WHATSAPP') AND c.destination=u.phone))
   ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
   RETURNING id,channel,template_key,scheduled_at`,[appointment.shop_id,appointment.customer_id,appointment.id,appointment.starts_at]);
  if(options.transactional)await db.query('RELEASE SAVEPOINT reminder_schedule');
  return result.rows;
 }catch(error){
  if(options.transactional){await db.query('ROLLBACK TO SAVEPOINT reminder_schedule');await db.query('RELEASE SAVEPOINT reminder_schedule');}
  if(error.code==='42P01')return [];
  throw error;
 }
}
module.exports={scheduleAppointmentReminders};
