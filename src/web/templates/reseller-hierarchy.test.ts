import { describe, it, expect } from 'vitest';
import {
  renderResellerHierarchy,
  MAX_TREE_DEPTH,
  type TenantNode,
  type ResellerHierarchyData,
} from './reseller-hierarchy.js';
import type { Organization } from '../../org/org-service.js';

const org: Organization = {
  id: 'org_reseller',
  name: 'WYRE Technology',
  ownerId: 'auth0|1',
  plan: 'business',
  defaultServerAccess: 'none',
  promptCaptureEnabled: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  type: 'reseller',
  parentOrgId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-05-16T00:00:00Z',
};

const subtenant = (name: string): TenantNode => ({
  id: name, name, kind: 'subtenant', meta: '3 users', children: [],
});

function tree(over: Partial<TenantNode> = {}): TenantNode {
  return {
    id: 'org_reseller',
    name: 'WYRE Technology',
    kind: 'reseller',
    meta: '2 customers · 8 users · BUSINESS',
    children: [
      {
        id: 'c1', name: 'AM3 Technology', kind: 'customer', meta: '12 users · BUSINESS',
        children: [subtenant('AM3 — Internal IT'), subtenant('AM3 — Client Services')],
      },
      { id: 'c2', name: 'Team DNS Solutions', kind: 'customer', meta: '8 users · PRO', children: [] },
    ],
    ...over,
  };
}

function data(root: TenantNode = tree()): ResellerHierarchyData {
  return { org, root };
}

describe('renderResellerHierarchy', () => {
  it('renders the header with org name and a tenant count (root excluded)', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toContain('Tenant Hierarchy');
    expect(html).toContain('WYRE Technology');
    expect(html).toContain('4 tenants'); // 2 customers + 2 subtenants
  });

  it('renders a card per node with kind badge, name, and meta', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toContain('RESELLER');
    expect(html).toContain('CUSTOMER');
    expect(html).toContain('SUBTENANT');
    expect(html).toContain('AM3 Technology');
    expect(html).toContain('12 users · BUSINESS');
  });

  it('maps node kind to the right card class', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toContain('rh-kind-reseller');
    expect(html).toContain('rh-kind-customer');
    expect(html).toContain('rh-kind-subtenant');
  });

  it('collapses customer subtrees by default (hidden), root expanded', () => {
    const html = renderResellerHierarchy(data());
    // The customer with children carries a collapsed child container.
    expect(html).toMatch(/rh-children[^>]*hidden/);
    // Its toggle reflects the collapsed state.
    expect(html).toContain('aria-expanded="false"');
  });

  it('renders a disclosure toggle only for nodes with children', () => {
    const html = renderResellerHierarchy(data());
    // Default fixture: root + AM3 Technology have children → 2 toggles.
    const toggles = html.match(/class="rh-toggle"/g) ?? [];
    expect(toggles.length).toBe(2);
    expect(html).toContain('aria-label="Expand AM3 Technology"');
    // Team DNS Solutions is childless — no toggle targets it.
    expect(html).not.toContain('aria-label="Expand Team DNS Solutions"');
  });

  it('does not render a toggle for a fully childless tree', () => {
    const html = renderResellerHierarchy(data({
      id: 'solo', name: 'Solo Reseller', kind: 'reseller', meta: '0 customers', children: [],
    }));
    expect(html).not.toContain('rh-toggle');
  });

  it('disables the Table view (Tree-only in v1)', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toMatch(/rh-view[^>]*disabled/);
    expect(html).toContain('rh-view-active');
  });

  it('escapes node names (no HTML injection)', () => {
    const html = renderResellerHierarchy(data(tree({ name: '<script>x</script>' })));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('singularizes the tenant count for a one-tenant tree', () => {
    const html = renderResellerHierarchy(data(tree({
      children: [{ id: 'c1', name: 'Solo', kind: 'customer', meta: '1 user', children: [] }],
    })));
    expect(html).toContain('1 tenant.');
  });

  it('carries ARIA tree semantics (tree / treeitem / group)', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('role="group"');
  });

  it('renders an empty-state when the reseller has no customers', () => {
    const html = renderResellerHierarchy(data(tree({ children: [] })));
    expect(html).toContain('No customers under this reseller yet');
  });

  it('does not infinite-loop on a cyclic tree (child points back to an ancestor)', () => {
    const root: TenantNode = {
      id: 'org_reseller', name: 'WYRE Technology', kind: 'reseller', meta: '', children: [],
    };
    const cust: TenantNode = {
      id: 'c1', name: 'Cycle Customer', kind: 'customer', meta: '', children: [],
    };
    root.children.push(cust);
    cust.children.push(root); // cycle: customer's child is the root
    // Must return, not overflow the stack.
    const html = renderResellerHierarchy({ org, root });
    expect(html).toContain('Cycle Customer');
  });

  it('truncates the render at MAX_TREE_DEPTH (cap is a real pin, not just no-throw)', () => {
    // A single chain Depth-0 (root) … Depth-30, one node per level.
    const nodes: TenantNode[] = [];
    for (let d = 0; d <= 30; d++) {
      nodes.push({
        id: `d${d}`, name: `Depth-${d}-NODE`,
        kind: d === 0 ? 'reseller' : 'subtenant', meta: '', children: [],
      });
    }
    for (let d = 0; d < 30; d++) nodes[d].children.push(nodes[d + 1]);

    const html = renderResellerHierarchy({ org, root: nodes[0] });
    // Nodes within the cap render…
    expect(html).toContain(`Depth-${MAX_TREE_DEPTH}-NODE`);
    // …nodes past it are absent — remove the cap and this goes red.
    expect(html).not.toContain(`Depth-${MAX_TREE_DEPTH + 1}-NODE`);
    expect(html).not.toContain('Depth-30-NODE');
  });

  it('renders a 3-level-deep tree (reseller → customer → subtenant)', () => {
    const html = renderResellerHierarchy(data());
    expect(html).toContain('AM3 — Internal IT');
    expect(html).toContain('AM3 — Client Services');
  });
});
