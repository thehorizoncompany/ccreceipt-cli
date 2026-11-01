# Contributing

This repository follows one workflow for every change. The same rules apply to the ccreceipt macOS app.

## 1. One issue per feature

Every change starts from an issue created with the **Feature** or **Bug report** template. An issue covers one feature or one unit of work, and ends in one pull request.

Each issue has:

- a **type** label: `type: feat`, `type: fix`, `type: chore`, `type: refactor`, `type: docs`, `type: test`, `type: ci`, `type: perf`
- a **priority** label:

| Label | Meaning |
|---|---|
| `priority: P0` | Blocks the release. Do first. |
| `priority: P1` | High. Needed for the target version. |
| `priority: P2` | Medium. Planned, can move to the next version. |
| `priority: P3` | Low. Only if time or demand. |

- a **milestone**: the target version, `vX.Y.Z`.

## 2. Branches

| Branch | Created from | Merged into | Example |
|---|---|---|---|
| `main` | | | Released code only. Every commit on `main` is a released version. |
| `release/vX.Y.Z` | `main` | `main` | `release/v0.1.0` |
| `<type>/<issue>-<short-name>` | the version branch | the version branch | `feat/3-redact-prompts` |
| `hotfix/vX.Y.Z` | `main` | `main` | `hotfix/v0.1.1` |

Branch types follow the commit types: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`, `ci/`, `perf/`.

Flow for a version:

1. Create `release/vX.Y.Z` from `main` when work on that version starts.
2. For each issue of the milestone, create `<type>/<issue>-<short-name>` from the version branch.
3. Open a pull request from the issue branch into the version branch. It is merged once its acceptance criteria are met and checks are green.
4. When every P0 and P1 issue of the milestone is merged, move the unfinished issues to the next milestone, then open a pull request from `release/vX.Y.Z` into `main`. Its description lists `Closes #n` for every issue left in the milestone (see section 4).
5. Release (section 4).

Issues that are not finished move to the next milestone; they never block a version unless they are P0.

## 3. Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --redact flag
fix(parse): count 1-hour cache writes at 2x input price
chore: npm package metadata
```

One logical change per commit. Reference the issue in the pull request, not necessarily in every commit.

## 4. Releases

Versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version (`0.2.0`) can contain breaking changes to flags or JSON output; they are listed in the release notes.

To release `vX.Y.Z`:

1. On the version branch, set `"version": "X.Y.Z"` in `package.json`.
2. Merge `release/vX.Y.Z` into `main` with a merge commit (no squash, so the history of the version stays readable).

   GitHub only closes an issue from a pull request that targets the default branch. Issue pull requests target the version branch, so their `Closes #n` does nothing. The release pull request into `main` must therefore list every issue of the milestone itself. This prints the lines to paste:

   ```bash
   gh issue list --milestone vX.Y.Z --state open --json number --jq '.[] | "Closes #\(.number)"'
   ```
3. Tag the merge commit `vX.Y.Z` and publish a GitHub Release with the notes: new features, fixes, breaking changes, one line each, with the issue numbers.
4. Publishing the GitHub Release publishes the package to npm with provenance (`.github/workflows/publish.yml`). The workflow fails if the tag is not `v` + the `package.json` version. A release marked as pre-release is published under the npm tag `next`. One-time setup: an npm automation token in the repository secret `NPM_TOKEN`.
5. Delete the version branch once released.

A hotfix starts from `main` on `hotfix/vX.Y.Z`, gets its own issue, is merged into `main`, released, then merged into the open version branch if there is one.

## 5. Pull requests

Use the pull request template. A pull request:

- targets the version branch (or `main` for a version or hotfix branch)
- closes exactly one issue
- passes the test workflow
- contains no real session data: fixtures are synthetic, screenshots are made with `--redact`
