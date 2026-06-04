import { PER_SEAT_PRICE_CENTS } from '../../billing/prices.js';
import { escapeHtml } from '../helpers.js';
import { formatUsd } from './seat-billing-copy.js';

export interface TeamDomainsData {
  orgId: string;
  domains: {
    id: string;
    domain: string;
    verificationToken: string;
    verifiedAt: string | null;
    autoJoinRole: 'member' | 'admin';
  }[];
}

export const TEAM_DOMAINS_STYLES = `
  /* Consumes brand-token migration shipped in PR #337 (THEME_VARS):
   * - --accent (lime) for primary CTAs (Add, Verify)
   * - --text-on-accent for legible text on the lime fill
   * - --accent-text (cyan) for link-style emphasis
   * - --error-text / --success-text for status messaging
   * - --bg-card / --border-primary / --text-primary for surfaces
   * Per Aaron-flag "generic text buttons that sort of just suck" — this
   * upgrade replaces the unstyled <button> defaults with proper
   * tokenized buttons so the page renders in the new design language.
   */
  .domain-row {
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 16px; border-bottom:1px solid var(--border-secondary, var(--border));
  }
  .domain-row:last-child { border-bottom:none; }
  .domain-name { font-weight:600; font-size:14px; color:var(--text-primary); }

  /* Status badges — tokenized so dark/light + brand updates flow through */
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600; margin-left:8px; }
  .badge-verified { background:var(--badge-event-bg); color:var(--success-text); }
  .badge-pending { background:var(--badge-personal-bg); color:var(--warning-text); }

  /* DNS-record block — monospace, surface-tokened */
  .dns-block {
    font-family: var(--font-mono, ui-monospace, monospace);
    background: var(--bg-input, var(--bg-card));
    color: var(--text-primary);
    padding:10px 14px; border:1px solid var(--border-tertiary, var(--border));
    border-radius:6px; font-size:12px; margin-top:8px;
    word-break:break-all;
  }
  .dns-help { font-size:12px; color:var(--text-secondary); margin-top:6px; }

  /* Action buttons — primary fills lime, secondary is outline.
   * Replaces the previous browser-default-button look. */
  .domain-actions { display:flex; gap:8px; }
  .domain-actions button,
  .add-form button {
    font-family: var(--font-heading, 'Oswald', sans-serif);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 7px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
    line-height: 1.2;
  }
  /* Primary: lime fill, dark text-on-accent (per --text-on-accent SoT) */
  .btn-create-invite {
    background: var(--accent);
    color: var(--text-on-accent, #0a0a0a);
    border-color: var(--accent);
  }
  .btn-create-invite:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  /* Secondary: outline, picks up text-color, hover fills */
  .btn-disconnect {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-primary);
  }
  .btn-disconnect:hover {
    background: var(--bg-hover);
    color: var(--error-text);
    border-color: var(--error-text);
  }

  .add-form { display:flex; gap:10px; margin-top:16px; align-items:stretch; }
  .add-form input {
    flex:1;
    padding:8px 12px;
    background: var(--bg-input);
    color: var(--text-primary);
    border:1px solid var(--border-primary);
    border-radius:6px;
    font-family: var(--font-body);
    font-size: 14px;
    transition: border-color 120ms ease;
  }
  .add-form input:focus {
    outline: none;
    border-color: var(--accent-text);
  }

  #domainStatus { font-size:13px; margin-top:10px; min-height:18px; }
  .status-error { color: var(--error-text); }
  .status-ok { color: var(--success-text); }
`;

export function renderTeamDomains(data: TeamDomainsData): string {
  const { orgId, domains } = data;
  // Price comes from the named SoT constant, not a per-org snapshot.
  const perSeat = formatUsd(PER_SEAT_PRICE_CENTS);

  const rows = domains.length === 0
    ? `<div style="padding:16px;color:var(--text-muted);text-align:center">No domains claimed yet. Add one below.</div>`
    : domains.map((d) => {
        const verified = d.verifiedAt !== null;
        const badge = verified
          ? `<span class="badge badge-verified">Verified</span>`
          : `<span class="badge badge-pending">Pending DNS</span>`;
        const dnsBlock = verified
          ? ''
          : `
            <div class="dns-block">_conduit-verify.${escapeHtml(d.domain)}&nbsp;&nbsp;TXT&nbsp;&nbsp;"${escapeHtml(d.verificationToken)}"</div>
            <div class="dns-help">Add this TXT record at your DNS provider, then click <b>Verify</b>.</div>
          `;
        const verifyBtn = verified
          ? ''
          : `<button class="btn-create-invite" onclick="verifyDomain('${escapeHtml(d.id)}')">Verify</button>`;
        return `
          <div class="domain-row">
            <div style="flex:1">
              <div><span class="domain-name">${escapeHtml(d.domain)}</span>${badge}
                <span style="color:var(--text-muted);font-size:12px;margin-left:8px">auto-join as ${escapeHtml(d.autoJoinRole)}</span>
              </div>
              ${dnsBlock}
            </div>
            <div class="domain-actions">
              ${verifyBtn}
              <button class="btn-disconnect" onclick="deleteDomain('${escapeHtml(d.id)}')">Remove</button>
            </div>
          </div>
        `;
      }).join('');

  return `
    <div>
      <h1 style="margin-bottom:4px">Claimed Domains</h1>
      <p class="section-desc">
        Teammates who sign up from a verified domain can one-click join your organization
        instead of needing an invite link. Public providers (gmail, outlook, …) can't be claimed.
      </p>
      <p class="section-desc domain-seat-note">
        Heads up: each teammate who auto-joins takes a ${escapeHtml(perSeat)}/mo member
        seat, the same as an invited member — auto-join can grow your bill without a
        per-person confirmation step.
      </p>
    </div>

    <div class="org-section" style="padding:0;overflow:hidden;margin-top:16px">
      ${rows}
    </div>

    <div class="org-section" style="margin-top:16px;padding:16px 20px">
      <h2 style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--text-primary)">Add a domain</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Enter the domain your team uses for email (e.g., <code>acme.com</code>).</p>
      <div class="add-form">
        <input type="text" id="domainInput" placeholder="acme.com" autocomplete="off" />
        <button class="btn-create-invite" onclick="addDomain()">Add</button>
      </div>
      <div id="domainStatus"></div>
    </div>

    <script>
      const ORG_ID = ${JSON.stringify(orgId)};

      function setStatus(msg, kind) {
        const el = document.getElementById('domainStatus');
        el.textContent = msg;
        el.className = kind === 'error' ? 'status-error' : kind === 'ok' ? 'status-ok' : '';
      }

      async function addDomain() {
        const input = document.getElementById('domainInput');
        const domain = input.value.trim();
        if (!domain) return;
        setStatus('Adding…', '');
        const res = await fetch('/api/orgs/' + ORG_ID + '/domains', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        if (res.ok) { location.reload(); return; }
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        setStatus(err.error || 'Failed to add domain', 'error');
      }

      async function verifyDomain(id) {
        setStatus('Checking DNS…', '');
        const res = await fetch('/api/orgs/' + ORG_ID + '/domains/' + id + '/verify', { method: 'POST' });
        if (res.ok) { setStatus('Verified!', 'ok'); setTimeout(() => location.reload(), 500); return; }
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        setStatus(err.error || 'Verification failed', 'error');
      }

      async function deleteDomain(id) {
        if (!confirm('Remove this domain claim?')) return;
        const res = await fetch('/api/orgs/' + ORG_ID + '/domains/' + id, { method: 'DELETE' });
        if (res.ok) { location.reload(); return; }
        setStatus('Remove failed', 'error');
      }
    </script>
  `;
}
