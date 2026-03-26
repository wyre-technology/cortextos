import { escapeHtml } from '../helpers.js';

export interface ProfileSettingsData {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string;
  name: string | null;
}

export const PROFILE_SETTINGS_STYLES = `
  .profile-form {
    max-width: 480px;
  }
  .form-group {
    margin-bottom: 20px;
  }
  .form-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  .form-group input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  .form-group input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .form-group input[readonly] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .form-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .btn-save {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 20px;
    border: none;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-save:hover {
    background: var(--accent-hover);
  }
  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    z-index: 100;
  }
  .toast.show {
    opacity: 1;
    transform: translateY(0);
  }
  .toast.error {
    border-color: #dc2626;
    color: #fca5a5;
  }
`;

export function renderProfileSettings(data: ProfileSettingsData): string {
  const firstName = data.firstName ? escapeHtml(data.firstName) : '';
  const lastName = data.lastName ? escapeHtml(data.lastName) : '';
  const displayName = data.displayName ? escapeHtml(data.displayName) : '';
  const email = escapeHtml(data.email);

  // Compute the default display name placeholder
  const defaultDisplay = [data.firstName, data.lastName].filter(Boolean).join(' ') || data.name || '';
  const placeholder = defaultDisplay ? escapeHtml(defaultDisplay) : 'Optional override';

  return `
    <h1 style="margin-bottom:4px">Profile</h1>
    <p style="color:#737373;font-size:14px;margin-bottom:24px">Manage your personal profile information.</p>

    <form id="profile-form" class="profile-form">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" value="${email}" readonly />
        <div class="form-hint">Email is managed by your login provider and cannot be changed here.</div>
      </div>

      <div class="form-group">
        <label for="firstName">First Name</label>
        <input type="text" id="firstName" name="firstName" value="${firstName}" placeholder="First name" />
      </div>

      <div class="form-group">
        <label for="lastName">Last Name</label>
        <input type="text" id="lastName" name="lastName" value="${lastName}" placeholder="Last name" />
      </div>

      <div class="form-group">
        <label for="displayName">Display Name</label>
        <input type="text" id="displayName" name="displayName" value="${displayName}" placeholder="${placeholder}" />
        <div class="form-hint">If blank, your first and last name will be used.</div>
      </div>

      <button type="submit" class="btn-save" id="saveBtn">Save</button>
    </form>

    <div class="toast" id="toast"></div>

    <script>
      function showToast(msg, isError) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.className = 'toast show' + (isError ? ' error' : '');
        setTimeout(function() { t.className = 'toast'; }, 2500);
      }

      document.getElementById('profile-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = document.getElementById('saveBtn');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
          var res = await fetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              firstName: document.getElementById('firstName').value,
              lastName: document.getElementById('lastName').value,
              displayName: document.getElementById('displayName').value,
            }),
          });

          if (res.ok) {
            showToast('Profile updated', false);
          } else {
            var data = await res.json().catch(function() { return {}; });
            showToast('Failed: ' + (data.error || 'Unknown error'), true);
          }
        } catch (err) {
          showToast('Network error', true);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Save';
        }
      });
    </script>`;
}
