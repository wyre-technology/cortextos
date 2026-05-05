import { describe, it, expect } from 'vitest';
import { parseFilter, UnsupportedFilterError } from '../filter.js';

describe('SCIM filter parser', () => {
  it('parses userName eq', () => {
    expect(parseFilter('userName eq "alice@acme.com"')).toEqual({
      attribute: 'userName',
      value: 'alice@acme.com',
    });
  });

  it('parses externalId eq', () => {
    expect(parseFilter('externalId eq "abc-123"')).toEqual({
      attribute: 'externalId',
      value: 'abc-123',
    });
  });

  it('is case-insensitive on attribute name', () => {
    expect(parseFilter('USERNAME eq "x"').attribute).toBe('userName');
    expect(parseFilter('externalid eq "x"').attribute).toBe('externalId');
  });

  it('rejects unsupported filters', () => {
    expect(() => parseFilter('userName ne "x"')).toThrow(UnsupportedFilterError);
    expect(() => parseFilter('userName co "x"')).toThrow(UnsupportedFilterError);
    expect(() => parseFilter('emails[type eq "work"]')).toThrow(UnsupportedFilterError);
  });

  it('unescapes simple JSON-style escapes', () => {
    expect(parseFilter('userName eq "a\\"b"').value).toBe('a"b');
  });
});
