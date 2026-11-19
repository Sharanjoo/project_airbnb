import { useRef } from 'react';

// Small pieces used by both booking pages (My trips and Reservation requests).

export const STATUS_TEXT = {
  PENDING: 'Sending your request',
  REQUESTED: 'Waiting for the host',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  DECLINED: 'Declined by the host',
  EXPIRED: 'Expired, the host did not reply',
  REJECTED: 'Those dates were not available',
};

export function StatusBadge({ status }) {
  return <span className={`status status-${status.toLowerCase()}`}>{STATUS_TEXT[status] || status}</span>;
}

export const money = (n) => `$${Number(n).toFixed(2)}`;

// A YYYY-MM-DD string shown as a local date. Building it from parts avoids the one day shift you get from Date.parse.
const dayLabel = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
export const dateRange = (checkIn, checkOut) => `${dayLabel(checkIn)} to ${dayLabel(checkOut)}`;

export const nightsBetween = (checkIn, checkOut) => Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);

// Server errors come back as { code, message, details }. Show the details when there are any.
export const errorText = (e) => (e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);

export function timeAgo(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// Hosts have 24 hours to answer a request (API doc). Returns text like "Reply within 5 h 12 min".
export function replyDeadline(requestedAtIso, now = Date.now()) {
  const left = Date.parse(requestedAtIso) + 24 * 3600000 - now;
  if (left <= 0) return 'The reply time is up';
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  return h > 0 ? `Reply within ${h} h ${m} min` : `Reply within ${m} min`;
}

// Every write call needs an Idempotency-Key. If a call fails and the person tries the same thing again,
// we send the same key so the server can tell it is a retry. A different request gets a new key.
export function useIdempotencyKeys() {
  const keys = useRef(new Map());
  return {
    keyFor(name) {
      if (!keys.current.has(name)) keys.current.set(name, crypto.randomUUID());
      return keys.current.get(name);
    },
    forget(name) {
      keys.current.delete(name);
    },
  };
}

export function PriceBreakdown({ b }) {
  if (!b) return null;
  return (
    <table className="breakdown">
      <tbody>
        <tr><td>{money(b.nightly_price)} x {b.nights} night{b.nights === 1 ? '' : 's'}</td><td>{money(b.subtotal)}</td></tr>
        <tr><td>Cleaning fee</td><td>{money(b.cleaning_fee)}</td></tr>
        <tr><td>Service fee</td><td>{money(b.service_fee)}</td></tr>
        <tr><td>Taxes</td><td>{money(b.taxes)}</td></tr>
        <tr className="total"><td>Total</td><td>{money(b.total)}</td></tr>
      </tbody>
    </table>
  );
}

export function History({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="history">
      {items.map((h, i) => (
        <li key={i}>
          {h.from_status ? `${STATUS_TEXT[h.from_status] || h.from_status} to ` : 'Started as '}
          <strong>{STATUS_TEXT[h.to_status] || h.to_status}</strong>
          <span className="muted"> · {new Date(h.at).toLocaleString()}</span>
          {h.reason && <span className="muted"> · {h.reason}</span>}
        </li>
      ))}
    </ul>
  );
}
