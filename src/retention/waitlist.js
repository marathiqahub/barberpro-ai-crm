'use strict';
async function offerNextWaitlist(pool, slot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const match = await client.query(
      `SELECT e.* FROM shop_waitlist_entries e
       JOIN shops sh ON sh.id=e.shop_id
       WHERE e.shop_id=$1 AND e.service_id=$2 AND e.status='WAITING'
         AND e.preferred_date=(($3::timestamptz AT TIME ZONE sh.timezone)::date)
         AND (e.preferred_staff_id IS NULL OR e.preferred_staff_id=$4)
         AND (e.preferred_from IS NULL OR ($3::timestamptz AT TIME ZONE sh.timezone)::time>=e.preferred_from)
         AND (e.preferred_to IS NULL OR ($3::timestamptz AT TIME ZONE sh.timezone)::time<=e.preferred_to)
       ORDER BY e.created_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`,
      [slot.shop_id,slot.service_id,slot.starts_at,slot.staff_id]
    );
    if (!match.rowCount) { await client.query('COMMIT'); return null; }
    const entry=match.rows[0];
    const offer=await client.query(
      `INSERT INTO shop_waitlist_offers(waitlist_entry_id,shop_id,customer_id,staff_id,service_id,starts_at,ends_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '15 minutes') RETURNING id,expires_at`,
      [entry.id,slot.shop_id,entry.customer_id,slot.staff_id,slot.service_id,slot.starts_at,slot.ends_at]
    );
    await client.query("UPDATE shop_waitlist_entries SET status='OFFERED',updated_at=NOW() WHERE id=$1",[entry.id]);
    await client.query(
      `INSERT INTO shop_customer_reminders(shop_id,customer_id,channel,template_key,scheduled_at,related_entity_type,related_entity_id)
       SELECT c.shop_id,c.customer_id,c.channel,'WAITLIST_OFFER',NOW(),'WAITLIST_OFFER',$3
       FROM shop_message_consents c
       JOIN shop_messaging_settings m ON m.shop_id=c.shop_id AND c.channel=ANY(m.enabled_channels)
       JOIN shop_message_templates t ON t.shop_id=c.shop_id AND t.channel=c.channel AND t.template_key='WAITLIST_OFFER' AND t.is_active=TRUE
       JOIN users u ON u.id=c.customer_id
       WHERE c.shop_id=$1 AND c.customer_id=$2 AND c.consent=TRUE AND c.revoked_at IS NULL
         AND c.channel IN ('WHATSAPP','EMAIL','SMS')
         AND ((c.channel='EMAIL' AND c.destination=u.email) OR (c.channel IN ('SMS','WHATSAPP') AND c.destination=u.phone))
       ON CONFLICT DO NOTHING`,
      [slot.shop_id,entry.customer_id,offer.rows[0].id]
    );
    await client.query('COMMIT');
    return {offerId:offer.rows[0].id,customerId:entry.customer_id,expiresAt:offer.rows[0].expires_at};
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
module.exports={offerNextWaitlist};
