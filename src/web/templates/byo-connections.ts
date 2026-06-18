/**
 * BYOMCP registration UI (WYREAI-191).
 *
 * The forms/UI layer over the BYO backend stack: register a non-catalog MCP
 * server (186/188), connect it via OAuth (187), discover its tools (189), and
 * see + pin each tool's permission tier (190 + the 191 manual override).
 *
 * Server-rendered shell (add-form + server list); the per-server tool list +
 * tier-override controls load on demand from the existing JSON route
 * `GET /connect/byo/:id/tools` so a slow/failing BYO endpoint never blocks the
 * page. All mutating actions are POST forms to owner-scoped, SSRF-guarded
 * routes (see byo-registration-routes.ts).
 *
 * Pure render — no I/O, no secrets. The caller passes only server METADATA
 * (never decrypted headers/tokens). Every interpolated value is escapeHtml'd.
 */
import { escapeHtml } from '../helpers.js';

export interface ByoServerView {
  id: string;
  name: string;
  endpointUrl: string;
  transport: string;
  /** True once OAuth tokens have been persisted for this server (187). */
  oauthConnected: boolean;
}

export interface ByoConnectionsData {
  servers: readonly ByoServerView[];
  /** A coarse banner flag from the OAuth/registration redirects (?byo_*). */
  notice?: 'connected' | 'error' | null;
}

export const BYO_CONNECTIONS_STYLES = `
  .byo-wrap { max-width: 760px; }
  .byo-card { border: 1px solid var(--border-secondary); border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; background: var(--bg-sidebar); }
  .byo-card-head { display: flex; align-items: center; gap: 10px; }
  .byo-name { font-weight: 600; font-size: 15px; color: var(--text-primary); }
  .byo-endpoint { font-size: 12px; color: var(--text-muted); word-break: break-all; }
  .byo-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .byo-badge-on { color: #16a34a; border: 1px solid rgba(22,163,74,0.4); }
  .byo-badge-off { color: var(--text-tertiary); border: 1px solid var(--border-secondary); }
  .byo-actions { margin-left: auto; display: flex; gap: 8px; }
  .byo-btn { font-size: 12px; font-weight: 500; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-family: inherit; border: 1px solid var(--border-secondary); background: transparent; color: var(--text-secondary); text-decoration: none; display: inline-block; }
  .byo-btn-primary { color: #2563eb; border-color: rgba(37,99,235,0.4); }
  .byo-btn-danger:hover { color: var(--error); border-color: var(--error); }
  .byo-add { border: 1px solid var(--border-primary); border-radius: 10px; padding: 16px 18px; margin-bottom: 20px; }
  .byo-add input { padding: 8px 12px; border: 1px solid var(--border-primary); border-radius: 6px; background: var(--bg-sidebar); color: var(--text-primary); font-size: 14px; font-family: inherit; width: 100%; box-sizing: border-box; }
  .byo-add label { display: block; font-size: 12px; color: var(--text-secondary); margin: 10px 0 4px; }
  .byo-tools { margin-top: 12px; border-top: 1px solid var(--border-secondary); padding-top: 10px; }
  .byo-tool-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }
  .byo-tool-name { font-family: var(--font-mono, monospace); color: var(--text-primary); }
  .byo-tool-desc { color: var(--text-muted); font-size: 12px; }
  .byo-tier { margin-left: auto; }
  .byo-tier select { font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border-secondary); background: var(--bg-sidebar); color: var(--text-primary); font-family: inherit; }
  .byo-pin { font-size: 10px; color: #2563eb; }
  .byo-empty { padding: 32px 10px; text-align: center; color: var(--text-muted); font-size: 14px; }
  .byo-notice { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .byo-notice-ok { color: #16a34a; border: 1px solid rgba(22,163,74,0.4); }
  .byo-notice-err { color: var(--error); border: 1px solid var(--error); }
`;

function renderServerCard(s: ByoServerView): string {
  const id = escapeHtml(s.id);
  return `
  <div class="byo-card" data-byo-id="${id}">
    <div class="byo-card-head">
      <div>
        <div class="byo-name">${escapeHtml(s.name)}</div>
        <div class="byo-endpoint">${escapeHtml(s.endpointUrl)} · ${escapeHtml(s.transport)}</div>
      </div>
      <span class="byo-badge ${s.oauthConnected ? 'byo-badge-on' : 'byo-badge-off'}">
        ${s.oauthConnected ? 'OAuth connected' : 'not connected'}
      </span>
      <div class="byo-actions">
        <a class="byo-btn byo-btn-primary" href="/connect/byo/${id}/oauth">${s.oauthConnected ? 'Reconnect' : 'Connect via OAuth'}</a>
        <button type="button" class="byo-btn" onclick="byoLoadTools('${id}')">Tools &amp; tiers</button>
        <form method="POST" action="/connect/byo/${id}/delete" style="margin:0" onsubmit="return confirm('Remove this MCP server?')">
          <button type="submit" class="byo-btn byo-btn-danger">Remove</button>
        </form>
      </div>
    </div>
    <div class="byo-tools" id="byo-tools-${id}" hidden></div>
  </div>`;
}

export function renderByoConnections(data: ByoConnectionsData): { body: string; pageStyles: string; pageScripts: string } {
  const notice =
    data.notice === 'connected'
      ? `<div class="byo-notice byo-notice-ok">MCP server connected.</div>`
      : data.notice === 'error'
        ? `<div class="byo-notice byo-notice-err">Something went wrong with the last action. Please try again.</div>`
        : '';

  const list = data.servers.length
    ? data.servers.map(renderServerCard).join('')
    : `<div class="byo-empty">No custom MCP servers yet. Add one above to connect your own tools.</div>`;

  const body = `
  <div class="byo-wrap">
    <h2 style="font-size:18px;margin-bottom:4px">Your MCP servers</h2>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
      Connect a non-catalog MCP server. The gateway validates the endpoint, handles OAuth, and classifies each tool by permission tier — which you can override per tool.
    </p>
    ${notice}
    <form class="byo-add" method="POST" action="/connect/byo">
      <label for="byo-name">Name</label>
      <input id="byo-name" type="text" name="name" placeholder="My MCP server" required maxlength="120" />
      <label for="byo-endpoint">Endpoint URL</label>
      <input id="byo-endpoint" type="url" name="endpoint_url" placeholder="https://your-server.example.com/mcp" required />
      <label for="byo-auth">Authorization header (optional — leave blank to use OAuth)</label>
      <input id="byo-auth" type="text" name="authorization" placeholder="Bearer …" autocomplete="off" />
      <div style="margin-top:12px"><button type="submit" class="byo-btn byo-btn-primary">Add MCP server</button></div>
    </form>
    ${list}
  </div>`;

  // On-demand tool loader: fetch the classified tools for one server and render
  // each with its effective tier + an override <select>. 'auto' clears the pin.
  const pageScripts = `
  <script>
    const BYO_TIERS = ['read','write','admin'];
    async function byoLoadTools(id) {
      const el = document.getElementById('byo-tools-' + id);
      if (!el) return;
      if (!el.hidden) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = '<div class="byo-tool-desc">Loading tools…</div>';
      try {
        const res = await fetch('/connect/byo/' + encodeURIComponent(id) + '/tools', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        const tools = (data && data.tools) || [];
        if (!tools.length) { el.innerHTML = '<div class="byo-tool-desc">No tools discovered.</div>'; return; }
        el.innerHTML = tools.map(function (t) {
          const opts = BYO_TIERS.map(function (tier) {
            return '<option value="' + tier + '"' + (t.tier === tier ? ' selected' : '') + '>' + tier + '</option>';
          }).join('');
          const pin = t.overridden ? '<span class="byo-pin" title="auto: ' + t.autoTier + '">pinned</span>' : '';
          const name = String(t.name).replace(/[&<>"]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]; });
          return '<div class="byo-tool-row"><span class="byo-tool-name">' + name + '</span>' + pin +
            '<span class="byo-tier"><select onchange="byoSetTier(\\'' + id + '\\', this.dataset.tool, this.value)" data-tool="' + name + '">' +
            opts + '<option value="auto">auto</option></select></span></div>';
        }).join('');
      } catch (e) {
        el.innerHTML = '<div class="byo-notice byo-notice-err">Could not load tools.</div>';
      }
    }
    async function byoSetTier(id, tool, tier) {
      const form = new URLSearchParams();
      form.set('tool_name', tool);
      form.set('tier', tier);
      await fetch('/connect/byo/' + encodeURIComponent(id) + '/tools/tier', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      });
    }
  </script>`;

  return { body, pageStyles: BYO_CONNECTIONS_STYLES, pageScripts };
}
