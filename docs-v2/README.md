# conduit docs-v2 — Path B migration (parallel-build)

This directory is the **target** Astro+Tailwind+MDX site that will replace `docs/` (Starlight) per the docs-redesign Path B decision (2026-06-02).

## Why parallel?

Replacing the docs framework while live customers reference it is risky to do in-place. The parallel-build-then-cutover discipline:

1. **Now (Epics 1–9)**: `docs-v2/` is scaffolded and developed alongside `docs/`. Production keeps serving the Starlight build (`docs/dist/`). `docs-v2/` is built but not deployed.
2. **Epic 10 cutover**: rename `docs/` → `docs/archive-starlight-2026-06/`, rename `docs-v2/` → `docs/`, swap the deploy target, smoke-test, ship.

That way every interim merge is safe — no live URL ever points at a half-ported site.

## Source-of-design-truth

`wyre-technology/msp-claude-plugins/docs/` — the gateway docs site at `mcp.wyre.ai`. Brand colors, typography, component shapes, layout, and theme system mirror that codebase exactly. Visual parity check against `https://mcp.wyretechnology.com` is the acceptance bar for every component port.

## Scope of THIS PR (WYREAI-102 Epic 1)

- Astro+Tailwind+MDX scaffold (config, package.json, tsconfig, base styles).
- `Header.astro` + `Footer.astro` ported from the gateway with conduit-branded copy and nav.
- A minimal `index.astro` placeholder so `npm run dev` shows the chrome rendering.

**Out of scope** (later epics): content migration, sidebar nav with data-driven entries, search (Pagefind), API reference layout, MDX shortcodes, OG image generation, deploy wiring.

## Local dev

```bash
cd docs-v2
npm install
npm run dev
```

Then open `http://localhost:4321/docs/`.

## Cross-references

- **Tracker**: [WYREAI-101](https://linear.app/wyre-ai/issue/WYREAI-101/)
- **Epic 1**: [WYREAI-102](https://linear.app/wyre-ai/issue/WYREAI-102/)
- **Audit + redesign plan**: `wyre/agents/scribe/deliverables/conduit-docs-design-audit-and-redesign-plan-2026-06-01.md` (scribe deliverable)
- **Path B decision**: 2026-06-02 boss dispatch `1780409886298-boss-821hr`
