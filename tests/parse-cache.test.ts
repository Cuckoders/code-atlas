import { describe, expect, it } from 'vitest';
import { MAX_PARSE_CACHE_JSON_SIZE, parseCachedSource } from '../src/server/parse-cache.js';

describe('parseCachedSource', () => {
  it('accepts a structurally valid parsed source', () => {
    const value = JSON.stringify({
      symbols: [],
      imports: ['./local'],
      calls: [],
      routes: [],
      parser: 'test parser',
    });
    expect(parseCachedSource(value)).toEqual(expect.objectContaining({ parser: 'test parser' }));
  });

  it('rejects malformed and oversized cache payloads', () => {
    expect(parseCachedSource('{"parser":"missing arrays"}')).toBeNull();
    expect(parseCachedSource(JSON.stringify({
      symbols: [],
      imports: [],
      calls: [{ sourceSymbol: 'A', targetSymbol: 'B', targetMember: 42, line: 1 }],
      routes: [],
      parser: 'invalid call member',
    }))).toBeNull();
    expect(parseCachedSource('x'.repeat(MAX_PARSE_CACHE_JSON_SIZE + 1))).toBeNull();
  });
});
