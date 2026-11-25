'use strict';

async function queueRebookingNudges(db){
 return db.query(`WITH last_visits AS (
   SELECT DISTINCT ON (a.shop_id,a.customer_id) a.shop_id,a.customer_id,a.id appointment_id,a.starts_at,a.service_id
   FROM appointments a WHERE a.status='COMPLETED' ORDER BY a.shop_id,a.customer_id,a.starts_at DESC
  ), due AS (
   SELECT lv.*,COALESCE(rp.interval_days,cp.preferred_interval_days,21) preferred_interval_days,sh.name shop_name,sv.name service_name
   FROM last_visits lv JOIN shop_customer_rebooking_profiles rp ON rp.shop_id=lv.shop_id AND rp.customer_id=lv.customer_id AND rp.enabled=TRUE
   LEFT JOIN shop_customer_profiles cp ON cp.shop_id=lv.shop_id AND cp.customer_id=lv.customer_id
   JOIN shops sh ON sh.id=lv.shop_id JOIN services sv ON sv.id=lv.service_id
   WHERE lv.starts_at+make_interval(days=>COALESCE(rp.interval_days,cp.preferred_interval_days,21))<=NOW()
     AND NOT EXISTS(SELECT 1 FROM appointments upcoming WHERE upcoming.shop_id=lv.shop_id AND upcoming.customer_id=lv.customer_id AND upcoming.status IN('BOOKED','CONFIRMED') AND upcoming.starts_at>NOW())
  )
  INSERT INTO shop_customer_reminders(shop_id,customer_id,appointment_id,channel,template_key,scheduled_at,dedupe_key)
  SELECT d.shop_id,d.customer_id,d.appointment_id,c.channel,'REBOOKING_NUDGE',NOW(),
    'rebook:'||d.shop_id::text||':'||d.customer_id::text||':'||d.appointment_id::text||':'||c.channel
  FROM due d JOIN shop_message_consents c ON c.shop_id=d.shop_id AND c.customer_id=d.customer_id
  JOIN shop_messaging_settings m ON m.shop_id=d.shop_id AND c.channel=ANY(m.enabled_channels)
  JOIN shop_message_templates t ON t.shop_id=d.shop_id AND t.channel=c.channel AND t.template_key='REBOOKING_NUDGE' AND t.is_active=TRUE
  JOIN users u ON u.id=c.customer_id
  WHERE c.consent=TRUE AND c.revoked_at IS NULL
    AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN('SMS','WHATSAPP') AND c.destination=u.phone))
  ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`);
}
module.exports={queueRebookingNudges};
