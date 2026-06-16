import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Regression guard for the conduit docs trailing-slash redirect (src/index.ts).
 *
 * The gateway serves the bundled Astro/Starlight docs from public/ via
 * @fastify/static (root=public, prefix=/, wildcard:false, redirect:true).
 * The `redirect:true` is load-bearing: without it, `/docs` (the no-slash
 * entry URL a customer types) 404s while `/docs/` serves 200 — docs live but
 * apparently broken. This test pins the redirect-class fix AND the invariant
 * that file requests are NOT redirected (assets must serve directly).
 *
 * Mirrors the exact options the gateway uses, against a temp public/docs/
 * fixture, so it does not need a full gateway boot.
 */
describe('static docs trailing-slash redirect', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'conduit-docs-'));
    mkdirSync(path.join(root, 'docs', '_astro'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'getting-started'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'index.html'), '<!doctype html><title>Conduit Docs</title>');
    writeFileSync(path.join(root, 'docs', 'getting-started', 'index.html'), '<!doctype html><title>Getting Started</title>');
    writeFileSync(path.join(root, 'docs', '_astro', 'index.css'), 'body{}');
    writeFileSync(path.join(root, 'docs', 'sitemap-index.xml'), '<?xml version="1.0"?><sitemapindex/>');

    // Mirror the gateway's prod config exactly: wildcard:true (a single `/*`
    // catch-all that serves the whole nested tree — WYREAI-107; wildcard:false
    // didn't serve nested public/docs/** in prod) + redirect:true for the
    // directory trailing-slash UX.
    app = Fastify();
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      wildcard: true,
      decorateReply: false,
      redirect: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('301-redirects /docs (directory, no trailing slash) to /docs/', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/docs/');
  });

  it('301-redirects a nested page /docs/getting-started to /docs/getting-started/', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/getting-started' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/docs/getting-started/');
  });

  it('serves the directory index at /docs/ (200, not a redirect)', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Conduit Docs');
  });

  it('serves a FILE asset directly — never redirected (the asset-edge-case invariant)', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/_astro/index.css' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('body{}');
  });

  // WYREAI-107: the prod symptom was nested public/docs/** files (sitemap-*.xml,
  // /docs/_astro/*, subpages) 404ing under wildcard:false while only /docs/
  // served. wildcard:true must serve a nested non-HTML file like the sitemap.
  it('serves a nested non-HTML file (sitemap) directly — WYREAI-107 regression', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/sitemap-index.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<sitemapindex');
  });
});
