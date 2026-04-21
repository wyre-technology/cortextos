# Upstream Sync Runbook

Conduit is currently a downstream fork of the `mcp-gateway` product repo
(`git@github.com:wyre-technology/mcp-gateway.git`). Until the eventual
merge-back, we periodically pull upstream changes into Conduit so that
security fixes, vendor integrations, and core engine improvements land here
without divergence spiraling out of control.

This runbook documents how we do that safely.

## Remotes

- `origin` — `wyre-technology/wyre-mcp-gateway-platform` (this repo)
- `upstream` — `wyre-technology/mcp-gateway` (the product repo)

Check your local config with `git remote -v`. If `upstream` is missing:

```bash
git remote add upstream git@github.com:wyre-technology/mcp-gateway.git
git fetch upstream
```

## Cadence

- **Automated dry-run report**: every Monday 13:00 UTC via
  `.github/workflows/upstream-sync-report.yml`. It opens (or comments on)
  a GitHub issue labeled `upstream-sync` summarizing new upstream commits.
- **Manual sync cadence**: target one merge per sprint, or sooner if the
  weekly report flags a security fix, a migration, or a change to a file
  Conduit has diverged on.
- **Emergency sync**: if upstream ships a security advisory, sync the
  relevant commit(s) the same day out-of-band. Cherry-pick if a full merge
  would drag in unrelated work.

## Tooling

The script `scripts/sync-upstream.sh` is the entry point.

- `scripts/sync-upstream.sh` — dry run. Fetches upstream, prints
  `git log main..upstream/main --oneline`, then flags any upstream commits
  that touch files Conduit has diverged on (computed against the merge
  base). No mutation.
- `scripts/sync-upstream.sh --execute` — creates a `sync/upstream-<ts>`
  branch off `main` and runs `git merge --no-ff upstream/main` into it.
  The script refuses to run if the working tree is dirty.

Environment overrides: `UPSTREAM_REMOTE`, `UPSTREAM_BRANCH`, `LOCAL_BRANCH`.

## Standard procedure

1. Start from a clean `main`:
   ```bash
   git checkout main
   git pull --ff-only origin main
   git status   # must be clean
   ```
2. Run the dry-run report:
   ```bash
   ./scripts/sync-upstream.sh
   ```
   Read the "commits touching files Conduit has diverged on" section
   carefully. Those are your likely conflicts.
3. If the dry-run looks reasonable, execute the merge:
   ```bash
   ./scripts/sync-upstream.sh --execute
   ```
   You will be on a new `sync/upstream-<timestamp>` branch.
4. Resolve conflicts (see policy below), run the full test suite
   (`npm test`, migration checks, smoke against a staging DB), and push:
   ```bash
   git push -u origin sync/upstream-<timestamp>
   gh pr create --fill --base main --label upstream-sync
   ```
5. Request review per CODEOWNERS. Do **not** self-merge sync PRs touching
   `migrations/`, `src/billing/`, or reseller paths.

## Conflict policy

Conduit diverges from upstream in a small number of well-known areas:

- `migrations/` — Conduit has additional reseller/tenancy migrations.
- `src/billing/` — Conduit has downstream billing logic not yet upstream.
- `src/reseller/` (when present) — Conduit-only.
- Branding assets under `src/brand/` and `src/landing/`.
- Deployment workflows under `.github/workflows/deploy-*.yml`.

Rules when a conflict lands in one of these paths:

1. **Never** force-accept upstream in Conduit-owned code. Hand-merge.
2. **Never** drop an upstream migration. If the numbering clashes, renumber
   the Conduit migration and note the rename in `CHANGELOG.md`.
3. For `package.json` / lockfile conflicts, accept the union of
   dependencies but regenerate the lockfile locally (`npm install`) rather
   than hand-editing.
4. For workflow conflicts, prefer Conduit's `deploy-*.yml` verbatim;
   accept upstream edits to `ci.yml` / `release.yml` unless they remove a
   Conduit-specific step.

If a conflict is ambiguous, stop and escalate per "Arbitration" below
rather than guessing.

## Arbitration

- **Primary arbiter**: Conduit tech lead (currently Aaron Sachs).
- **Billing conflicts**: billing owner per CODEOWNERS must sign off.
- **Migration conflicts**: DBA / platform on-call must sign off before
  merge, and the resulting migration must be dry-run against a prod
  snapshot before landing.
- **Security fixes**: the person who opened the sync PR may self-approve
  emergency cherry-picks during an active incident, but must file a
  follow-up issue for post-incident review within 24 hours.

## Rollback

Sync PRs are merged as **merge commits** (`--no-ff`) precisely so they can
be reverted atomically.

1. Identify the merge commit: `git log --merges --oneline -n 20`.
2. Revert it:
   ```bash
   git revert -m 1 <merge-sha>
   git push origin main
   ```
   The `-m 1` keeps Conduit's first-parent history.
3. If the sync included a migration that already ran in any environment,
   **do not** simply revert. Instead:
   - Author a forward-only reversal migration.
   - Re-run `scripts/sync-upstream.sh` after the reversal lands so the
     next sync attempt has a clean base.
4. File a retro note in the sync issue and link it from `CHANGELOG.md`.

## Known hazards

- Upstream occasionally force-pushes release branches. Always compare
  against `upstream/main`, never a release branch, for the weekly report.
- `git merge --no-ff` with a signed-commit policy requires the merger to
  have GPG/SSH signing configured. Check `git config commit.gpgsign`
  before running `--execute`.
- The weekly workflow uses `GITHUB_TOKEN`, which cannot create labels it
  does not already know about. Create the `upstream-sync` label once
  manually (`gh label create upstream-sync --description "Upstream sync
  reports and PRs" --color ededed`).

## Change log

When you change this runbook, add an entry to `CHANGELOG.md` under
`### Changed` referencing `docs/operations/upstream-sync.md`.
