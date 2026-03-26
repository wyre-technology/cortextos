import { describe, it, expect } from 'vitest';
import { mcpToolsToCliSchema } from './cli-schema.js';
import type { McpTool } from './tool-cache.js';

describe('mcpToolsToCliSchema', () => {
  it('converts a simple tool with string properties', () => {
    const tools: McpTool[] = [
      {
        name: 'list_tickets',
        description: 'List all tickets',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by status' },
            priority: { type: 'string', description: 'Filter by priority' },
          },
          required: ['status'],
        },
      },
    ];

    const result = mcpToolsToCliSchema(tools);

    expect(result).toEqual([
      {
        command: 'list-tickets',
        description: 'List all tickets',
        flags: [
          { name: 'status', type: 'string', required: true, description: 'Filter by status' },
          { name: 'priority', type: 'string', required: false, description: 'Filter by priority' },
        ],
      },
    ]);
  });

  it('converts camelCase tool names to kebab-case', () => {
    const tools: McpTool[] = [
      { name: 'getCompanyDetails', description: 'Get company', inputSchema: { type: 'object', properties: {} } },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result[0].command).toBe('get-company-details');
  });

  it('handles numeric and boolean types', () => {
    const tools: McpTool[] = [
      {
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Max results' },
            includeArchived: { type: 'boolean', description: 'Include archived' },
            score: { type: 'number', description: 'Min score' },
          },
        },
      },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result[0].flags).toEqual([
      { name: 'limit', type: 'number', required: false, description: 'Max results' },
      { name: 'includeArchived', type: 'boolean', required: false, description: 'Include archived' },
      { name: 'score', type: 'number', required: false, description: 'Min score' },
    ]);
  });

  it('handles nullable union types', () => {
    const tools: McpTool[] = [
      {
        name: 'test',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: ['string', 'null'], description: 'Nullable string' },
          },
        },
      },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result[0].flags[0].type).toBe('string');
  });

  it('handles tools with no inputSchema', () => {
    const tools: McpTool[] = [
      { name: 'ping', description: 'Health check' },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result).toEqual([
      { command: 'ping', description: 'Health check', flags: [] },
    ]);
  });

  it('handles tools with no description', () => {
    const tools: McpTool[] = [
      { name: 'do_thing', inputSchema: { type: 'object', properties: {} } },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result[0].description).toBe('');
  });

  it('handles empty tool list', () => {
    expect(mcpToolsToCliSchema([])).toEqual([]);
  });

  it('handles array and object property types', () => {
    const tools: McpTool[] = [
      {
        name: 'bulk_update',
        description: 'Bulk update',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', description: 'IDs to update' },
            config: { type: 'object', description: 'Configuration object' },
          },
        },
      },
    ];

    const result = mcpToolsToCliSchema(tools);
    expect(result[0].flags[0].type).toBe('array');
    expect(result[0].flags[1].type).toBe('object');
  });
});
