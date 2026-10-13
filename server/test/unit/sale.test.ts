import { describe, expect, it } from 'vitest';
import {
  computeSaleStatus,
  InvalidSaleConfigError,
  normalizeUserId,
  validateSaleConfig,
} from '../../src/domain/sale.js';

const sale = { id: 's', startsAt: 1_000, endsAt: 2_000, totalStock: 10 };

describe('computeSaleStatus', () => {
  it.each([
    [999, 10, 'upcoming'],
    [1_000, 10, 'active'],
    [1_999, 1, 'active'],
    [1_500, 0, 'sold_out'],
    [2_000, 10, 'ended'],
    [5_000, 0, 'ended'],
  ] as const)('at t=%i with stock %i is %s', (now, stock, expected) => {
    expect(computeSaleStatus(sale, stock, now)).toBe(expected);
  });
});

describe('normalizeUserId', () => {
  it('trims and lower-cases so emails are case-insensitive', () => {
    expect(normalizeUserId('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it.each(['', '   ', 'has space', 'semi;colon', 'x'.repeat(129), 42, null, undefined])(
    'rejects %j',
    (value) => {
      expect(normalizeUserId(value)).toBeNull();
    },
  );
});

describe('validateSaleConfig', () => {
  it('accepts a valid config', () => {
    expect(validateSaleConfig(sale)).toBe(sale);
  });

  it.each([
    { ...sale, id: 'bad id!' },
    { ...sale, endsAt: sale.startsAt },
    { ...sale, startsAt: Number.NaN },
    { ...sale, totalStock: -1 },
    { ...sale, totalStock: 1.5 },
  ])('rejects %j', (config) => {
    expect(() => validateSaleConfig(config)).toThrow(InvalidSaleConfigError);
  });
});
