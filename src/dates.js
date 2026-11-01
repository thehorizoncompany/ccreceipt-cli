// --since / --until: a calendar day (YYYY-MM-DD, local time) or a number of days back from now (7d).

const DAY = 86_400_000;

/**
 * @param {string} value the option value
 * @param {"since"|"until"} bound since = start of the day, until = end of the day (inclusive)
 * @param {number} [now] current time in ms, for tests
 * @returns {number} a timestamp in ms
 */
export function parseDateBound(value, bound, now = Date.now()) {
  const rel = /^(\d+)d$/.exec(value || "");
  if (rel) return now - Number(rel[1]) * DAY;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const t = bound === "since" ? new Date(y, mo, d) : new Date(y, mo, d, 23, 59, 59, 999);
    if (t.getFullYear() === y && t.getMonth() === mo && t.getDate() === d) return t.getTime();
  }
  throw new Error(`Invalid --${bound} value "${value}": use YYYY-MM-DD or a number of days like 7d`);
}

/** A session is in the range when its first call or prompt is. */
export function inRange(session, since, until) {
  const t = session.start ? Date.parse(session.start) : NaN;
  if (Number.isNaN(t)) return since == null && until == null;
  return (since == null || t >= since) && (until == null || t <= until);
}

export const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
