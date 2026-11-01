// --redact: remove everything personal from a parsed session so its receipt can be shared.
// Numbers are untouched; only texts, paths and names are replaced.

/** The label a task keeps once redacted: automatic prompts keep their kind, typed ones say nothing. */
export function redactedTaskLabel(t) {
  const auto = t.short.match(/^\[automatic: ([a-z-]+)\]/);
  if (auto) return `[automatic: ${auto[1]}]`;
  return t.meta ? t.short : "(prompt redacted)";
}

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
    t.prompt = "";
    t.short = redactedTaskLabel(t);
  }
  for (const c of s.calls) c.text = "";
  for (const tc of s.toolCalls) tc.summary = tc.ext ? `*${tc.ext}` : "";
  for (const a of s.agents) a.description = a.type || "sub-agent";
  s.redacted = true;
  return s;
}

/**
 * Neutral names numbered by spend: project-1 is the project that cost the most across `sessions`.
 * Pass it project names (projectName(cwd)); a name not in `sessions` gets the next free number.
 */
export function rankedLabeler(sessions, nameOf) {
  const spend = new Map();
  for (const s of sessions) {
    const name = nameOf(s);
    spend.set(name, (spend.get(name) || 0) + s.cost);
  }
  const ranked = new Map([...spend].sort((a, b) => b[1] - a[1]).map(([name], i) => [name, `project-${i + 1}`]));
  return (name) => {
    if (!ranked.has(name)) ranked.set(name, `project-${ranked.size + 1}`);
    return ranked.get(name);
  };
}

/** Stable neutral names for projects: the first project seen is project-1, and so on. Pass it the project name, not the raw cwd. */
export function projectLabeler() {
  const seen = new Map();
  return (name) => {
    const key = name || "";
    if (!seen.has(key)) seen.set(key, `project-${seen.size + 1}`);
    return seen.get(key);
  };
}
