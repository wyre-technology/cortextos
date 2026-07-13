#!/usr/bin/env node
// Wire the context-status statusLine hook into every agent's .claude/settings.json.
//
// The daemon's context-handoff (fast-checker.ts checkContextStatus) reads
// state/<agent>/context_status.json, which is ONLY written when Claude runs the
// `cortextos bus hook-context-status` statusLine hook. Agents whose settings.json
// lack that hook never emit context data, so the handoff can never fire — the agent
// runs to context exhaustion and freezes. Live agent settings.json are gitignored
// local instance state (not tracked), so this apply is operational, not a PR change.
//
// statusLine-ONLY by design: this is the freeze-cure make-or-break wiring and nothing
// else. It does NOT touch permissions/allowlist (a separate concern). Idempotent:
// re-running skips agents already wired. Agents must be RESTARTED to pick up the new
// statusLine (Claude reads settings.json at session start).
//
// Usage:
//   node scripts/wire-statusline.mjs --dry-run   # preview, writes nothing
//   node scripts/wire-statusline.mjs             # apply

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const STATUS_LINE = {
  type: 'command',
  command: 'cortextos bus hook-context-status',
  refreshInterval: 5,
  timeout: 2,
};

const dryRun = process.argv.includes('--dry-run');
const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
const orgsDir = join(frameworkRoot, 'orgs');

if (!existsSync(orgsDir)) {
  console.error(`orgs/ not found at ${orgsDir} — run from the framework root or set CTX_FRAMEWORK_ROOT.`);
  process.exit(1);
}

let wired = 0;
let already = 0;
for (const org of readdirSync(orgsDir)) {
  const agentsDir = join(orgsDir, org, 'agents');
  if (!existsSync(agentsDir)) continue;
  for (const agent of readdirSync(agentsDir)) {
    const settingsPath = join(agentsDir, agent, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) continue;

    let settings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.warn(`  SKIP ${org}/${agent}: settings.json does not parse`);
      continue;
    }

    if (settings.statusLine) {
      already++;
      continue;
    }

    if (dryRun) {
      console.log(`  DRY  ${org}/${agent}: would add statusLine hook-context-status`);
      wired++;
    } else {
      settings.statusLine = STATUS_LINE;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
      console.log(`  WIRE ${org}/${agent}: statusLine added`);
      wired++;
    }
  }
}

const verb = dryRun ? 'Would wire' : 'Wired';
console.log(`\n${verb} ${wired} agent(s); ${already} already wired.`);
if (!dryRun && wired > 0) {
  console.log('Restart each affected agent (staggered) to apply; then verify state/<agent>/context_status.json writes a non-null pct.');
}
