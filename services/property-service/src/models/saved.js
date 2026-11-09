// Guests' saved (wish-listed) properties.
const { getMysql } = require('@airbnb/common');

/** Returns true if the saved state actually changed (so we only publish real changes). */
async function setSaved(guestId, propertyId, saved) {
  const db = getMysql();
  if (saved) {
    const [res] = await db.query(
      'INSERT IGNORE INTO saved_properties (guest_id, property_id) VALUES (?, ?)', [guestId, propertyId],
    );
    return res.affectedRows === 1;
  }
  const [res] = await db.query(
    'DELETE FROM saved_properties WHERE guest_id = ? AND property_id = ?', [guestId, propertyId],
  );
  return res.affectedRows === 1;
}

async function isSaved(guestId, propertyId) {
  const [rows] = await getMysql().query(
    'SELECT 1 FROM saved_properties WHERE guest_id = ? AND property_id = ?', [guestId, propertyId],
  );
  return rows.length > 0;
}

module.exports = { setSaved, isSaved };
