import { describe, it, expect } from 'vitest';
import { renderByoConnections, type ByoServerView } from './byo-connections.js';

const server = (over: Partial<ByoServerView> = {}): ByoServerView => ({
  id: 'srv-1',
  name: 'My Server',
  endpointUrl: 'https://byo.example.com/mcp',
  transport: 'streamable-http',
  oauthConnected: false,
  ...over,
});

describe('renderByoConnections', () => {
  it('renders the add-server form posting to /connect/byo with name + endpoint fields', () => {
    const { body } = renderByoConnections({ servers: [] });
    expect(body).toContain('action="/connect/byo"');
    expect(body).toContain('name="name"');
    expect(body).toContain('name="endpoint_url"');
    expect(body).toContain('name="authorization"');
  });

  it('shows an empty state when there are no servers', () => {
    const { body } = renderByoConnections({ servers: [] });
    expect(body).toContain('No custom MCP servers yet');
  });

  it('renders a server card with OAuth connect + delete + tools controls', () => {
    const { body } = renderByoConnections({ servers: [server()] });
    expect(body).toContain('My Server');
    expect(body).toContain('https://byo.example.com/mcp');
    expect(body).toContain('href="/connect/byo/srv-1/oauth"');
    expect(body).toContain('action="/connect/byo/srv-1/delete"');
    expect(body).toContain("byoLoadTools('srv-1')");
    expect(body).toContain('Connect via OAuth');
  });

  it('reflects an already-connected server (Reconnect + connected badge)', () => {
    const { body } = renderByoConnections({ servers: [server({ oauthConnected: true })] });
    expect(body).toContain('OAuth connected');
    expect(body).toContain('Reconnect');
  });

  it('escapes hostile server metadata (no raw injection)', () => {
    const { body } = renderByoConnections({
      servers: [server({ name: '<script>alert(1)</script>', endpointUrl: 'https://x/"><img>' })],
    });
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('"><img>');
  });

  it('the page script fetches the classified-tools endpoint and posts tier overrides', () => {
    const { pageScripts } = renderByoConnections({ servers: [server()] });
    expect(pageScripts).toContain("/tools'"); // GET …/tools (discovery)
    expect(pageScripts).toContain('/tools/tier'); // POST tier override
    expect(pageScripts).toContain('byoSetTier');
    // The override <select> offers the three tiers + an 'auto' (clear) option.
    expect(pageScripts).toContain('value="auto"');
    expect(pageScripts).toContain("['read','write','admin']");
  });

  it('surfaces a coarse notice banner from the redirect flag', () => {
    expect(renderByoConnections({ servers: [], notice: 'connected' }).body).toContain('MCP server connected');
    expect(renderByoConnections({ servers: [], notice: 'error' }).body).toContain('Something went wrong');
    expect(renderByoConnections({ servers: [] }).body).not.toContain('byo-notice');
  });
});
