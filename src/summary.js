// Totals across sessions: what --all prints, the dashboard's ALL tab shows, and the all-sessions card draws.
import { projectName } from "./project.js";
import { rankedLabeler, redactedTaskLabel } from "./redact.js";

/**
 * @param {object[]} sessions parsed sessions (light parses are enough)
 * @param {{ redact?: boolean, label?: (name: string) => string }} [opts]
 *   redact: replace project names with neutral labels and hide typed prompts;
 *   label: the labeler to share with a screen; without one, project-1 is the project that cost the most
 * @returns {{ count: number, total: number, projects: [string, number][], tasks: {cost: number, project: string, label: string, index: number, id: string}[] }}
 */
export function summarize(sessions, { redact = false, label } = {}) {
  if (redact && !label) label = rankedLabeler(sessions, (s) => projectName(s.cwd));
  const byProject = new Map();
  const tasks = [];
  let total = 0;
  for (const s of sessions) {
    const project = redact ? label(projectName(s.cwd)) : projectName(s.cwd);
    total += s.cost;
    byProject.set(project, (byProject.get(project) || 0) + s.cost);
    for (const t of s.tasks)
      if (!t.meta) tasks.push({ cost: t.cost, project, label: redact ? redactedTaskLabel(t) : t.short, index: t.index, id: s.id });
  }
  return {
    count: sessions.length,
    total,
    projects: [...byProject].sort((a, b) => b[1] - a[1]),
    tasks: tasks.sort((a, b) => b.cost - a.cost),
  };
}
