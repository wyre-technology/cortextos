import { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Copy templates/engineer into orgs/<org>/engineers/<engineer>/, substituting
 * {{engineer}} and {{org}} placeholders. Pure function — no process.exit, so
 * it is unit-testable. Throws on invalid input.
 */
export function scaffoldEngineer(frameworkRoot: string, org: string, engineer: string): string {
  if (!NAME_RE.test(engineer)) {
    throw new Error(`Invalid engineer name "${engineer}": must match ${NAME_RE}.`);
  }
  const orgDir = join(frameworkRoot, 'orgs', org);
  if (!existsSync(orgDir)) {
    throw new Error(`Org "${org}" not found at ${orgDir}. Run "cortextos init ${org}" first.`);
  }
  const nsDir = join(orgDir, 'engineers', engineer);
  if (existsSync(nsDir)) {
    throw new Error(`Engineer namespace "${engineer}" already exists at ${nsDir}.`);
  }
  const templateDir = join(frameworkRoot, 'templates', 'engineer');
  if (!existsSync(templateDir)) {
    throw new Error(`templates/engineer not found at ${templateDir}.`);
  }
  copyDir(templateDir, nsDir, engineer, org);
  return nsDir;
}

function copyDir(src: string, dest: string, engineer: string, org: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      copyDir(s, d, engineer, org);
    } else {
      const content = readFileSync(s, 'utf-8')
        .replace(/\{\{engineer\}\}/g, engineer)
        .replace(/\{\{org\}\}/g, org);
      writeFileSync(d, content, 'utf-8');
    }
  }
}

export const addEngineerCommand = new Command('add-engineer')
  .argument('<name>', 'Engineer namespace name')
  .option('--org <org>', 'Organization name')
  .description('Create a per-engineer namespace for personal agents')
  .action((name: string, options: { org?: string }) => {
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();

    let org = options.org;
    if (!org) {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (existsSync(orgsDir)) {
        const orgs = readdirSync(orgsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        if (orgs.length === 1) org = orgs[0];
        else if (orgs.length > 1) {
          console.error('Multiple organizations found. Specify one with --org <name>');
          process.exit(1);
        }
      }
    }
    if (!org) {
      console.error('No organization found. Run "cortextos init <org>" first.');
      process.exit(1);
    }

    try {
      const nsDir = scaffoldEngineer(frameworkRoot, org, name);
      console.log(`\n  Engineer namespace "${name}" created at ${nsDir}`);
      console.log(`\n  Next: add personal agents into the namespace:`);
      console.log(`    cortextos add-agent ${name}/<agent> --org ${org} --template agent\n`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
