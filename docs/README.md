# Conduit Docs

The Conduit documentation site, built with [Astro Starlight](https://starlight.astro.build/).

## Prerequisites

- Node.js 20 or newer
- npm (the Conduit monorepo uses npm — see root `package-lock.json`)

## Local development

```bash
cd docs
npm install
npm run dev
```

Starlight will print a local URL (defaults to http://localhost:4321).

## Production build

```bash
cd docs
npm install
npm run build
npm run preview  # optional — serves the built site locally
```

Built output goes to `docs/dist/`.

## Content layout

- `src/content/docs/` — page content (MDX / Markdown). Each file becomes a route.
- `src/content/config.ts` — Starlight collection schema.
- `astro.config.mjs` — site config, branding, and sidebar IA.
- `src/assets/` — logo and other static assets.

## Information architecture

Top-level sidebar groups (see `astro.config.mjs`):

- **Getting Started** — overview and zero-to-tenant walkthrough.
- **Guides** — task-oriented: MSP onboarding, adding customers, vendor connections.
- **Reference** — API and permissions reference.
- **Operations** — runbooks (upstream sync, etc.).

## Terminology

Per the documentation PRD style guide:

- **MSP** — the tenant that resells Conduit.
- **Customer** — an end-customer under an MSP.

Avoid "organization" / "org" / "team" as the primary tenant noun in new content.
