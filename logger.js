/**
 * Structured JSON logger. Railway captures stdout/stderr directly, so this
 * intentionally skips any transport/collector — one JSON object per line.
 */

function log(severity, log_type, fields = {}) {
  const entry = {
    severity,
    log_type,
    ts: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (severity === 'ERROR') console.error(line);
  else console.log(line);
}

module.exports = { log };
