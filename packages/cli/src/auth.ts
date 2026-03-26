/**
 * Authentication commands for the mcpgw CLI.
 *
 * `mcpgw auth login` opens a browser to the gateway's OAuth flow,
 * starts a temporary localhost server to receive the callback,
 * and stores the resulting token.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getGatewayUrl, saveToken, loadToken, clearToken } from './config.js';

/**
 * Open a URL in the default browser (cross-platform).
 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
    'xdg-open';
  exec(`${cmd} "${url}"`);
}

/**
 * Run the login flow: open browser → receive callback → save token.
 */
export async function login(): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const state = randomBytes(16).toString('hex');
  const port = 9876; // Fixed port for localhost callback

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`Auth error: ${error}`));
        return;
      }

      if (returnedState !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Invalid callback</h2><p>State mismatch or missing code.</p>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      // Exchange authorization code for tokens
      try {
        const tokenRes = await fetch(`${gatewayUrl}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: `http://localhost:${port}/callback`,
            client_id: 'mcpgw-cli',
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          throw new Error(`Token exchange failed: ${errBody}`);
        }

        const tokens = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };

        saveToken({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000
            : undefined,
          gatewayUrl,
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authenticated!</h2><p>You can close this tab and return to the terminal.</p>');
        console.log('Login successful. Token saved to ~/.config/mcpgw/token.json');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token exchange failed</h2><p>${err}</p>`);
        reject(err);
      } finally {
        server.close();
        resolve();
      }
    });

    server.listen(port, () => {
      const authorizeUrl = `${gatewayUrl}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: 'mcpgw-cli',
        redirect_uri: `http://localhost:${port}/callback`,
        state,
        scope: 'mcp',
      });

      console.log(`Opening browser to authenticate...`);
      console.log(`If the browser doesn't open, visit: ${authorizeUrl}`);
      openBrowser(authorizeUrl);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 2 minutes'));
    }, 120_000);
  });
}

/**
 * Show current auth status.
 */
export function status(): void {
  const token = loadToken();
  if (!token) {
    console.log('Not authenticated. Run: mcpgw auth login');
    return;
  }

  console.log(`Gateway: ${token.gatewayUrl}`);
  if (token.expiresAt) {
    const remaining = token.expiresAt - Date.now();
    if (remaining <= 0) {
      console.log('Token: expired');
    } else {
      const minutes = Math.round(remaining / 60_000);
      console.log(`Token: valid (expires in ${minutes}m)`);
    }
  } else {
    console.log('Token: present (no expiry info)');
  }
}

/**
 * Clear stored credentials.
 */
export function logout(): void {
  clearToken();
  console.log('Logged out. Token cleared.');
}
