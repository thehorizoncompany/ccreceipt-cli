// Project name shown in --list, --all and the reports.
// Claude Code runs parallel sessions in worktrees under <repo>/.claude/worktrees/<random-name>;
// those belong to <repo>, not to a project named after the worktree.

/** @param {string|null|undefined} cwd working directory of a session (POSIX or Windows) */
export function projectName(cwd) {
  if (!cwd) return "?";
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  const i = parts.lastIndexOf(".claude");
  if (i > 0 && parts[i + 1] === "worktrees") return parts[i - 1];
  return parts[parts.length - 1] || "?";
}

/** `path` with the home folder written as ~, for what is shown on screen. */
export function tildePath(path, home, separator = "/") {
  if (!home) return path;
  return path === home || path.startsWith(home + separator) ? "~" + path.slice(home.length) : path;
}
