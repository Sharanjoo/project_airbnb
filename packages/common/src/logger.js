// One JSON line per log entry, so logs can be grepped by trace_id.
const SERVICE = process.env.SERVICE_NAME || 'unknown-service';

function log(level, msg, fields = {}) {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  const line = { ts: new Date().toISOString(), level, service: SERVICE, msg, ...fields };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

module.exports = {
  info: (msg, f) => log('info', msg, f),
  warn: (msg, f) => log('warn', msg, f),
  error: (msg, f) => log('error', msg, f),
};
