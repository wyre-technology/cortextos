/**
 * Converts MCP tool schemas into CLI-friendly flag definitions.
 *
 * MCP tools have JSON Schema `inputSchema` with nested objects, enums, etc.
 * CLI consumers just need flat flag lists: --name, --type, --required, --description.
 * This module bridges the gap so the mcpgw CLI can auto-generate help text
 * and the LLM sees compact `--flag value` patterns instead of full JSON Schema.
 */

import type { McpTool } from './tool-cache.js';

export interface CliFlag {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
}

export interface CliCommand {
  command: string;
  description: string;
  flags: CliFlag[];
}

/**
 * Convert a JSON Schema type value to a simplified CLI type.
 */
function toCliType(schemaType: unknown): CliFlag['type'] {
  if (typeof schemaType === 'string') {
    switch (schemaType) {
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return 'array';
      case 'object':
        return 'object';
      default:
        return 'string';
    }
  }
  // Union types like ["string", "null"] → use the first non-null type
  if (Array.isArray(schemaType)) {
    const nonNull = schemaType.find((t) => t !== 'null');
    return nonNull ? toCliType(nonNull) : 'string';
  }
  return 'string';
}

/**
 * Convert an MCP tool's inputSchema properties into CLI flags.
 */
function schemaToFlags(inputSchema: unknown): CliFlag[] {
  if (!inputSchema || typeof inputSchema !== 'object') return [];

  const schema = inputSchema as {
    properties?: Record<string, { type?: unknown; description?: string }>;
    required?: string[];
  };

  if (!schema.properties) return [];
  const requiredSet = new Set(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: toCliType(prop.type),
    required: requiredSet.has(name),
    description: prop.description ?? '',
  }));
}

/**
 * Convert MCP tool names to CLI-friendly kebab-case commands.
 * e.g. "list_tickets" → "list-tickets", "getCompany" → "get-company"
 */
function toKebabCase(name: string): string {
  return name
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Convert an array of MCP tools into CLI command definitions.
 */
export function mcpToolsToCliSchema(tools: McpTool[]): CliCommand[] {
  return tools.map((tool) => ({
    command: toKebabCase(tool.name),
    description: tool.description ?? '',
    flags: schemaToFlags(tool.inputSchema),
  }));
}
