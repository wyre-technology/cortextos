import type { SeatBilling } from '../../billing/seat-billing.js';
import { escapeHtml } from '../helpers.js';
import { formatUsd } from './seat-billing-copy.js';

export interface TeamInvitationsData {
  orgId: string;
  baseUrl: string;
  /** Seat-billing view object — drives the per-seat cost note. */
  seatBilling: SeatBilling;
  // Post-015 contract: existing invitations don't carry the plaintext token.
  // The list shows status; the copyable URL is shown exactly once at create
  // time (in the create modal, from the POST response). Re-sharing requires
  // revoke + create-new.
  invitations: {
    id: string;
    expiresAt: string;
    maxUses: number | null;
    useCount: number;
    createdAt: string;
  }[];
}

function formatUsage(useCount: number, maxUses: number | null): string {
  if (maxUses === null) return `${useCount}/&#8734; used`;
  return `${useCount}/${maxUses} used`;
}

export function renderTeamInvitations(data: TeamInvitationsData): string {
  const { orgId, baseUrl, invitations, seatBilling } = data;
  const perSeat = formatUsd(seatBilling.perSeatPriceCents);

  const invitationRows = invitations.length > 0
    ? invitations
        .map((inv) => {
          const expires = new Date(inv.expiresAt).toLocaleDateString();
          const usage = formatUsage(inv.useCount, inv.maxUses);
          return `
        <tr>
          <td class="invite-id" title="Invite ${escapeHtml(inv.id)}">${escapeHtml(inv.id)}</td>
          <td>${usage}</td>
          <td>${expires}</td>
          <td>
            <button class="btn-disconnect" onclick="revokeInvite('${escapeHtml(inv.id)}')">Revoke</button>
          </td>
        </tr>`;
        })
        .join('')
    : `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:16px;">No pending invitations</td></tr>`;

  return `
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <h1 style="margin-bottom:4px">Invitations</h1>
        <p class="section-desc">Share an invite link with your colleagues.
          Each colleague who joins takes a ${escapeHtml(perSeat)}/mo member seat.</p>
      </div>
      <button class="btn-create-invite" onclick="showCreateModal()">Create Invite Link</button>
    </div>
    <div class="org-section" style="padding:0;overflow:hidden;margin-top:16px">
      <table>
        <thead><tr><th>Invite ID</th><th>Usage</th><th>Expires</th><th></th></tr></thead>
        <tbody>${invitationRows}</tbody>
      </table>
    </div>
    <p class="section-desc" style="margin-top:8px;font-size:12px">
      Invite links are shown only at creation time and copied to your clipboard.
      To re-share an invite, revoke this one and create a new link.
    </p>

    <div class="modal-overlay" id="createModal" style="display:none">
      <div class="modal-card">
        <h2 style="font-size:16px;margin-bottom:16px">Create Invite Link</h2>
        <label class="modal-label">Max uses</label>
        <select id="maxUsesSelect" class="modal-select">
          <option value="1" selected>Single use</option>
          <option value="5">5 uses</option>
          <option value="10">10 uses</option>
          <option value="unlimited">Unlimited</option>
        </select>
        <label class="modal-label" style="margin-top:12px">Expiration</label>
        <select id="expiresSelect" class="modal-select">
          <option value="24">24 hours</option>
          <option value="72">3 days</option>
          <option value="168" selected>7 days</option>
          <option value="336">14 days</option>
          <option value="720">30 days</option>
        </select>
        <div style="display:flex;gap:8px;margin-top:20px;justify-content:flex-end">
          <button class="btn-cancel" onclick="hideCreateModal()">Cancel</button>
          <button class="btn-create-invite" onclick="createInvite()">Create</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
      const orgId = '${escapeHtml(orgId)}';
      const baseUrl = '${escapeHtml(baseUrl)}';

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      }

      function showCreateModal() {
        document.getElementById('createModal').style.display = 'flex';
      }

      function hideCreateModal() {
        document.getElementById('createModal').style.display = 'none';
      }

      async function createInvite() {
        const maxUsesVal = document.getElementById('maxUsesSelect').value;
        const expiresInHours = parseInt(document.getElementById('expiresSelect').value, 10);
        const maxUses = maxUsesVal === 'unlimited' ? null : parseInt(maxUsesVal, 10);

        const res = await fetch('/api/orgs/' + orgId + '/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxUses, expiresInHours }),
        });
        if (res.ok) {
          const data = await res.json();
          const url = baseUrl + '/invite/' + data.token;
          await navigator.clipboard.writeText(url).catch(() => {});
          showToast('Invite link copied to clipboard');
          setTimeout(() => window.location.reload(), 500);
        } else {
          const data = await res.json().catch(() => ({}));
          alert('Failed to create invite: ' + (data.error || 'Unknown error'));
        }
        hideCreateModal();
      }

      async function revokeInvite(inviteId) {
        if (!confirm('Revoke this invite link?')) return;
        const res = await fetch('/api/orgs/' + orgId + '/invitations/' + inviteId, { method: 'DELETE' });
        if (res.ok) window.location.reload();
        else alert('Failed to revoke invitation');
      }
    </script>`;
}

export const TEAM_INVITATIONS_STYLES = `
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 10px 12px;
    font-size: 13px;
    border-bottom: 1px solid var(--border-subtle);
  }
  th { color: var(--text-tertiary); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { color: var(--text-label); }
  .btn-copy {
    font-size: 12px; font-weight: 500; font-family: inherit;
    background: transparent; color: var(--accent-light);
    border: 1px solid var(--border-primary); border-radius: 6px;
    padding: 4px 10px; cursor: pointer; transition: border-color 0.15s;
  }
  .btn-copy:hover { border-color: var(--accent-light); }
  .btn-create-invite {
    display: inline-flex; align-items: center;
    padding: 8px 16px; background: var(--accent); color: #fff;
    font-size: 13px; font-weight: 600; font-family: inherit;
    border: none; border-radius: 6px; cursor: pointer; white-space: nowrap;
  }
  .btn-create-invite:hover { background: var(--accent-hover); }
  .btn-cancel {
    padding: 8px 16px; background: transparent; color: var(--text-secondary);
    font-size: 13px; font-weight: 500; font-family: inherit;
    border: 1px solid var(--border-primary); border-radius: 6px; cursor: pointer;
  }
  .btn-cancel:hover { border-color: var(--text-muted); }
  .invite-url {
    max-width: 300px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6); display: flex;
    align-items: center; justify-content: center; z-index: 100;
  }
  .modal-card {
    background: var(--bg-card); border: 1px solid var(--border-secondary); border-radius: 8px;
    padding: 24px; min-width: 340px;
  }
  .modal-label {
    display: block; font-size: 12px; font-weight: 500; color: var(--text-tertiary);
    text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;
  }
  .modal-select {
    width: 100%; padding: 8px 10px; background: var(--bg-body); color: var(--text-primary);
    border: 1px solid var(--border-primary); border-radius: 6px; font-size: 13px; font-family: inherit;
  }
`;
