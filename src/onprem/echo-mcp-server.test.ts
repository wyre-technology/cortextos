import { describe, it, expect } from 'vitest';
import { handleEchoMcp } from './echo-mcp-server.js';

describe('echo-mcp-server', () => {
  it('responds to initialize with gateway serverInfo', () => {
    const res = handleEchoMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(res.result.serverInfo.name).toBe('onprem-echo');
    expect(res.result.protocolVersion).toBe('2024-11-05');
  });

  it('lists exactly the echo tool', () => {
    const res = handleEchoMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe('echo');
  });

  it('echoes the message back on tools/call echo', () => {
    const res = handleEchoMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hello tunnel' } },
    }) as { result: { content: { type: string; text: string }[] } };
    expect(res.result.content[0].text).toBe('hello tunnel');
  });

  it('returns a -32601 error for an unknown tool', () => {
    const res = handleEchoMcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'not-echo', arguments: {} },
    }) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it('returns a -32601 error for an unknown method', () => {
    const res = handleEchoMcp({ jsonrpc: '2.0', id: 5, method: 'resources/list' }) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32601);
  });

  it('echoes id back, including null id', () => {
    const res = handleEchoMcp({ jsonrpc: '2.0', id: null, method: 'tools/list' }) as { id: unknown };
    expect(res.id).toBeNull();
  });

  it('tolerates a non-object body without throwing', () => {
    expect(() => handleEchoMcp(null)).not.toThrow();
    expect(() => handleEchoMcp('garbage')).not.toThrow();
  });
});
