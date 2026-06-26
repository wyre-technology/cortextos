import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Security: input + containment validation for POST/DELETE
//
// slug/org/agent enter `path.join(...)` and reach `fs.symlinkSync` /
// `fs.unlinkSync` / `fs.rmSync`. Without containment, a value like
// "../../etc/passwd" lets a caller delete or symlink-overwrite arbitrary
// files (HIGH from automated security-review). Two layers:
//
//   1. Regex allowlist matches the project convention (same VALID_NAME
//      pattern used in dashboard/src/app/api/agents/route.ts:14).
//   2. Resolved-path containment check: even if regex is bypassed somehow,
//      the resolved target MUST sit under the expected ancestor (frameworkRoot
//      for skills, frameworkRoot/orgs for installation targets). path.resolve
//      collapses any `..` so this catches traversal escapes.
// ---------------------------------------------------------------------------
const VALID_SLUG_LIKE = /^[a-z0-9_-]+$/;

function isPathContainedIn(targetAbs: string, ancestorAbs: string): boolean {
  const resolvedTarget = path.resolve(targetAbs);
  const resolvedAncestor = path.resolve(ancestorAbs);
  if (resolvedTarget === resolvedAncestor) return true;
  const ancestorWithSep = resolvedAncestor.endsWith(path.sep)
    ? resolvedAncestor
    : resolvedAncestor + path.sep;
  return resolvedTarget.startsWith(ancestorWithSep);
}

function parseSkillMd(content: string): { name: string; description: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const dm = fm.match(/^description:\s*(.+)$/m);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!name) {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  return { name: name || 'Unnamed Skill', description: description || '' };
}

function getInstalledAgents(frameworkRoot: string, slug: string): string[] {
  const installed: string[] = [];
  const orgsDir = path.join(frameworkRoot, 'orgs');
  if (!fs.existsSync(orgsDir)) return installed;

  for (const orgEntry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = path.join(orgsDir, orgEntry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const skillPath = path.join(agentsDir, agentEntry.name, 'skills', slug);
      if (fs.existsSync(skillPath)) {
        installed.push(`${orgEntry.name}/${agentEntry.name}`);
      }
    }
  }
  return installed;
}

export async function GET() {
  try {
    const frameworkRoot = getFrameworkRoot();
    const catalogDir = path.join(frameworkRoot, 'skills');

    if (!fs.existsSync(catalogDir)) {
      return Response.json([]);
    }

    const entries = fs.readdirSync(catalogDir, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const slug = entry.name;
      const skillMd = path.join(catalogDir, slug, 'SKILL.md');
      const readme = path.join(catalogDir, slug, 'README.md');

      let content = '';
      if (fs.existsSync(skillMd)) content = fs.readFileSync(skillMd, 'utf-8');
      else if (fs.existsSync(readme)) content = fs.readFileSync(readme, 'utf-8');

      const { name, description } = parseSkillMd(content);
      const installedFor = getInstalledAgents(frameworkRoot, slug);

      skills.push({
        slug,
        name: name || slug,
        description,
        installed: installedFor.length > 0,
        installedFor,
      });
    }

    return Response.json(skills.sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    console.error('[api/skills] error:', err);
    return Response.json([]);
  }
}

// POST /api/skills - Install a skill to an agent
export async function POST(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }
    // Security: regex-validate slug/org/agent before path.join.
    if (!VALID_SLUG_LIKE.test(slug) || !VALID_SLUG_LIKE.test(org) || !VALID_SLUG_LIKE.test(agent)) {
      return Response.json(
        { error: 'slug, org, and agent must match /^[a-z0-9_-]+$/' },
        { status: 400 },
      );
    }

    const frameworkRoot = getFrameworkRoot();
    const skillsCatalogRoot = path.join(frameworkRoot, 'skills');
    const orgsRoot = path.join(frameworkRoot, 'orgs');

    const catalogDir = path.join(skillsCatalogRoot, slug);
    // Security: containment check after join — even if regex was bypassed,
    // resolved catalogDir must sit under frameworkRoot/skills.
    if (!isPathContainedIn(catalogDir, skillsCatalogRoot)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    if (!fs.existsSync(catalogDir)) {
      return Response.json({ error: `Skill not found: ${slug}` }, { status: 404 });
    }

    const skillsDir = path.join(orgsRoot, org, 'agents', agent, 'skills');
    if (!isPathContainedIn(skillsDir, orgsRoot)) {
      return Response.json({ error: 'invalid org or agent' }, { status: 400 });
    }
    fs.mkdirSync(skillsDir, { recursive: true });
    const linkPath = path.join(skillsDir, slug);
    if (!isPathContainedIn(linkPath, skillsDir)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }

    try { if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
    fs.symlinkSync(catalogDir, linkPath, 'dir');

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/skills - Uninstall a skill from an agent
export async function DELETE(request: Request) {
  try {
    const { slug, org, agent } = await request.json();
    if (!slug || !org || !agent) {
      return Response.json({ error: 'slug, org, and agent required' }, { status: 400 });
    }
    // Security: same regex + containment as POST. DELETE was the highest-impact
    // path of the original finding (rmSync with caller-controlled segments).
    if (!VALID_SLUG_LIKE.test(slug) || !VALID_SLUG_LIKE.test(org) || !VALID_SLUG_LIKE.test(agent)) {
      return Response.json(
        { error: 'slug, org, and agent must match /^[a-z0-9_-]+$/' },
        { status: 400 },
      );
    }

    const frameworkRoot = getFrameworkRoot();
    const orgsRoot = path.join(frameworkRoot, 'orgs');
    const linkPath = path.join(orgsRoot, org, 'agents', agent, 'skills', slug);
    if (!isPathContainedIn(linkPath, orgsRoot)) {
      return Response.json({ error: 'invalid slug, org, or agent' }, { status: 400 });
    }

    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) fs.unlinkSync(linkPath);
      else if (stat.isDirectory()) fs.rmSync(linkPath, { recursive: true });
    } catch {
      return Response.json({ error: `Skill not installed: ${slug}` }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
