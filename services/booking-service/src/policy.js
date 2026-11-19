// Cancellation rule (API doc §5): a guest cannot cancel within 24 hours of
// check-in; a host can cancel at any time. Check-in is taken as 00:00 UTC on the
// check_in date. The window is config, not a constant in the handler.
const GUEST_CANCEL_WINDOW_HOURS = Number(process.env.GUEST_CANCEL_WINDOW_HOURS || 24);

function hoursUntilCheckIn(checkIn, now = Date.now()) {
  return (Date.parse(`${checkIn}T00:00:00Z`) - now) / 3600000;
}

function guestMayCancel(checkIn, now = Date.now()) {
  return hoursUntilCheckIn(checkIn, now) >= GUEST_CANCEL_WINDOW_HOURS;
}

module.exports = { GUEST_CANCEL_WINDOW_HOURS, hoursUntilCheckIn, guestMayCancel };
