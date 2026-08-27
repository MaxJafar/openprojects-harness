import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../src/core/types.js';
import {
  parseJsonRejectingDuplicateKeys,
  StrictJsonError,
} from '../src/core/strict-json.js';
import {
  canonicalizeToolArguments,
  verifyCanonicalToolArguments,
} from '../src/runtime/tool-arguments.js';

describe('strict JSON tool arguments', () => {
  it.each([
    ['direct', '{"destination":"first","destination":"second"}'],
    ['escape-equivalent', '{"destination":"first","\\u0064estination":"second"}'],
    ['nested', '{"outer":{"value":1,"\\u0076alue":2}}'],
  ])('rejects %s duplicate object member names', (_label, source) => {
    expect(() => parseJsonRejectingDuplicateKeys(source)).toThrow(StrictJsonError);
    try {
      parseJsonRejectingDuplicateKeys(source);
    } catch (error) {
      expect(error).toMatchObject({ code: 'DUPLICATE_JSON_KEY' });
    }
  });

  it('canonicalizes one stable object representation and verifies its digest', () => {
    const bound = canonicalizeToolArguments({ z: 2, nested: { b: true, a: 'value' }, a: 1 });

    expect(bound.arguments).toBe('{"a":1,"nested":{"a":"value","b":true},"z":2}');
    expect(bound.argumentsDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(verifyCanonicalToolArguments(bound.arguments, bound.argumentsDigest)).toEqual({
      a: 1,
      nested: { a: 'value', b: true },
      z: 2,
    });
    expect(() => verifyCanonicalToolArguments(
      '{"z":2,"a":1,"nested":{"a":"value","b":true}}',
      bound.argumentsDigest,
    )).toThrow('canonical form');
  });

  it('gives whitespace, key-order, and escaped-string variants one identity', () => {
    const sources = [
      '{"z":2,"label":"alpha","nested":{"b":true,"a":1}}',
      '{ "nested" : { "a" : 1, "b" : true }, "label" : "alpha", "z" : 2 }',
      '{"label":"\\u0061lpha","nested":{"b":true,"a":1},"z":2}',
    ];
    const bindings = sources.map((source) => {
      const parsed = parseJsonRejectingDuplicateKeys(source);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('fixture must be an object');
      }
      return canonicalizeToolArguments(parsed as JsonObject);
    });

    expect(new Set(bindings.map((binding) => binding.arguments))).toEqual(new Set([
      '{"label":"alpha","nested":{"a":1,"b":true},"z":2}',
    ]));
    expect(new Set(bindings.map((binding) => binding.argumentsDigest)).size).toBe(1);
  });
});
