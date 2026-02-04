/**
 * Unit tests for src/lib/groups/validation.ts
 * @jest-environment node
 */
import {
  isValidGroupType,
  validateGroupName,
  validateCreateGroupInput,
} from '@/lib/groups/validation';
import { GroupType } from '@/lib/groups/types';

describe('isValidGroupType', () => {
  it('returns true with type narrowing for valid group type "houses"', () => {
    const type: string = 'houses';
    expect(isValidGroupType(type)).toBe(true);

    // Type narrowing verification (compile-time check)
    if (isValidGroupType(type)) {
      // type is now narrowed to GroupType
      const validType: GroupType = type;
      expect(validType).toBe('houses');
    }
  });

  it('returns false for unknown type strings', () => {
    expect(isValidGroupType('clans')).toBe(false);
    expect(isValidGroupType('guilds')).toBe(false);
    expect(isValidGroupType('invalid')).toBe(false);
    expect(isValidGroupType('')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isValidGroupType('HOUSES')).toBe(false);
    expect(isValidGroupType('Houses')).toBe(false);
  });
});

describe('validateGroupName', () => {
  it('accepts valid names', () => {
    const result = validateGroupName('My House');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('trims whitespace and accepts trimmed names', () => {
    const result = validateGroupName('  Trimmed  ');
    expect(result.valid).toBe(true);
  });

  it('rejects empty strings after trimming', () => {
    const result = validateGroupName('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects names exceeding 128 characters', () => {
    const longName = 'a'.repeat(129);
    const result = validateGroupName(longName);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('128 characters');
  });

  it('accepts names at exactly 128 characters', () => {
    const maxName = 'a'.repeat(128);
    const result = validateGroupName(maxName);
    expect(result.valid).toBe(true);
  });

  it('rejects null or undefined', () => {
    // @ts-expect-error Testing runtime validation
    const result1 = validateGroupName(null);
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('required');

    // @ts-expect-error Testing runtime validation
    const result2 = validateGroupName(undefined);
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain('required');
  });

  it('accepts names with special characters', () => {
    const result = validateGroupName('House of St. John\'s');
    expect(result.valid).toBe(true);
  });
});

describe('validateCreateGroupInput', () => {
  it('validates minimal valid input', () => {
    const input = { name: 'Test House' };
    const result = validateCreateGroupInput(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Test House');
  });

  it('trims name in validated output', () => {
    const input = { name: '  Trimmed House  ' };
    const result = validateCreateGroupInput(input);
    expect(result?.name).toBe('Trimmed House');
  });

  it('validates complete input with all optional fields', () => {
    const input = {
      name: 'Complete House',
      description: 'A test house',
      avatarUrl: 'https://example.com/avatar.png',
      settings: { theme: 'dark' },
      visibility: 'private' as const,
    };
    const result = validateCreateGroupInput(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Complete House');
    expect(result?.description).toBe('A test house');
    expect(result?.avatarUrl).toBe('https://example.com/avatar.png');
    expect(result?.settings).toEqual({ theme: 'dark' });
    expect(result?.visibility).toBe('private');
  });

  it('rejects input without name field', () => {
    const input = { description: 'Missing name' };
    const result = validateCreateGroupInput(input);
    expect(result).toBeNull();
  });

  it('rejects input with non-string name', () => {
    const input = { name: 123 };
    const result = validateCreateGroupInput(input);
    expect(result).toBeNull();
  });

  it('rejects input with invalid name (too long)', () => {
    const input = { name: 'a'.repeat(129) };
    const result = validateCreateGroupInput(input);
    expect(result).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateCreateGroupInput(null)).toBeNull();
    expect(validateCreateGroupInput(undefined)).toBeNull();
    expect(validateCreateGroupInput('string')).toBeNull();
    expect(validateCreateGroupInput(123)).toBeNull();
    expect(validateCreateGroupInput([])).toBeNull();
  });

  it('normalizes optional fields to undefined if invalid', () => {
    const input = {
      name: 'House',
      description: '',  // Empty string should be normalized out
      avatarUrl: '   ', // Whitespace-only should be normalized out
      settings: [],     // Array should be normalized out
      visibility: 'invalid', // Invalid visibility should be normalized out
    };
    const result = validateCreateGroupInput(input);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('House');
    expect(result?.description).toBeUndefined();
    expect(result?.avatarUrl).toBeUndefined();
    expect(result?.settings).toBeUndefined();
    expect(result?.visibility).toBeUndefined();
  });

  it('accepts valid visibility values', () => {
    const input1 = { name: 'House', visibility: 'public' as const };
    const result1 = validateCreateGroupInput(input1);
    expect(result1?.visibility).toBe('public');

    const input2 = { name: 'House', visibility: 'private' as const };
    const result2 = validateCreateGroupInput(input2);
    expect(result2?.visibility).toBe('private');
  });

  it('trims description and avatarUrl', () => {
    const input = {
      name: 'House',
      description: '  Description  ',
      avatarUrl: '  https://example.com/avatar.png  ',
    };
    const result = validateCreateGroupInput(input);
    expect(result?.description).toBe('Description');
    expect(result?.avatarUrl).toBe('https://example.com/avatar.png');
  });

  it('accepts plain object for settings', () => {
    const input = {
      name: 'House',
      settings: { key1: 'value1', key2: 123, nested: { deep: true } },
    };
    const result = validateCreateGroupInput(input);
    expect(result?.settings).toEqual({ key1: 'value1', key2: 123, nested: { deep: true } });
  });
});
