// Number and text formatting shared by the terminal output and the receipt image.

export const usd = (n) => (n >= 100 ? "$" + n.toFixed(0) : n >= 1 ? "$" + n.toFixed(2) : n > 0 ? "$" + n.toFixed(2) : "$0");
export const pad = (s, n) => String(s).padStart(n);
export const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
export const dur = (ms) => {
  const m = Math.round(ms / 60000);
  if (m >= 100 * 60) return `${(m / 1440).toFixed(1)}d`; // sessions resumed over days: keep the column 5 wide
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
};
