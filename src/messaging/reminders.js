'use strict';
async function scheduleAppointmentReminders(db,appointment,options={}){
 if(options.transactional)await db.query('SAVEPOINT reminder_schedule');
 let result;try{result=await db.query(`INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at)
 SELECT $1,$2,$3,c.channel,'APPOINTMENT_REMINDER',GREATEST(NOW(),$4::timestamptz-INTERVAL '24 hours')
 FROM shop_message_consents c
 JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND c.channel=ANY(m.enabled_channels)
 JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key='APPOINTMENT_REMINDER' AND t.is_active=TRUE
 JOIN users u ON u.id=c.customer_id
 WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.consent=TRUE AND c.revoked_at IS NULL
 AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN ('SMS','WHATSAPP') AND c.destination=u.phone))
 RETURNING id,channel,scheduled_at`,[appointment.shop_id,appointment.customer_id,appointment.id,appointment.starts_at]);if(options.transactional)await db.query('RELEASE SAVEPOINT reminder_schedule');}catch(error){if(options.transactional){await db.query('ROLLBACK TO SAVEPOINT reminder_schedule');await db.query('RELEASE SAVEPOINT reminder_schedule');}if(error.code==='42P01')return [];throw error;}
 return result.rows;
}
module.exports={scheduleAppointmentReminders};
