#!/usr/bin/env node

/**
 * mcpgw — CLI client for MCP Gateway
 *
 * Token-efficient alternative to MCP protocol for LLM tool access.
 * Instead of JSON Schema definitions sitting in the context window,
 * the model uses familiar --flag value patterns via Bash.
 *
 * Usage:
 *   mcpgw auth login                              # Authenticate
 *   mcpgw <vendor> --help                          # List commands
 *   mcpgw <vendor> <command> [--flag value ...]    # Execute tool
 */

import { Command } from 'commander';
import { login, status, logout } from './auth.js';
import { fetchSchema, callTool } from './api.js';

const program = new Command();

program
  .name('mcpgw')
  .description('CLI client for MCP Gateway — token-efficient tool access for LLMs')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// auth subcommand
// ---------------------------------------------------------------------------
const auth = program.command('auth').description('Manage authentication');
auth.command('login').description('Authenticate with the gateway').action(login);
auth.command('status').description('Show current auth state').action(status);
auth.command('logout').description('Clear stored credentials').action(logout);

// ---------------------------------------------------------------------------
// schema subcommand (debugging / introspection)
// ---------------------------------------------------------------------------
program
  .command('schema <vendor>')
  .description('Show available CLI commands for a vendor')
  .action(async (vendor: string) => {
    try {
      const schema = await fetchSchema(vendor);
      console.log(JSON.stringify(schema, null, 2));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Dynamic vendor commands: mcpgw <vendor> <command> [--flags]
//
// We can't register all vendor subcommands at startup (we don't know them
// until we fetch schemas). Instead, we catch unknown commands and handle
// them dynamically. Commander's .allowUnknownOption() + custom parsing.
// ---------------------------------------------------------------------------

// If the first argument isn't a known subcommand, treat it as a vendor
const knownCommands = new Set(['auth', 'schema', 'help']);

async function handleVendorCommand(args: string[]): Promise<void> {
  const vendor = args[0];
  const rest = args.slice(1);

  // If no command specified or --help, show vendor schema
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    try {
      const schema = await fetchSchema(vendor);
      console.log(`\n${schema.vendorName} (${schema.vendor})\n`);
      console.log('Available commands:\n');
      for (const cmd of schema.commands) {
        console.log(`  ${cmd.command.padEnd(40)} ${cmd.description}`);
      }
      console.log(`\nRun: mcpgw ${vendor} <command> --help  for flag details`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  const command = rest[0];

  // If --help on a specific command, fetch schema and show flags
  if (rest.includes('--help') || rest.includes('-h')) {
    try {
      const schema = await fetchSchema(vendor);
      const cmd = schema.commands.find((c) => c.command === command);
      if (!cmd) {
        console.error(`Unknown command: ${command}`);
        console.error(`Run: mcpgw ${vendor} --help  to see available commands`);
        process.exit(1);
      }
      console.log(`\n${cmd.command} — ${cmd.description}\n`);
      if (cmd.flags.length === 0) {
        console.log('  No flags');
      } else {
        console.log('Flags:\n');
        for (const flag of cmd.flags) {
          const req = flag.required ? ' (required)' : '';
          console.log(`  --${flag.name.padEnd(30)} ${flag.type}${req}`);
          if (flag.description) {
            console.log(`      ${flag.description}`);
          }
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  // Parse --flag value pairs from remaining args
  const flagArgs = rest.slice(1);
  const toolArgs: Record<string, unknown> = {};

  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = flagArgs[i + 1];

      // Boolean flag (no value or next arg is also a flag)
      if (next === undefined || next.startsWith('--')) {
        toolArgs[key] = true;
      } else {
        // Try to parse as JSON for complex values, otherwise use string
        try {
          toolArgs[key] = JSON.parse(next);
        } catch {
          toolArgs[key] = next;
        }
        i++; // skip value
      }
    }
  }

  // The tool name might be in different formats — try the command as-is first,
  // then try the original MCP tool name formats (underscore, camelCase)
  const toolCandidates = [
    command,
    command.replace(/-/g, '_'),                           // kebab → snake
    command.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), // kebab → camelCase
  ];

  const verbose = process.env.MCPGW_VERBOSE === '1';

  let lastError: Error | null = null;
  for (const toolName of toolCandidates) {
    try {
      const { result, timing } = await callTool(vendor, toolName, toolArgs);
      console.log(JSON.stringify(result, null, 2));
      if (verbose && timing) {
        console.error(`[timing] auth:${timing.authMs}ms session:${timing.sessionMs}ms vendor:${timing.vendorMs}ms total:${timing.totalMs}ms`);
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // If it's an auth or server error (not a "tool not found"), don't retry
      if (lastError.message.includes('401') || lastError.message.includes('403') ||
          lastError.message.includes('500') || lastError.message.includes('502')) {
        break;
      }
    }
  }

  console.error(`Error: ${lastError?.message ?? 'Unknown error'}`);
  process.exit(1);
}

// Override commander's default behavior for unknown commands
const rawArgs = process.argv.slice(2);
if (rawArgs.length > 0 && !knownCommands.has(rawArgs[0]) && !rawArgs[0].startsWith('-')) {
  handleVendorCommand(rawArgs).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
} else {
  program.parse();
}
