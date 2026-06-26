import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { jwtVerify } from 'jose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/messages/stream/[agent] - SSE stream of new messages for an agent
 *
 * Watches the outbound-messages.jsonl file for new entries and streams them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent: string }> }
) {
  // Security: Authenticate SSE — prefer cookie over query string.
  //
  // Original H7 fix used `?token=<jwt>` because EventSource cannot set
  // request headers. The newer finding (MEDIUM, automated security-review)
  // escalates that: query-string JWTs land in browser history, Referer
  // headers, server access logs, and Cloudflare/CDN logs — broadening the
  // exfiltration surface vs. an httpOnly cookie. EventSource sends
  // same-origin cookies automatically, so the cookie path is strictly
  // better for SSE that runs against its own origin.
  //
  // Migration shape: accept the JWT from either source, prefer cookie,
  // emit a one-line warning when the query-string path is used so we can
  // observe the deprecation tail and drop the query support in a
  // follow-up. Cookie name `dashboard_sse_token` matches the convention
  // any future cookie-issuing endpoint would use (HttpOnly, SameSite=Strict).
  let token: string | null = null;
  let tokenSource: 'cookie' | 'query' = 'cookie';
  const cookieToken = request.cookies.get('dashboard_sse_token')?.value;
  if (cookieToken) {
    token = cookieToken;
    tokenSource = 'cookie';
  } else {
    token = new URL(request.url).searchParams.get('token');
    tokenSource = 'query';
  }
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!authSecret) {
    console.error('[messages/stream] AUTH_SECRET not set — refusing SSE connection');
    return new Response('Server misconfiguration', { status: 500 });
  }
  try {
    const secret = new TextEncoder().encode(authSecret);
    await jwtVerify(token, secret);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  if (tokenSource === 'query') {
    // Deprecation tracker — emit once per connection so log volume scales
    // with new connections, not heartbeats. Drop the query support once
    // this is empty for a release cycle.
    console.warn('[messages/stream] DEPRECATED: SSE auth via ?token= — migrate caller to httpOnly cookie `dashboard_sse_token`.');
  }
  // Auth passed — proceed with stream

  const { agent } = await params;

  if (!agent || !/^[a-z0-9_-]+$/.test(agent)) {
    return new Response('Invalid agent name', { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const outboundFile = path.join(ctxRoot, 'logs', agent, 'outbound-messages.jsonl');

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection comment
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Track file size to detect new lines
      let lastSize = 0;
      try {
        if (fs.existsSync(outboundFile)) {
          lastSize = fs.statSync(outboundFile).size;
        }
      } catch { /* ignore */ }

      // Poll for changes (fs.watch is unreliable on some systems)
      const pollInterval = setInterval(() => {
        if (request.signal.aborted) {
          clearInterval(pollInterval);
          return;
        }

        try {
          if (!fs.existsSync(outboundFile)) return;

          const stat = fs.statSync(outboundFile);
          if (stat.size <= lastSize) return;

          // Read new bytes
          const fd = fs.openSync(outboundFile, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);

          lastSize = stat.size;

          const newData = buf.toString('utf-8');
          const lines = newData.trim().split('\n');

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              const message = {
                id: entry.message_id || `out-${entry.timestamp}`,
                timestamp: entry.timestamp || entry.ts,
                agent,
                direction: 'outbound' as const,
                type: 'text',
                text: entry.text || '',
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(message)}\n\n`)
              );
            } catch {
              // Skip malformed
            }
          }
        } catch {
          // Ignore read errors
        }
      }, 1000);

      // 30s heartbeat
      const keepalive = setInterval(() => {
        if (request.signal.aborted) {
          clearInterval(keepalive);
          return;
        }
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 30_000);

      // Clean up
      request.signal.addEventListener('abort', () => {
        clearInterval(pollInterval);
        clearInterval(keepalive);
        try {
          controller.close();
        } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
