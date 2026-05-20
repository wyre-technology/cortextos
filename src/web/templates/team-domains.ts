import type { SeatBilling } from '../../billing/seat-billing.js';
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
  /** Seat-billing view object — drives the auto-join seat-cost note. */
  seatBilling: SeatBilling;
}

export const TEAM_DOMAINS_STYLES = `
  .domain-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border); }
  .domain-row:last-child { border-bottom:none; }
  .domain-name { font-weight:600; font-size:14px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600; margin-left:8px; }
  .badge-verified { background:#dcfce7; color:#166534; }
  .badge-pending { background:#fef3c7; color:#92400e; }
  .dns-block { font-family: ui-monospace, monospace; background:var(--bg-muted,#f4f4f5); padding:8px 12px; border-radius:6px; font-size:12px; margin-top:6px; word-break:break-all; }
  .dns-help { font-size:12px; color:var(--text-muted); margin-top:4px; }
  .domain-actions button { margin-left:6px; }
  .add-form { display:flex; gap:8px; margin-top:16px; }
  .add-form input { flex:1; padding:8px 12px; border:1px solid var(--border); border-radius:6px; }
  #domainStatus { font-size:13px; margin-top:8px; min-height:18px; }
  .status-error { color:#b91c1c; }
  .status-ok { color:#166534; }
`;

export function renderTeamDomains(data: TeamDomainsData): string {
  const { orgId, domains, seatBilling } = data;
  const perSeat = formatUsd(seatBilling.perSeatPriceCents);

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
