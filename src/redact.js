// --redact: remove everything personal from a parsed session so its receipt can be shared.
// Numbers are untouched; only texts, paths and names are replaced.

/**
 * @param {object} s a session returned by parseSession
 * @param {string} [projectLabel] neutral project name to show instead of the working directory (e.g. "project-1")
 */
export function redactSession(s, projectLabel) {
  s.title = `Session ${s.id.slice(0, 8)}`;
  s.file = `${s.id}.jsonl`;
  s.cwd = projectLabel || null;
  s.branch = null;
  s.prs = [];
  for (const t of s.tasks) {
    const auto = t.short.match(/^\[automatic: ([a-z-]+)\]/);
    t.prompt = "";
    if (auto) t.short = `[automatic: ${auto[1]}]`;
    else if (!t.meta) t.short = "(prompt redacted)";
  }
  for (const c of s.calls) c.text = "";
  for (const tc of s.toolCalls) tc.summary = tc.ext ? `*${tc.ext}` : "";
  for (const a of s.agents) a.description = a.type || "sub-agent";
  s.redacted = true;
  return s;
}

/** Stable neutral names for projects: the first project seen is project-1, and so on. */
export function projectLabeler() {
  const seen = new Map();
  return (cwd) => {
    const key = cwd || "";
    if (!seen.has(key)) seen.set(key, `project-${seen.size + 1}`);
    return seen.get(key);
  };
}
