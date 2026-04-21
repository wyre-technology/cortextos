---
title: Upstream Sync
description: How Conduit periodically pulls changes from the upstream mcp-gateway product repo.
---

:::note[Authoritative source]
The full runbook lives at [`docs/operations/upstream-sync.md`](https://github.com/wyre-technology/wyre-mcp-gateway-platform/blob/main/docs/operations/upstream-sync.md)
in this repo. A future docs task will migrate the content into this page
directly (with proper Starlight frontmatter) so the site becomes the single
source of truth.
:::

Conduit is currently a downstream fork of the `mcp-gateway` product repo
(`git@github.com:wyre-technology/mcp-gateway.git`). Until the eventual
merge-back, we periodically pull upstream changes into Conduit so that
security fixes, vendor integrations, and core engine improvements land here
without divergence spiraling out of control.

See the runbook link above for:

- Remotes configuration (`origin`, `upstream`).
- Sync branch workflow.
- Conflict-resolution conventions.
- Post-merge verification checklist.
