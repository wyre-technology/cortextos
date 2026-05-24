import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { brand } from '../brand/index.js';
import { config } from '../config.js';
import { sendWebhook } from '../monitoring/webhook.js';
import { getSql } from '../db/context.js';

/**
 * Waitlist routes — collects emails from interested users.
 * No authentication required. Rate-limited to prevent abuse.
 */
export function waitlistRoutes() {
  return async function plugin(app: FastifyInstance): Promise<void> {
    // Ensure table exists
    await getSql()`
      CREATE TABLE IF NOT EXISTS waitlist (
        id         TEXT PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        name       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // POST /waitlist — add email to waitlist
    app.post<{ Body: { email: string; name?: string } }>(
      '/waitlist',
      {
        config: {
          rateLimit: { max: 5, timeWindow: '1 hour' },
        },
      },
      async (request, reply) => {
        const { email, name } = request.body || {};

        if (!email || typeof email !== 'string') {
          return reply.code(400).send({ error: 'Email is required' });
        }

        const normalized = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
          return reply.code(400).send({ error: 'Invalid email address' });
        }

        try {
          await getSql()`
            INSERT INTO waitlist (id, email, name)
            VALUES (${nanoid()}, ${normalized}, ${name?.trim() || null})
            ON CONFLICT (email) DO NOTHING
          `;

          if (config.waitlistNotifyUrl) {
            const label = name?.trim() ? `${name.trim()} (${normalized})` : normalized;
            void sendWebhook(config.waitlistNotifyUrl, {
              content: `New waitlist signup: **${label}**`,
            }).catch(() => {});
          }
        } catch (err) {
          app.log.error(err, 'Waitlist insert failed');
          return reply.code(500).send({ error: 'Failed to join waitlist' });
        }

        return reply.code(201).send({ message: 'You\'re on the list! We\'ll be in touch.' });
      },
    );

    // GET /waitlist — public signup page
    app.get('/waitlist', async (_request, reply) => {
      const rows = await getSql()`SELECT COUNT(*)::int AS count FROM waitlist`;
      const count = rows[0].count as number;
      const countText = count > 0 ? `${count} ${count === 1 ? 'person has' : 'people have'} already joined.` : '';

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join the Waitlist - MCP Gateway - ${brand.name}</title>
  <meta name="description" content="Get early access to the MCP Gateway — a hosted proxy that connects any MCP-capable AI assistant to your MSP tools securely." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 48px 36px;
      width: 100%;
      max-width: 440px;
    }
    .brand {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #737373;
      margin-bottom: 28px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #f5f5f5;
      margin-bottom: 8px;
    }
    .subtitle {
      font-size: 15px;
      color: #a3a3a3;
      margin-bottom: 28px;
      line-height: 1.6;
    }
    .form-group { margin-bottom: 16px; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #a3a3a3;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 14px;
      background: #0a0a0a;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e5e5e5;
      font-size: 15px;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    input:focus {
      outline: none;
      border-color: #2563eb;
    }
    input::placeholder { color: #525252; }
    .btn-submit {
      display: block;
      width: 100%;
      padding: 12px;
      background: #2563eb;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.15s;
      margin-top: 8px;
    }
    .btn-submit:hover { background: #1d4ed8; }
    .btn-submit:disabled { background: #333; cursor: not-allowed; }
    .social-proof {
      font-size: 13px;
      color: #525252;
      text-align: center;
      margin-top: 16px;
    }
    .message {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-top: 16px;
      display: none;
    }
    .message.success {
      display: block;
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.2);
      color: #4ade80;
    }
    .message.error {
      display: block;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
    .features {
      margin-top: 28px;
      padding-top: 24px;
      border-top: 1px solid #222;
    }
    .features h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #525252;
      margin-bottom: 14px;
    }
    .feature-list {
      list-style: none;
    }
    .feature-list li {
      font-size: 14px;
      color: #a3a3a3;
      padding: 6px 0;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .feature-list li::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      background: #2563eb;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 6px;
    }
    .links {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin-top: 24px;
      font-size: 13px;
    }
    .links a {
      color: #525252;
      text-decoration: none;
      transition: color 0.15s;
    }
    .links a:hover { color: #a3a3a3; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">${brand.name}</div>
    <h1>Get Early Access</h1>
    <p class="subtitle">The MCP Gateway connects your AI assistant — Claude or any MCP-capable client — to your MSP tools: Autotask, Datto RMM, IT Glue, HaloPSA, and more. Sign up to be notified when we open access.</p>

    <form id="waitlistForm">
      <div class="form-group">
        <label for="email">Work email</label>
        <input type="email" id="email" name="email" placeholder="you@yourcompany.com" required />
      </div>
      <div class="form-group">
        <label for="name">Name <span style="color:#525252">(optional)</span></label>
        <input type="text" id="name" name="name" placeholder="Your name" />
      </div>
      <button type="submit" class="btn-submit" id="submitBtn">Join the Waitlist</button>
    </form>

    <div id="message" class="message"></div>
    ${countText ? `<p class="social-proof">${countText}</p>` : ''}

    <div class="features">
      <h2>What you get</h2>
      <ul class="feature-list">
        <li>Connect Claude Desktop, Claude Code, or any MCP-capable client to 50+ MSP platforms</li>
        <li>Encrypted credential storage — your API keys never leave the gateway</li>
        <li>Team sharing — one set of credentials for your whole team</li>
        <li>Audit logging for every MCP request</li>
      </ul>
    </div>

    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222;text-align:center">
      <p style="font-size:14px;color:#a3a3a3;margin-bottom:8px">Already have an invite code?</p>
      <a href="/auth/login" style="display:inline-block;padding:8px 20px;border:1px solid #333;border-radius:6px;color:#e5e5e5;text-decoration:none;font-size:14px;font-weight:500;transition:border-color 0.15s">Sign in to get started</a>
    </div>

    <div class="links">
      <a href="/">Documentation</a>
      <span style="color:#262626">|</span>
      <a href="${brand.issuesUrl}" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>

  <script>
    document.getElementById('waitlistForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const msg = document.getElementById('message');
      const email = document.getElementById('email').value;
      const name = document.getElementById('name').value;

      btn.disabled = true;
      btn.textContent = 'Joining...';
      msg.className = 'message';
      msg.style.display = 'none';

      try {
        const res = await fetch('/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, name: name || undefined }),
        });
        const data = await res.json();

        if (res.ok) {
          msg.className = 'message success';
          msg.textContent = data.message;
          btn.textContent = 'You\\'re on the list!';
          document.getElementById('waitlistForm').reset();
        } else {
          msg.className = 'message error';
          msg.textContent = data.error || 'Something went wrong. Please try again.';
          btn.disabled = false;
          btn.textContent = 'Join the Waitlist';
        }
      } catch {
        msg.className = 'message error';
        msg.textContent = 'Network error. Please try again.';
        btn.disabled = false;
        btn.textContent = 'Join the Waitlist';
      }
    });
  </script>
</body>
</html>`;

      return reply.type('text/html').send(html);
    });

    // GET /waitlist/count — public count for social proof (no auth needed)
    app.get('/waitlist/count', async (_request, reply) => {
      const rows = await getSql()`SELECT COUNT(*)::int AS count FROM waitlist`;
      return reply.send({ count: rows[0].count });
    });

    // GET /admin/waitlist — full list for internal use (admin API key required)
    app.get('/admin/waitlist', async (request, reply) => {
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!config.adminApiKey || token !== config.adminApiKey) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const rows = await getSql()<{ id: string; email: string; name: string | null; created_at: Date }[]>`
        SELECT id, email, name, created_at FROM waitlist ORDER BY created_at ASC
      `;
      return reply.send({ count: rows.length, signups: rows });
    });
  };
}
