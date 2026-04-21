# Security Scanning

Baseline security tooling for Conduit. All findings land in the GitHub
**Security** tab of this repo — triage there, not in PR checks. None of
the scans hard-fail the build; they are informational signals, not gates.

## Tools

| Tool        | What it checks                          | Trigger                         | Where findings land                                  |
|-------------|-----------------------------------------|---------------------------------|------------------------------------------------------|
| CodeQL      | Semantic vulns in JS/TS source          | PR, push to `main`, weekly cron | Security → Code scanning (category: `language:*`)    |
| Dependabot  | Vulnerable + outdated npm / docker / actions deps | Weekly (Mon)          | Security → Dependabot alerts, and auto PRs labelled `deps` |
| gitleaks    | Committed secrets (API keys, tokens)    | PR, push to `main`, weekly cron | Security → Code scanning (category: `gitleaks`) + action summary |
| Trivy (fs)  | CVEs in lockfiles, Dockerfile, IaC      | PR, push to `main`, weekly cron | Security → Code scanning (category: `trivy-fs`)      |
| Trivy (img) | CVEs in the published container image   | Push to `main`, weekly cron, manual dispatch | Security → Code scanning (category: `trivy-image`) |
| GitHub secret scanning + push protection | Known-provider secret patterns | Native, on every push           | Security → Secret scanning                           |

The last one is a **repo setting**, not a workflow file. An admin must
enable it under **Settings → Code security and analysis**:

- Secret scanning: **Enabled**
- Push protection: **Enabled**
- Dependabot alerts: **Enabled** (security updates: enabled)

## Workflow files

- `.github/workflows/codeql.yml`
- `.github/workflows/gitleaks.yml`
- `.github/workflows/trivy.yml`
- `.github/dependabot.yml`

All action versions are pinned to major-version tags
(`actions/checkout@v4`, `github/codeql-action/*@v3`,
`gitleaks/gitleaks-action@v2`, `aquasecurity/trivy-action@0.28.0`).
Dependabot's `github-actions` ecosystem keeps these current.

## Triage workflow

1. **Daily (on-call):** skim Security tab for new CRITICAL / HIGH alerts.
2. **Weekly:** review the Dependabot PR queue. Merge patch/minor updates
   that pass CI. Defer majors to a batched window.
3. **Secret alert (gitleaks or native):** treat as an incident —
   rotate the credential first, then rewrite history only if the secret
   cannot be invalidated server-side.
4. **Dismiss with reason:** use GitHub's dismiss-with-comment so the
   audit trail reflects why an alert was intentionally closed.

## Baseline goal (PRD A16)

Zero unresolved alerts across Dependabot, gitleaks, CodeQL, and native
secret scanning on `main`. Track drift from that baseline in the weekly
merge-back review.

## Why non-blocking

The PRD (§4.8) calls for signal, not a trip-wire. Failing PRs on every
new transitive CVE creates alert fatigue and incentivises bypassing
the checks. SARIF upload + dismiss-with-reason keeps the audit trail
honest without blocking unrelated merges.
