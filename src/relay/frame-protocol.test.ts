import { describe, it, expect } from 'vitest';
import {
  parseFrame,
  serializeFrame,
  type RegisterFrame,
  type RequestFrame,
  type ResponseFrame,
} from './frame-protocol.js';

describe('frame-protocol parseFrame', () => {
  it('parses a valid register frame', () => {
    const raw = JSON.stringify({
      type: 'register',
      v: 1,
      enrollmentToken: 'tok-abc',
      capabilities: ['echo'],
    });
    const f = parseFrame(raw);
    expect(f?.type).toBe('register');
    expect((f as RegisterFrame).enrollmentToken).toBe('tok-abc');
  });

  it('parses a valid request frame and a valid response frame', () => {
    const req = parseFrame(
      JSON.stringify({ type: 'request', v: 1, correlationId: 'c1', target: 'echo', payload: { x: 1 } }),
    );
    expect(req?.type).toBe('request');
    expect((req as RequestFrame).correlationId).toBe('c1');

    const res = parseFrame(
      JSON.stringify({ type: 'response', v: 1, correlationId: 'c1', payload: { ok: true } }),
    );
    expect(res?.type).toBe('response');
    expect((res as ResponseFrame).correlationId).toBe('c1');
  });

  it('rejects non-JSON', () => {
    expect(parseFrame('not json{')).toBeNull();
  });

  it('rejects a frame with an unknown type', () => {
    expect(parseFrame(JSON.stringify({ type: 'exec', v: 1 }))).toBeNull();
  });

  it('rejects a frame with a missing or wrong protocol version', () => {
    expect(parseFrame(JSON.stringify({ type: 'heartbeat' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'heartbeat', v: 2 }))).toBeNull();
  });

  it('rejects a register frame with an empty enrollment token', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'register', v: 1, enrollmentToken: '', capabilities: ['echo'] })),
    ).toBeNull();
  });

  it('rejects a register frame with non-string capabilities', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'register', v: 1, enrollmentToken: 't', capabilities: [1, 2] })),
    ).toBeNull();
  });

  it('rejects a request frame with no correlationId', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'request', v: 1, target: 'echo', payload: {} })),
    ).toBeNull();
  });

  it('rejects a request frame with no target', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'request', v: 1, correlationId: 'c1', payload: {} })),
    ).toBeNull();
  });

  it('rejects a request frame with no payload key', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'request', v: 1, correlationId: 'c1', target: 'echo' })),
    ).toBeNull();
  });

  it('accepts a request frame whose payload is explicitly null', () => {
    // `payload: null` is a present key — distinct from a missing key.
    const f = parseFrame(
      JSON.stringify({ type: 'request', v: 1, correlationId: 'c1', target: 'echo', payload: null }),
    );
    expect(f?.type).toBe('request');
  });

  it('rejects a response frame with neither payload nor error', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'response', v: 1, correlationId: 'c1' })),
    ).toBeNull();
  });

  it('rejects a register_nack frame with an unknown reason', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'register_nack', v: 1, reason: 'because' })),
    ).toBeNull();
  });

  it('rejects null and non-object JSON', () => {
    expect(parseFrame('null')).toBeNull();
    expect(parseFrame('42')).toBeNull();
    expect(parseFrame('"a string"')).toBeNull();
    expect(parseFrame('[]')).toBeNull();
  });

  it('roundtrips through serializeFrame → parseFrame', () => {
    const frame: RequestFrame = {
      type: 'request',
      v: 1,
      correlationId: 'corr-9',
      target: 'echo',
      payload: { method: 'tools/list' },
    };
    const back = parseFrame(serializeFrame(frame));
    expect(back).toEqual(frame);
  });
});
