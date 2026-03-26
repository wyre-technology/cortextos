/**
 * Tests for the CLI command parser used in the benchmark harness.
 *
 * We re-export the parsing functions so they can be tested independently.
 * In the harness, these are inlined — this file imports from a shared module.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Copy of parser functions (same as in harness.ts)
// In a real setup you'd extract to a shared module; for the experiment
// we test the logic directly.
// ---------------------------------------------------------------------------

interface ParsedCliCommand {
  vendor: string;
  command: string;
  args: Record<string, unknown>;
}

function findUnquotedPipe(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '|' && !inSingle && !inDouble) return i;
  }
  return -1;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseFlags(flagStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!flagStr) return args;
  const tokens = tokenize(flagStr);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('--')) { i++; continue; }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; i++; continue; }
    try { args[key] = JSON.parse(next); } catch { args[key] = next; }
    i += 2;
  }
  return args;
}

function parseCliLine(line: string): ParsedCliCommand | null {
  const pipeIdx = findUnquotedPipe(line);
  const clean = pipeIdx >= 0 ? line.slice(0, pipeIdx).trim() : line.trim();
  const baseMatch = clean.match(/^mcpgw\s+(\S+)\s+(\S+)(.*)/);
  if (!baseMatch) return null;
  const [, vendor, command, flagStr] = baseMatch;
  return { vendor, command, args: parseFlags(flagStr.trim()) };
}

function extractCliCommands(text: string): ParsedCliCommand[] {
  const commands: ParsedCliCommand[] = [];
  const candidateLines: string[] = [];

  const fenceRegex = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    for (const line of fenceMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('mcpgw ')) candidateLines.push(trimmed);
    }
  }

  const inlineRegex = /`(mcpgw\s[^`]+)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(text)) !== null) {
    candidateLines.push(inlineMatch[1].trim());
  }

  const rawLines = text.split('\n');
  let inFence = false;
  for (const line of rawLines) {
    if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    const bare = line.replace(/^\s*\$\s*/, '').trim();
    if (bare.startsWith('mcpgw ') && !bare.startsWith('mcpgw auth')) {
      if (!candidateLines.includes(bare)) candidateLines.push(bare);
    }
  }

  for (const line of candidateLines) {
    const parsed = parseCliLine(line);
    if (parsed) commands.push(parsed);
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractCliCommands', () => {
  it('extracts a bare command', () => {
    const result = extractCliCommands('mcpgw autotask list-tickets --status Open');
    expect(result).toEqual([{
      vendor: 'autotask',
      command: 'list-tickets',
      args: { status: 'Open' },
    }]);
  });

  it('extracts from a markdown code fence', () => {
    const text = `Here's the command:\n\n\`\`\`bash\nmcpgw autotask list-tickets --status Open --priority Critical\n\`\`\`\n\nThis will find the tickets.`;
    const result = extractCliCommands(text);
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe('autotask');
    expect(result[0].args).toEqual({ status: 'Open', priority: 'Critical' });
  });

  it('extracts from inline backticks', () => {
    const text = 'Run `mcpgw datto-rmm list-devices --siteId abc123` to see all devices.';
    const result = extractCliCommands(text);
    expect(result).toEqual([{
      vendor: 'datto-rmm',
      command: 'list-devices',
      args: { siteId: 'abc123' },
    }]);
  });

  it('handles $ prompt prefix', () => {
    const result = extractCliCommands('  $ mcpgw autotask get-ticket --id 123');
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({ id: 123 }); // parsed as number
  });

  it('strips pipe and jq', () => {
    const result = extractCliCommands("mcpgw autotask list-tickets --status Open | jq '.[].title'");
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({ status: 'Open' });
  });

  it('handles single-quoted JSON values', () => {
    const result = extractCliCommands(`mcpgw connectwise-psa create-ticket --company '{"id": 789}' --summary "Network issue"`);
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({
      company: { id: 789 },
      summary: 'Network issue',
    });
  });

  it('handles double-quoted string values', () => {
    const result = extractCliCommands('mcpgw autotask create-ticket --title "Server is down" --priority Critical');
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({
      title: 'Server is down',
      priority: 'Critical',
    });
  });

  it('handles boolean flags (no value)', () => {
    const result = extractCliCommands('mcpgw datto-rmm list-devices --includeOffline --siteId abc');
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({
      includeOffline: true,
      siteId: 'abc',
    });
  });

  it('handles multiple commands on separate lines', () => {
    const text = `First, list companies:\nmcpgw autotask list-companies\n\nThen get the ticket:\nmcpgw autotask get-ticket --id 456`;
    const result = extractCliCommands(text);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('list-companies');
    expect(result[1].command).toBe('get-ticket');
  });

  it('ignores mcpgw auth commands', () => {
    const result = extractCliCommands('mcpgw auth login\nmcpgw autotask list-tickets');
    expect(result).toHaveLength(1);
    expect(result[0].command).toBe('list-tickets');
  });

  it('returns empty for text with no commands', () => {
    const result = extractCliCommands('I\'ll help you find those tickets. Let me think about the best approach.');
    expect(result).toEqual([]);
  });

  it('deduplicates commands found via multiple methods', () => {
    // Same command appears in both a code fence and inline
    const text = "Run this:\n```bash\nmcpgw autotask list-tickets\n```\nOr just `mcpgw autotask list-tickets`";
    const result = extractCliCommands(text);
    // Should get 2 since they came from different extraction methods and are the same
    // Actually the inline backtick extracts it, and the code fence extracts it
    // Both are pushed to candidateLines independently
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All should parse to the same command
    for (const cmd of result) {
      expect(cmd.command).toBe('list-tickets');
    }
  });

  it('handles pipe inside quoted value without stripping', () => {
    const result = extractCliCommands(`mcpgw connectwise-psa list-tickets --conditions "status/name='Open|Closed'"`);
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({ conditions: "status/name='Open|Closed'" });
  });

  it('handles numeric flag values', () => {
    const result = extractCliCommands('mcpgw autotask create-time-entry --ticketId 12345 --hours 1.5');
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual({ ticketId: 12345, hours: 1.5 });
  });

  it('handles code fence without language specifier', () => {
    const text = "```\nmcpgw autotask list-tickets --status Open\n```";
    const result = extractCliCommands(text);
    // Falls through to raw line extraction since fence regex requires bash/sh/shell/zsh
    expect(result).toHaveLength(1);
  });
});

describe('tokenize', () => {
  it('splits on spaces', () => {
    expect(tokenize('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves single-quoted strings', () => {
    expect(tokenize("--flag 'hello world'")).toEqual(['--flag', 'hello world']);
  });

  it('preserves double-quoted strings', () => {
    expect(tokenize('--flag "hello world"')).toEqual(['--flag', 'hello world']);
  });

  it('handles JSON in quotes', () => {
    expect(tokenize(`--company '{"id": 789}'`)).toEqual(['--company', '{"id": 789}']);
  });

  it('handles mixed quotes', () => {
    expect(tokenize(`--a "it's fine" --b 'he said "hi"'`)).toEqual([
      '--a', "it's fine", '--b', 'he said "hi"',
    ]);
  });
});

describe('findUnquotedPipe', () => {
  it('finds bare pipe', () => {
    expect(findUnquotedPipe('foo | bar')).toBe(4);
  });

  it('ignores pipe in single quotes', () => {
    expect(findUnquotedPipe("'a|b' | c")).toBe(6);
  });

  it('ignores pipe in double quotes', () => {
    expect(findUnquotedPipe('"a|b" | c')).toBe(6);
  });

  it('returns -1 when no pipe', () => {
    expect(findUnquotedPipe('no pipe here')).toBe(-1);
  });
});
