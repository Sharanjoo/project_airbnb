// Server-side price breakdown (API doc §5). Rates are config, not constants in handlers.
const SERVICE_FEE_RATE = Number(process.env.SERVICE_FEE_RATE || 0.1);
const TAX_RATE = Number(process.env.TAX_RATE || 0.12);

const round2 = (n) => Math.round(n * 100) / 100;

function nightsBetween(checkIn, checkOut) {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
}

function priceBreakdown(property, nights) {
  const nightly = Number(property.nightly_price);
  const cleaning = Number(property.cleaning_fee || 0);
  const subtotal = round2(nightly * nights);
  const base = subtotal + cleaning;
  const service_fee = round2(base * SERVICE_FEE_RATE);
  const taxes = round2(base * TAX_RATE);
  return {
    nights,
    nightly_price: nightly,
    subtotal,
    cleaning_fee: cleaning,
    service_fee,
    taxes,
    total: round2(base + service_fee + taxes),
    currency: 'USD',
  };
}

/** Every night of a stay, check_out exclusive: 2026-11-14..16 -> [14, 15] */
function eachNight(checkIn, checkOut) {
  const out = [];
  for (let t = Date.parse(`${checkIn}T00:00:00Z`); t < Date.parse(`${checkOut}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

module.exports = { priceBreakdown, nightsBetween, eachNight };
