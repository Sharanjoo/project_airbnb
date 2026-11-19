// Cancellation rule from the API doc: a guest cannot cancel within 24 hours of check-in
// (422), whether the booking is requested or confirmed. A host can cancel at any time.
// The doc does not say what time check-in is, so like a real rental site it is 15:00 on the
// check-in date in the listing's time zone (see timeutil.js). The 24 hours can be changed in config.
const { checkInInstant } = require('./timeutil');

const GUEST_CANCEL_WINDOW_HOURS = Number(process.env.GUEST_CANCEL_WINDOW_HOURS || 24);

function hoursUntilCheckIn(checkIn, now = Date.now()) {
  return (checkInInstant(checkIn) - now) / 3600000;
}

function guestMayCancel(checkIn, now = Date.now()) {
  return hoursUntilCheckIn(checkIn, now) >= GUEST_CANCEL_WINDOW_HOURS;
}

module.exports = { GUEST_CANCEL_WINDOW_HOURS, hoursUntilCheckIn, guestMayCancel };
