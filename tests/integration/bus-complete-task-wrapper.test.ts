/**
 * tests/integration/bus-complete-task-wrapper.test.ts
 *
 * Regression test for bus/complete-task.sh silently corrupting the
 * completion result when called with the `--result "<text>"` flag form.
 * The wrapper only ever read `$2` as a bare positional value — so
 * `complete-task.sh <id> --result "<text>"` (the form every agent
 * bootstrap doc teaches) set RESULT="--result" and dropped the real
 * text (which landed in $3, never read). The stored task.result ended
 * up as the literal string "--result" instead of the intended text.
 *
 * Fixed by forwarding all args after <id> to the CLI as-is, since the
 * underlying `cortextos bus complete-task` command already accepts
 * both a positional result and a --result flag.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");
const WRAPPER = join(REPO_ROOT, "bus", "complete-task.sh");
const ORG = "testorg";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "bus-complete-wrapper-"));
  mkdirSync(join(fakeHome, ".cortextos", "default", "orgs", ORG, "tasks"), {
    recursive: true,
  });
});

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true });
  } catch {
    /* ignore */
  }
});

function taskPath(id: string): string {
  return join(
    fakeHome,
    ".cortextos",
    "default",
    "orgs",
    ORG,
    "tasks",
    `${id}.json`,
  );
}

function writeTask(id: string): void {
  const task = {
    id,
    title: "test task",
    description: "",
    type: "agent",
    needs_approval: false,
    status: "pending",
    assigned_to: "dev",
    created_by: "dev",
    org: ORG,
    priority: "normal",
    project: "",
    kpi_key: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    due_date: null,
    archived: false,
  };
  writeFileSync(taskPath(id), JSON.stringify(task));
}

async function runWrapper(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [WRAPPER, ...args], {
      env: {
        ...process.env,
        HOME: fakeHome,
        CTX_AGENT_NAME: "dev",
        CTX_ORG: ORG,
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(DIST_CLI))("bus/complete-task.sh wrapper", () => {
  it('stores the real text when called with --result "<text>" (flag form)', async () => {
    writeTask("task_flag_form");
    const { code } = await runWrapper([
      "task_flag_form",
      "--result",
      "the actual result text",
    ]);

    expect(code).toBe(0);
    const stored = JSON.parse(
      readFileSync(taskPath("task_flag_form"), "utf-8"),
    );
    expect(stored.result).toBe("the actual result text");
    expect(stored.result).not.toBe("--result");
  });

  it("still stores the text when called positionally (no --result flag)", async () => {
    writeTask("task_positional_form");
    const { code } = await runWrapper([
      "task_positional_form",
      "positional result text",
    ]);

    expect(code).toBe(0);
    const stored = JSON.parse(
      readFileSync(taskPath("task_positional_form"), "utf-8"),
    );
    expect(stored.result).toBe("positional result text");
  });
});
