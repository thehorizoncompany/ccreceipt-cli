## Issue

Closes #

## What changed

-

## Branches

- Source: `<type>/<issue>-<short-name>`
- Target: `release/vX.Y.Z` (or `main` for a version branch)

## Checklist

- [ ] The branch was created from the current version branch
- [ ] All acceptance criteria of the issue are met
- [ ] `npm test` passes (and `bun test` if the change touches parsing or I/O)
- [ ] README and `--help` updated if a flag or an output changed
- [ ] No real session data, prompt or personal path in fixtures, screenshots or logs
