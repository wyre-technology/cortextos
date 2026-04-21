#!/usr/bin/env bash
# sync-upstream.sh
#
# Report (and optionally merge) upstream mcp-gateway commits into Conduit.
#
# Default behavior is a dry-run report:
#   - fetches `upstream`
#   - shows `git log conduit-main..upstream/main --oneline`
#   - highlights upstream commits that touch files Conduit has diverged on
#
# Pass `--execute` to actually perform a `git merge upstream/main`. The merge
# is always attempted in a dedicated sync branch so the caller can abort
# cleanly if conflicts arise.
#
# Exits non-zero if the working tree is dirty, if the upstream remote is
# missing, or if anything else goes wrong. See docs/operations/upstream-sync.md
# for the full runbook.

set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH="${LOCAL_BRANCH:-main}"
EXECUTE=0

usage() {
    cat <<EOF
Usage: $(basename "$0") [--execute] [-h|--help]

Options:
  --execute    Perform the merge from ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into a new sync branch.
               Without this flag the script only reports.
  -h, --help   Show this help text.

Environment overrides:
  UPSTREAM_REMOTE (default: upstream)
  UPSTREAM_BRANCH (default: main)
  LOCAL_BRANCH    (default: main)
EOF
}

log()  { printf '[sync-upstream] %s\n' "$*" >&2; }
fail() { printf '[sync-upstream][ERROR] %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "${arg}" in
        --execute) EXECUTE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "Unknown argument: ${arg}" ;;
    esac
done

# Verify we're inside the conduit repo.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "${REPO_ROOT}" ]] || fail "Not inside a git repository."
cd "${REPO_ROOT}"

# Verify upstream remote is configured.
if ! git remote get-url "${UPSTREAM_REMOTE}" >/dev/null 2>&1; then
    fail "Remote '${UPSTREAM_REMOTE}' is not configured. Run: git remote add ${UPSTREAM_REMOTE} <url>"
fi

# Fail loudly on uncommitted local changes.
if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Working tree has uncommitted changes. Commit or stash before syncing."
fi

# Also reject untracked files that would be clobbered by a merge.
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    log "Warning: untracked files present. They will be left alone but may conflict with a merge."
fi

log "Fetching ${UPSTREAM_REMOTE}..."
git fetch --prune --tags "${UPSTREAM_REMOTE}"

UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
if ! git rev-parse --verify --quiet "${UPSTREAM_REF}" >/dev/null; then
    fail "Ref ${UPSTREAM_REF} does not exist after fetch."
fi

RANGE="${LOCAL_BRANCH}..${UPSTREAM_REF}"
COMMIT_COUNT="$(git rev-list --count "${RANGE}")"

log "Upstream range: ${RANGE}"
log "New upstream commits not yet in ${LOCAL_BRANCH}: ${COMMIT_COUNT}"

if [[ "${COMMIT_COUNT}" -eq 0 ]]; then
    log "Nothing to sync."
    exit 0
fi

echo
echo "=== Upstream commits (${RANGE}) ==="
git log --oneline --no-decorate "${RANGE}"

# Build the set of files where Conduit has diverged from upstream's merge base.
MERGE_BASE="$(git merge-base "${LOCAL_BRANCH}" "${UPSTREAM_REF}")"
DIVERGED_FILES_TMP="$(mktemp)"
trap 'rm -f "${DIVERGED_FILES_TMP}"' EXIT

git diff --name-only "${MERGE_BASE}" "${LOCAL_BRANCH}" > "${DIVERGED_FILES_TMP}" || true

if [[ -s "${DIVERGED_FILES_TMP}" ]]; then
    echo
    echo "=== Upstream commits touching files Conduit has diverged on ==="
    any_overlap=0
    while IFS= read -r sha; do
        [[ -n "${sha}" ]] || continue
        touched="$(git show --name-only --pretty=format: "${sha}" | sed '/^$/d')"
        overlap=""
        while IFS= read -r f; do
            [[ -n "${f}" ]] || continue
            if grep -Fxq "${f}" "${DIVERGED_FILES_TMP}"; then
                overlap+="  ${f}"$'\n'
            fi
        done <<< "${touched}"
        if [[ -n "${overlap}" ]]; then
            any_overlap=1
            subject="$(git log -1 --format='%h %s' "${sha}")"
            echo "- ${subject}"
            printf '%s' "${overlap}"
        fi
    done < <(git rev-list "${RANGE}")
    if [[ "${any_overlap}" -eq 0 ]]; then
        echo "(no overlap with Conduit-divergent files)"
    fi
else
    echo
    echo "(Conduit has no divergent files vs. merge base; nothing to flag.)"
fi

if [[ "${EXECUTE}" -eq 0 ]]; then
    echo
    log "Dry run complete. Re-run with --execute to perform the merge."
    exit 0
fi

SYNC_BRANCH="sync/upstream-$(date -u +%Y%m%d-%H%M%S)"
log "Creating sync branch ${SYNC_BRANCH} from ${LOCAL_BRANCH}..."
git checkout -b "${SYNC_BRANCH}" "${LOCAL_BRANCH}"

log "Merging ${UPSTREAM_REF} (no-ff)..."
if git merge --no-ff --no-edit "${UPSTREAM_REF}"; then
    log "Merge succeeded on ${SYNC_BRANCH}. Push and open a PR to land it."
else
    log "Merge produced conflicts. Resolve on ${SYNC_BRANCH}, commit, then open a PR."
    exit 1
fi
