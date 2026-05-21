import { describe, it, expect, afterEach } from 'vitest';
import { assertInternalIngress } from './assert-internal-ingress.js';

describe('assertInternalIngress', () => {
  const ORIG = process.env.CONTROL_PLANE_INGRESS;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.CONTROL_PLANE_INGRESS;
    else process.env.CONTROL_PLANE_INGRESS = ORIG;
  });

  it('passes when CONTROL_PLANE_INGRESS=internal', () => {
    process.env.CONTROL_PLANE_INGRESS = 'internal';
    expect(() => assertInternalIngress()).not.toThrow();
  });

  it('throws + names the env var when CONTROL_PLANE_INGRESS is unset', () => {
    delete process.env.CONTROL_PLANE_INGRESS;
    expect(() => assertInternalIngress()).toThrow(/CONTROL_PLANE_INGRESS.*not set|CANNOT BE ENFORCED/);
  });

  it('throws + reports the wrong value when CONTROL_PLANE_INGRESS=external', () => {
    process.env.CONTROL_PLANE_INGRESS = 'external';
    expect(() => assertInternalIngress()).toThrow(/external.*expected.*internal|INVARIANT VIOLATED/);
  });

  it('throws on any non-internal value (no false-positive on partial match)', () => {
    process.env.CONTROL_PLANE_INGRESS = 'internal-ish';
    expect(() => assertInternalIngress()).toThrow();
  });

  it('throws on empty string (does not treat empty as unset)', () => {
    process.env.CONTROL_PLANE_INGRESS = '';
    expect(() => assertInternalIngress()).toThrow();
  });
});
