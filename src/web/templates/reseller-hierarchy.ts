import type { Organization } from '../../org/org-service.js';
import { getPlan } from '../../billing/plan-catalog.js';
import { escapeHtml } from '../helpers.js';

// Track C Surface 4 — Reseller Tenant Hierarchy (/org/hierarchy).
// Figma design-of-record: tbaRrzQQqZTNZu2AelcIID node 9:2.
//
// The org tree below a reseller. The data model caps the hierarchy at
// depth 2 (reseller → customer; enforced by the org-hierarchy DB trigger),
// so the real tree is the caller's reseller plus its direct customer orgs —
// `buildResellerTree` builds it from `OrgService.getResellerHierarchy`.
//
// Axis note: the Figma static frame draws a horizontal org-chart. This
// template renders the same tree on a vertical indented axis with an
// expand/collapse disclosure — faithful to the design's *interaction*
// spec (design note #4: "Expansion control on customer cards … Click
// expands. Default-collapsed for terse view") and to the open question
// of arbitrary depth (note #5), which a vertical tree absorbs without
// the brittle connector math of a horizontal chart.

export type TenantNodeKind = 'reseller' | 'customer' | 'subtenant';

export interface TenantNode {
  id: string;
  name: string;
  kind: TenantNodeKind;
  /** Meta line, e.g. "4 customers · 8 users · BUSINESS" or "5 users". */
  meta: string;
  children: TenantNode[];
}

export interface ResellerHierarchyData {
  org: Organization;
  root: TenantNode;
}

/** Human plan label for the meta line, e.g. 'conduit' → "Conduit". */
function planLabel(slug: string): string {
  return getPlan(slug)?.name ?? slug;
}

function usersLabel(n: number): string {
  return `${n} ${n === 1 ? 'user' : 'users'}`;
}

/**
 * Build the real reseller tenant tree from {@link OrgService.getResellerHierarchy}
 * data: root = the caller's reseller, children = its direct customer orgs (the
 * depth-2 cap means there is no subtenant level). Pure + presentation-only —
 * the tenant scoping lives in the query, not here. Replaces the former mock
 * tree; an empty `customers` list yields a reseller node with no children
 * (the template renders the "no customers yet" empty state).
 */
export function buildResellerTree(
  reseller: Organization,
  resellerUserCount: number,
  customers: Array<{ org: Organization; userCount: number }>,
): TenantNode {
  return {
    id: reseller.id,
    name: reseller.name,
    kind: 'reseller',
    meta: `${customers.length} ${customers.length === 1 ? 'customer' : 'customers'} · ${usersLabel(resellerUserCount)} · ${planLabel(reseller.plan)}`,
    children: customers.map(({ org, userCount }) => ({
      id: org.id,
      name: org.name,
      kind: 'customer' as const,
      meta: `${usersLabel(userCount)} · ${planLabel(org.plan)}`,
      children: [],
    })),
  };
}

const KIND_LABEL: Record<TenantNodeKind, string> = {
  reseller: 'RESELLER',
  customer: 'CUSTOMER',
  subtenant: 'SUBTENANT',
};

// A real org-hierarchy graph could be deep or — through a data bug —
// cyclic. Both recursion walkers below carry a hard depth cap and a
// visited-id set so a malformed tree degrades gracefully instead of
// overflowing the stack and crashing the response handler.
export const MAX_TREE_DEPTH = 20;

/** Total nodes under (and including) a node — for the header summary. */
function countNodes(node: TenantNode, depth = 0, visited = new Set<string>()): number {
  if (depth > MAX_TREE_DEPTH || visited.has(node.id)) return 0;
  visited.add(node.id);
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c, depth + 1, visited), 0);
}

/**
 * Renders one tree node and its subtree. Customer nodes that have
 * children collapse by default (terse view); the disclosure toggle
 * surfaces the immediate child count, matching the Figma's "▾ 2" /
 * "▾ 3" affordance.
 *
 * `visited` guards against cyclic data; `depth` is hard-capped so a
 * pathologically deep tree cannot overflow the stack.
 */
function renderNode(node: TenantNode, depth: number, visited: Set<string>): string {
  if (depth > MAX_TREE_DEPTH || visited.has(node.id)) return '';
  visited.add(node.id);

  const hasChildren = node.children.length > 0;
  const collapsed = node.kind === 'customer' && hasChildren;
  const kindClass = `rh-kind-${node.kind}`;

  const toggle = hasChildren
    ? `<button type="button" class="rh-toggle" tabindex="-1"
         aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(node.name)}"
         onclick="rhToggle(this)">
         <span class="rh-caret">&#9662;</span> ${node.children.length}
       </button>`
    : '';

  const childList = hasChildren
    ? `<div class="rh-children" role="group" ${collapsed ? 'hidden' : ''}>
         ${node.children.map((c) => renderNode(c, depth + 1, visited)).join('')}
       </div>`
    : '';

  // aria-expanded lives on the treeitem (the focusable .rh-card); the
  // toggle button is a decorative tabindex=-1 control inside it.
  const expandedAttr = hasChildren ? ` aria-expanded="${collapsed ? 'false' : 'true'}"` : '';

  return `
    <div class="rh-node rh-depth-${Math.min(depth, 3)}">
      <div class="rh-card ${kindClass}" role="treeitem"${expandedAttr}
        data-kind="${escapeHtml(node.kind)}" tabindex="0">
        <div class="rh-card-head">
          <span class="rh-badge ${kindClass}">${escapeHtml(KIND_LABEL[node.kind])}</span>
          ${toggle}
        </div>
        <div class="rh-name">${escapeHtml(node.name)}</div>
        <div class="rh-meta">${escapeHtml(node.meta)}</div>
      </div>
      ${childList}
    </div>`;
}

export function renderResellerHierarchy(data: ResellerHierarchyData): string {
  const { org, root } = data;
  const orgName = escapeHtml(org.name);
  const total = countNodes(root) - 1; // exclude the reseller root itself

  return `
    <div class="rh-header">
      <h1 style="margin-bottom:4px">Tenant Hierarchy</h1>
      <p class="section-desc">
        Visualize the org tree below ${orgName} · ${total} tenant${total === 1 ? '' : 's'}.
        Customer rows collapse by default — expand to see subtenants.
      </p>
    </div>

    <div class="rh-toolbar" role="tablist" aria-label="Hierarchy view">
      <button type="button" class="rh-view rh-view-active" role="tab" aria-selected="true">Tree</button>
      <button type="button" class="rh-view" role="tab" aria-selected="false" disabled
        title="Table view lands in a follow-up">Table</button>
    </div>

    <div class="rh-tree" role="tree" aria-label="Tenant hierarchy">
      ${renderNode(root, 0, new Set<string>())}
    </div>
    ${root.children.length === 0
      ? '<p class="rh-empty">No customers under this reseller yet.</p>'
      : ''}

    <p class="ia-shell-note">
      This hierarchy renders mock data until the Track A org-hierarchy
      endpoint lands. Per-node navigation, the table view, and arbitrary
      tree depth route through follow-up work; v1 ships the bounded
      reseller → customer → subtenant tree.
    </p>
  `;
}

export const RESELLER_HIERARCHY_SCRIPT = `
<script>
  function rhToggle(btn) {
    var node = btn.closest('.rh-node');
    if (!node) return;
    var children = node.querySelector(':scope > .rh-children');
    var card = node.querySelector(':scope > .rh-card');
    if (!children) return;
    var expanded = children.hasAttribute('hidden');
    if (expanded) { children.removeAttribute('hidden'); }
    else { children.setAttribute('hidden', ''); }
    // aria-expanded is owned by the treeitem (.rh-card); the button's
    // label flips between Expand/Collapse so it never goes stale.
    if (card) card.setAttribute('aria-expanded', String(expanded));
    var label = btn.getAttribute('aria-label') || '';
    var name = label.replace(/^(Expand|Collapse)\\s+/, '');
    btn.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + name);
  }
</script>
`;

export const RESELLER_HIERARCHY_STYLES = `
  .rh-header { margin-bottom: 16px; }

  .rh-toolbar {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
  }
  .rh-view {
    padding: 7px 18px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .rh-view-active {
    border-color: var(--accent);
    color: var(--accent-text);
    background: rgba(0, 201, 219, 0.08);
  }
  .rh-view:disabled { color: var(--text-muted); cursor: not-allowed; }

  .rh-tree { margin-bottom: 24px; }

  /* Each nested level indents and grows a connector rail on its left. */
  .rh-children {
    margin-left: 18px;
    padding-left: 18px;
    border-left: 1px solid var(--border-secondary);
  }
  .rh-node { margin-top: 10px; }
  .rh-node:first-child { margin-top: 0; }

  .rh-card {
    position: relative;
    max-width: 360px;
    padding: 12px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }
  /* Connector stub from the rail to each card. */
  .rh-children > .rh-node > .rh-card::before {
    content: '';
    position: absolute;
    left: -19px;
    top: 26px;
    width: 18px;
    height: 1px;
    background: var(--border-secondary);
  }
  .rh-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The reseller root reads as the anchor of the tree. */
  .rh-card.rh-kind-reseller {
    border-color: var(--accent);
    background: rgba(0, 201, 219, 0.06);
  }

  .rh-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .rh-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--border-subtle);
    color: var(--text-tertiary);
  }
  .rh-badge.rh-kind-reseller {
    background: rgba(0, 201, 219, 0.08);
    border: 1px solid var(--accent);
    color: var(--accent-text);
  }

  .rh-name {
    margin-top: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  .rh-meta {
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-tertiary);
    overflow-wrap: anywhere;
  }

  .rh-empty {
    margin-bottom: 24px;
    padding: 16px;
    background: var(--bg-card);
    border: 1px dashed var(--border-secondary);
    border-radius: 10px;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .rh-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: transparent;
    border: 1px solid var(--border-secondary);
    border-radius: 10px;
    color: var(--accent-text);
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
  }
  .rh-caret {
    display: inline-block;
    font-size: 9px;
    transition: transform 0.12s;
  }
  .rh-toggle[aria-expanded="false"] .rh-caret { transform: rotate(-90deg); }

  @media (max-width: 600px) {
    .rh-children { margin-left: 10px; padding-left: 12px; }
    .rh-card { max-width: none; }
  }
`;
