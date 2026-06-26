import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getAgentDir, getAllAgents, CTX_FRAMEWORK_ROOT } from '@/lib/config';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';

// Security: identifier allowlist for [name] path param. Matches the convention
// used in dashboard/src/app/api/agents/route.ts (VALID_NAME) and
// dashboard/src/app/api/skills/route.ts (VALID_SLUG_LIKE). Used to guard the
// decoded URL segment BEFORE it reaches path.join / fs.readFile / spawnSync.
const VALID_AGENT_NAME = /^[a-z0-9_-]+$/;

interface Cron {
  name: string;
  type?: 'recurring' | 'once';
  /** Required for recurring crons (e.g. "4h", "1d"). */
  interval?: string;
  /** Required for once crons — ISO 8601 datetime. */
  fire_at?: string;
  prompt: string;
}

interface AgentConfig {
  agent_name: string;
  enabled: boolean;
  startup_delay: number;
  max_session_seconds: number;
  working_directory: string;
  crons: Cron[];
}

// Security: returns null when the decoded name (a) fails the identifier-regex
// allowlist OR (b) doesn't match any known agent in allAgents. Refusing the
// raw-decoded fallback closes the path-traversal seam: a request like
// `/api/agents/..%2F..%2Fetc%2Fpasswd/crons` would otherwise decode to
// `../../etc/passwd` and reach getAgentDir/path.join/fs.readFile (MEDIUM
// finding per automated security-review). It also closes a parallel
// shell-arg-injection seam: systemName at line ~123 reaches spawnSync as a
// recipient argument, where a `;`/space-bearing decoded value could re-shape
// the command. Allowlist + must-exist gives both seams a 404, not a 5xx +
// arbitrary fs/exec.
function resolveAgent(name: string): { agentDir: string; org?: string; systemName: string } | null {
  const decoded = decodeURIComponent(name);
  if (!VALID_AGENT_NAME.test(decoded)) return null;
  const allAgents = getAllAgents();
  const entry = allAgents.find(
    a => a.name.toLowerCase() === decoded.toLowerCase()
  );
  if (!entry) return null;
  const systemName = entry.name;
  // entry.name is taken from the registry (server-trusted, NOT caller input)
  // and is the only value used downstream. Re-validate as defense-in-depth
  // in case a future change ever lets caller-controlled data leak into
  // entry.name.
  if (!VALID_AGENT_NAME.test(systemName)) return null;
  const org = entry.org || undefined;
  return { agentDir: getAgentDir(systemName, org), org, systemName };
}

// GET /api/agents/[name]/crons - Read crons from config.json
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const resolved = resolveAgent(name);
  if (!resolved) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const configPath = path.join(resolved.agentDir, 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config: AgentConfig = JSON.parse(raw);
    return Response.json({ crons: config.crons || [] });
  } catch (err) {
    console.error(`[api/agents/${name}/crons] GET error:`, err);
    return Response.json({ crons: [] });
  }
}

// PUT /api/agents/[name]/crons - Update crons in config.json
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const resolved = resolveAgent(name);
  if (!resolved) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { agentDir, systemName } = resolved;

  try {
    const configPath = path.join(agentDir, 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config: AgentConfig = JSON.parse(raw);

    const body = await request.json();
    const crons: Cron[] = body.crons;

    // Validate crons
    if (!Array.isArray(crons)) {
      return Response.json({ error: 'crons must be an array' }, { status: 400 });
    }
    for (const cron of crons) {
      if (!cron.name || !cron.prompt) {
        return Response.json(
          { error: 'Each cron must have name and prompt' },
          { status: 400 }
        );
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(cron.name)) {
        return Response.json(
          { error: `Invalid cron name: ${cron.name}` },
          { status: 400 }
        );
      }
      const cronType = cron.type ?? 'recurring';
      if (cronType === 'recurring') {
        if (!cron.interval || !/^\d+[smhd]$/.test(cron.interval)) {
          return Response.json(
            { error: `Recurring cron "${cron.name}" must have a valid interval (e.g. "4h")` },
            { status: 400 }
          );
        }
      } else if (cronType === 'once') {
        if (!cron.fire_at || isNaN(Date.parse(cron.fire_at))) {
          return Response.json(
            { error: `Once cron "${cron.name}" must have a valid fire_at ISO timestamp` },
            { status: 400 }
          );
        }
      } else {
        return Response.json(
          { error: `Invalid cron type "${cron.type}" for "${cron.name}"` },
          { status: 400 }
        );
      }
    }

    // Update config
    config.crons = crons;
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

    // Notify agent to re-read config via message bus. systemName is
    // server-validated (matched against allAgents registry + regex-checked
    // in resolveAgent), so it's safe to pass as the spawnSync recipient arg
    // without re-shaping the command line.
    try {
      spawnSync(
        'bash',
        [
          path.join(CTX_FRAMEWORK_ROOT, 'bus', 'send-message.sh'),
          systemName,
          'normal',
          'Crons updated via dashboard. Re-read config.json and update your /loop crons.',
        ],
        { timeout: 5000, stdio: 'pipe' },
      );
    } catch {
      // Non-fatal: agent might be offline
    }

    return Response.json({ success: true, crons });
  } catch (err) {
    console.error(`[api/agents/${name}/crons] PUT error:`, err);
    return Response.json({ error: 'Failed to update crons' }, { status: 500 });
  }
}
