// Local time for stays. The API doc does not say what time a stay starts or ends, so like a
// real rental site it runs on the listing's clock: check-in at 15:00 and check-out at 11:00.
// Stored timestamps and the doc's own date rule (check_in must be today or later, in UTC)
// stay in UTC. This file is only for time of day rules: the 24 hour cancel window, expiry
// at check-in time and completion at check-out time.
//
// There is one time zone for the whole platform (BOOKING_TIMEZONE). A zone per listing
// would need a time_zone column on the properties table.
const TIME_ZONE = process.env.BOOKING_TIMEZONE || 'America/Los_Angeles';
const CHECK_IN_HOUR = Number(process.env.CHECK_IN_HOUR || 15);
const CHECK_OUT_HOUR = Number(process.env.CHECK_OUT_HOUR || 11);

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(utcMs) {
  const o = {};
  for (const p of partsFormat.formatToParts(new Date(utcMs))) o[p.type] = Number(p.value);
  return o;
}

/** How far the zone is from UTC at that moment, in milliseconds (negative for California). */
function offsetMs(utcMs) {
  const p = parts(utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** Today's date in the listing's time zone, as YYYY-MM-DD. */
function localDate(now = Date.now()) {
  const p = parts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The UTC moment (in milliseconds) when the given hour happens on that local date. */
function localInstant(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  let result = guess - offsetMs(guess);
  result = guess - offsetMs(result); // a second pass fixes the days when the clocks change
  return result;
}

const checkInInstant = (checkIn) => localInstant(checkIn, CHECK_IN_HOUR);
const checkOutInstant = (checkOut) => localInstant(checkOut, CHECK_OUT_HOUR);

module.exports = { TIME_ZONE, CHECK_IN_HOUR, CHECK_OUT_HOUR, localDate, localInstant, checkInInstant, checkOutInstant };
