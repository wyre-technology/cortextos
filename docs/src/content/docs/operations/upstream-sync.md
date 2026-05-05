---
title: Upstream Sync
description: How Conduit periodically pulls changes from the upstream mcp-gateway product repo.
---

:::caution[Being retired]
The upstream sync workflow is going away with the mcp-gateway → Conduit
consolidation. See
[`docs/operations/mcp-gateway-cutover-runbook.md`](https://github.com/wyre-technology/conduit/blob/main/docs/operations/mcp-gateway-cutover-runbook.md).
Until production cutover, the sync still works for cherry-picking emergency
fixes from upstream.
:::

:::note[Authoritative source]
The full runbook lives at [`docs/operations/upstream-sync.md`](https://github.com/wyre-technology/conduit/blob/main/docs/operations/upstream-sync.md)
in this repo.
:::

Conduit was historically a downstream fork of the `mcp-gateway` product repo
(`git@github.com:wyre-technology/mcp-gateway.git`). The two are being
consolidated; this page documents the legacy sync flow that remains
operational until that consolidation completes.

See the runbook link above for:

- Remotes configuration (`origin`, `upstream`).
- Sync branch workflow.
- Conflict-resolution conventions.
- Post-merge verification checklist.
