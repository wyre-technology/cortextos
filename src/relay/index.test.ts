/**
 * Wire-proven boot tests for the relay container entry point.
 *
 * Per boss/analyst/warden triple-convergence (2026-05-21) on the
 * defined-vs-invoked principle: a security primitive defined at the function
 * layer without wiring its call site is the same defect class as a gate
 * defined without wiring its enforcement. These tests pin the wiring
 * structurally — same red→green-pin shape as PR #198: the guard MUST fire
 * when its precondition is violated, otherwise the wiring is decorative.
 *
 * Each test deletes a precondition the boot sequence depends on and asserts
 * `bootRelay()` aborts loud (throws) — which IS the production failure path.
 * If a future refactor removed the `assertInternalIngress()` call from
 * `src/relay/index.ts`, this test would go GREEN (boot would succeed despite
 * the misconfig) — making the test red→green-pin-load-bearing.
 *
 * What this is NOT: a test that `bootRelay()` succeeds end-to-end. That is
 * the happy-path integration-test territory; here the load-bearing claim is
 * "boot fails when its security preconditions are violated," and that is
 * exactly what these tests assert.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootRelay } from './index.js';

describe('bootRelay — wire-proven boot-assert tests', () => {
  const ORIG_INGRESS = process.env.CONTROL_PLANE_INGRESS;
  const ORIG_SECRET = process.env.CONTROL_PLANE_SECRET;

  function restore(): void {
    if (ORIG_INGRESS === undefined) delete process.env.CONTROL_PLANE_INGRESS;
    else process.env.CONTROL_PLANE_INGRESS = ORIG_INGRESS;
    if (ORIG_SECRET === undefined) delete process.env.CONTROL_PLANE_SECRET;
    else process.env.CONTROL_PLANE_SECRET = ORIG_SECRET;
  }

  afterEach(() => {
    restore();
  });

  it('aborts boot LOUD when CONTROL_PLANE_INGRESS is unset (assertInternalIngress fires)', async () => {
    delete process.env.CONTROL_PLANE_INGRESS;
    process.env.CONTROL_PLANE_SECRET = 'irrelevant-for-this-test';
    // The whole point: boot must NOT silently succeed when the deployment
    // policy guard is violated. If a refactor removes the
    // assertInternalIngress() call from index.ts, this expectation flips.
    await expect(bootRelay()).rejects.toThrow(/CONTROL_PLANE_INGRESS|INTERNAL-INGRESS INVARIANT/);
  });

  it('aborts boot LOUD when CONTROL_PLANE_INGRESS is set to a non-internal value', async () => {
    process.env.CONTROL_PLANE_INGRESS = 'external';
    process.env.CONTROL_PLANE_SECRET = 'irrelevant-for-this-test';
    await expect(bootRelay()).rejects.toThrow(/INTERNAL-INGRESS INVARIANT|expected.*internal/);
  });

  it('aborts boot LOUD when CONTROL_PLANE_SECRET is unset (requireControlPlaneSecret fires)', async () => {
    process.env.CONTROL_PLANE_INGRESS = 'internal';
    delete process.env.CONTROL_PLANE_SECRET;
    // Same red→green-pin shape on the HMAC secret precondition: boot must
    // NOT silently succeed when the secret is missing. A refactor that
    // skipped the requireControlPlaneSecret() call would flip this test.
    await expect(bootRelay()).rejects.toThrow(/CONTROL_PLANE_SECRET/);
  });

  it('aborts boot LOUD when CONTROL_PLANE_SECRET is empty string (no special-case for empty)', async () => {
    process.env.CONTROL_PLANE_INGRESS = 'internal';
    process.env.CONTROL_PLANE_SECRET = '';
    await expect(bootRelay()).rejects.toThrow(/CONTROL_PLANE_SECRET/);
  });
});
