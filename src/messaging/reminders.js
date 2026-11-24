'use strict';
async function scheduleAppointmentReminders(db,appointment,options={}){
 if(options.transactional)await db.query('SAVEPOINT reminder_schedule');
 try{
  // WhatsApp uses two approved, separately registered utility templates. A
  // booking made inside a reminder window is queued immediately, never backdated.
  await db.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at)
   SELECT c.shop_id,c.customer_id,$3,'WHATSAPP','APPOINTMENT_REMINDER_24H',GREATEST(NOW(),$4::timestamptz-INTERVAL '24 hours')
   FROM shop_message_consents c
   JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND 'WHATSAPP'=ANY(m.enabled_channels)
   JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel='WHATSAPP' AND t.template_key='APPOINTMENT_REMINDER_24H' AND t.is_active=TRUE AND t.provider_template_status='APPROVED'
   JOIN users u ON u.id=c.customer_id
   WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.channel='WHATSAPP' AND c.consent=TRUE AND c.revoked_at IS NULL
    AND c.destination=u.phone AND $4::timestamptz>NOW()+INTERVAL '24 hours'
    AND NOT EXISTS(SELECT 1 FROM shop_customer_reminders r WHERE r.appointment_id=$3 AND r.channel='WHATSAPP' AND r.template_key='APPOINTMENT_REMINDER_24H' AND r.status<>'CANCELLED')
   ON CONFLICT DO NOTHING`,[appointment.shop_id,appointment.customer_id,appointment.id,appointment.starts_at]);
  await db.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at)
   SELECT c.shop_id,c.customer_id,$3,'WHATSAPP','APPOINTMENT_REMINDER_2H',GREATEST(NOW(),$4::timestamptz-INTERVAL '2 hours')
   FROM shop_message_consents c
   JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND 'WHATSAPP'=ANY(m.enabled_channels)
   JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel='WHATSAPP' AND t.template_key='APPOINTMENT_REMINDER_2H' AND t.is_active=TRUE AND t.provider_template_status='APPROVED'
   JOIN users u ON u.id=c.customer_id
   WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.channel='WHATSAPP' AND c.consent=TRUE AND c.revoked_at IS NULL
    AND c.destination=u.phone AND $4::timestamptz>NOW()
    AND NOT EXISTS(SELECT 1 FROM shop_customer_reminders r WHERE r.appointment_id=$3 AND r.channel='WHATSAPP' AND r.template_key='APPOINTMENT_REMINDER_2H' AND r.status<>'CANCELLED')
   ON CONFLICT DO NOTHING`,[appointment.shop_id,appointment.customer_id,appointment.id,appointment.starts_at]);
  // Preserve the existing email/SMS reminder contract and template key.
  await db.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at)
   SELECT c.shop_id,c.customer_id,$3,c.channel,'APPOINTMENT_REMINDER',GREATEST(NOW(),$4::timestamptz-INTERVAL '24 hours')
   FROM shop_message_consents c
   JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND c.channel=ANY(m.enabled_channels)
   JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key='APPOINTMENT_REMINDER' AND t.is_active=TRUE
   JOIN users u ON u.id=c.customer_id
   WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.channel IN ('EMAIL','SMS') AND c.consent=TRUE AND c.revoked_at IS NULL
    AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel='SMS' AND c.destination=u.phone))
    AND NOT EXISTS(SELECT 1 FROM shop_customer_reminders r WHERE r.appointment_id=$3 AND r.channel=c.channel AND r.template_key='APPOINTMENT_REMINDER' AND r.status<>'CANCELLED')
   ON CONFLICT DO NOTHING`,[appointment.shop_id,appointment.customer_id,appointment.id,appointment.starts_at]);
  if(options.transactional)await db.query('RELEASE SAVEPOINT reminder_schedule');
 }catch(error){
  if(options.transactional){await db.query('ROLLBACK TO SAVEPOINT reminder_schedule');await db.query('RELEASE SAVEPOINT reminder_schedule');}
  if(error.code==='42P01')return [];
  throw error;
 }
 return [];
}
module.exports={scheduleAppointmentReminders};
