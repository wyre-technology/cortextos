import type { Organization } from '../../org/org-service.js';
import { escapeHtml } from '../helpers.js';

/**
 * Track C reseller-settings shell — General tab (/org/reseller/general).
 *
 * Sibling-shape to reseller-branding.ts (Track C Surface 5). Replaces the
 * resellerSettingsStub at the same URL with the actual form surface.
 *
 * v1 scope (per boss dispatch msg-1781452776703 + scope-report sign-off):
 *   - Org name rename (form POST -> PATCH /api/orgs/:id existing endpoint)
 *   - Slug field shown READ-ONLY, derived from org.name. Custom-slug edit
 *     is an Aaron-decision-class slice (downstream link-rot implications)
 *     and lands as a separate slice if/when prioritized.
 *
 * Mock-data-first principle is preserved — no data sources are mocked
 * here because the only field that surfaces is org.name (already on the
 * Organization read model). Form posts directly to the existing PATCH
 * /api/orgs/:orgId handler (org/routes.ts:179).
 */

export interface ResellerGeneralData {
  org: Organization;
  /** Optional flash message rendered above the form (success or error). */
  flashOk?: string;
  flashErr?: string;
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function renderResellerGeneral(data: ResellerGeneralData): string {
  const { org, flashOk, flashErr } = data;
  const slug = deriveSlug(org.name);

  const flash = flashOk
    ? `<div class="rg-flash rg-flash-ok">${escapeHtml(flashOk)}</div>`
    : flashErr
      ? `<div class="rg-flash rg-flash-err">${escapeHtml(flashErr)}</div>`
      : '';

  return `
    <h1 style="margin:0 0 4px">General</h1>
    <p class="section-desc">
      Workspace-wide settings for ${escapeHtml(org.name)}.
    </p>

    ${flash}

    <form id="rgForm" class="rg-form">
      <label class="rg-field">
        <span class="rg-label">Organization name</span>
        <input id="rgName" class="rg-input" name="name" type="text"
               value="${escapeHtml(org.name)}" required minlength="1" maxlength="100" />
        <span class="rg-hint">Shown to your customers in the dashboard, sign-in screens, and email From-names.</span>
      </label>

      <label class="rg-field">
        <span class="rg-label">URL slug</span>
        <input id="rgSlug" class="rg-input rg-input-readonly" type="text"
               value="${escapeHtml(slug)}" readonly aria-readonly="true" />
        <span class="rg-hint">
          Auto-derived from the organization name. Used in your default white-label URL.
          Custom slugs aren't supported yet — changing the slug after customers connect would
          break their saved MCP endpoints, so we lock it behind a separate request flow.
        </span>
      </label>

      <div class="rg-actions">
        <button id="rgSave" type="submit" class="rg-save">Save changes</button>
      </div>
    </form>

    <script>
      (function () {
        var form = document.getElementById('rgForm');
        var nameInput = document.getElementById('rgName');
        var slugInput = document.getElementById('rgSlug');
        var saveBtn = document.getElementById('rgSave');
        var orgId = ${JSON.stringify(org.id)};

        function slugify(name) {
          return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        }

        nameInput.addEventListener('input', function () {
          slugInput.value = slugify(nameInput.value);
        });

        form.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          var newName = (nameInput.value || '').trim();
          try {
            var res = await fetch('/api/orgs/' + encodeURIComponent(orgId), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName }),
            });
            if (res.ok) {
              window.location.assign('/org/reseller/general?flash_ok=' + encodeURIComponent('Organization name updated.'));
            } else {
              var body = {};
              try { body = await res.json(); } catch (_) {}
              var msg = body && body.error ? body.error : ('Save failed (' + res.status + ').');
              window.location.assign('/org/reseller/general?flash_err=' + encodeURIComponent(msg));
            }
          } catch (err) {
            window.location.assign('/org/reseller/general?flash_err=' + encodeURIComponent('Network error — please retry.'));
          }
        });
      })();
    </script>
  `;
}

export const RESELLER_GENERAL_STYLES = `
  .rg-form {
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 480px;
    margin-top: 24px;
  }

  .rg-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rg-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .rg-input {
    padding: 8px 10px;
    background: var(--bg-body);
    color: var(--text-primary);
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  .rg-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .rg-input-readonly {
    background: var(--bg-card);
    color: var(--text-muted);
    cursor: not-allowed;
  }

  .rg-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .rg-flash {
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    margin: 16px 0 0;
  }

  .rg-flash-ok {
    background: rgba(64, 192, 132, 0.12);
    border: 1px solid rgba(64, 192, 132, 0.5);
    color: var(--text-primary);
  }

  .rg-flash-err {
    background: rgba(217, 50, 50, 0.12);
    border: 1px solid rgba(217, 50, 50, 0.5);
    color: var(--text-primary);
  }

  .rg-actions { margin-top: 4px; }

  .rg-save {
    padding: 9px 18px;
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }

  .rg-save:disabled {
    background: var(--border-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
  }
`;
