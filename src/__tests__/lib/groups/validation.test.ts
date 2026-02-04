/**
 * Unit tests for src/lib/groups/validation.ts
 * @jest-environment node
 */
import {
  isValidGroupType,
  validateGroupName,
  validateCreateGroupInput,
  validateDescription,
  validateAvatarUrl,
  sanitizeSettings,
  MAX_DESCRIPTION_LENGTH,
  MAX_AVATAR_URL_LENGTH,
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

  it('sanitizes settings to remove dangerous keys', () => {
    const input = {
      name: 'House',
      settings: { theme: 'dark', constructor: 'malicious', prototype: 'bad' },
    };
    const result = validateCreateGroupInput(input);
    expect(result?.settings).toEqual({ theme: 'dark' });
    // Check that dangerous keys were not copied as own properties
    expect(Object.keys(result?.settings ?? {})).not.toContain('constructor');
    expect(Object.keys(result?.settings ?? {})).not.toContain('prototype');
  });

  it('rejects avatar URLs with invalid protocols', () => {
    const input = {
      name: 'House',
      avatarUrl: 'javascript:alert(1)',
    };
    const result = validateCreateGroupInput(input);
    expect(result?.avatarUrl).toBeUndefined();
  });

  it('rejects descriptions exceeding max length', () => {
    const input = {
      name: 'House',
      description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1),
    };
    const result = validateCreateGroupInput(input);
    expect(result?.description).toBeUndefined();
  });
});

describe('validateDescription', () => {
  it('accepts valid descriptions', () => {
    const result = validateDescription('This is a valid description');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts empty descriptions', () => {
    const result = validateDescription('');
    expect(result.valid).toBe(true);
  });

  it('accepts descriptions at exactly max length', () => {
    const result = validateDescription('a'.repeat(MAX_DESCRIPTION_LENGTH));
    expect(result.valid).toBe(true);
  });

  it('rejects descriptions exceeding max length', () => {
    const result = validateDescription('a'.repeat(MAX_DESCRIPTION_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum length');
  });

  it('exports MAX_DESCRIPTION_LENGTH as 10000', () => {
    expect(MAX_DESCRIPTION_LENGTH).toBe(10000);
  });
});

describe('validateAvatarUrl', () => {
  it('accepts valid https URLs', () => {
    const result = validateAvatarUrl('https://example.com/avatar.png');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts valid http URLs', () => {
    const result = validateAvatarUrl('http://example.com/avatar.png');
    expect(result.valid).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    const result = validateAvatarUrl('javascript:alert(1)');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('http or https');
  });

  it('rejects data: URLs', () => {
    const result = validateAvatarUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('http or https');
  });

  it('rejects file: URLs', () => {
    const result = validateAvatarUrl('file:///etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('http or https');
  });

  it('rejects invalid URLs', () => {
    const result = validateAvatarUrl('not-a-valid-url');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('rejects URLs exceeding max length', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(MAX_AVATAR_URL_LENGTH);
    const result = validateAvatarUrl(longUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum length');
  });

  it('accepts URLs at exactly max length', () => {
    // Create a URL that is exactly MAX_AVATAR_URL_LENGTH
    const baseUrl = 'https://example.com/';
    const padding = 'a'.repeat(MAX_AVATAR_URL_LENGTH - baseUrl.length);
    const exactLengthUrl = baseUrl + padding;
    expect(exactLengthUrl.length).toBe(MAX_AVATAR_URL_LENGTH);
    const result = validateAvatarUrl(exactLengthUrl);
    expect(result.valid).toBe(true);
  });

  it('exports MAX_AVATAR_URL_LENGTH as 2048', () => {
    expect(MAX_AVATAR_URL_LENGTH).toBe(2048);
  });

  describe('environment-aware protocol validation', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('rejects http URLs in production', () => {
      process.env.NODE_ENV = 'production';
      const result = validateAvatarUrl('http://example.com/avatar.png');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('URL must use https protocol in production');
    });

    it('accepts https URLs in production', () => {
      process.env.NODE_ENV = 'production';
      const result = validateAvatarUrl('https://example.com/avatar.png');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts both http and https URLs in development', () => {
      process.env.NODE_ENV = 'development';
      const httpResult = validateAvatarUrl('http://example.com/avatar.png');
      expect(httpResult.valid).toBe(true);
      expect(httpResult.error).toBeUndefined();

      const httpsResult = validateAvatarUrl('https://example.com/avatar.png');
      expect(httpsResult.valid).toBe(true);
      expect(httpsResult.error).toBeUndefined();
    });

    it('accepts both http and https URLs when NODE_ENV is not set', () => {
      delete process.env.NODE_ENV;
      const httpResult = validateAvatarUrl('http://example.com/avatar.png');
      expect(httpResult.valid).toBe(true);
      expect(httpResult.error).toBeUndefined();

      const httpsResult = validateAvatarUrl('https://example.com/avatar.png');
      expect(httpsResult.valid).toBe(true);
      expect(httpsResult.error).toBeUndefined();
    });
  });
});

describe('sanitizeSettings', () => {
  it('preserves safe keys', () => {
    const input = { theme: 'dark', fontSize: 14, nested: { deep: true } };
    const result = sanitizeSettings(input);
    expect(result).toEqual({ theme: 'dark', fontSize: 14, nested: { deep: true } });
  });

  it('strips __proto__ key', () => {
    // Use Object.defineProperty to explicitly set __proto__ as own property for test
    const input: Record<string, unknown> = { theme: 'dark' };
    Object.defineProperty(input, '__proto__', { value: { isAdmin: true }, enumerable: true });
    const result = sanitizeSettings(input);
    expect(result).toEqual({ theme: 'dark' });
    // Check that __proto__ was not copied as own property
    expect(Object.keys(result)).not.toContain('__proto__');
  });

  it('strips constructor key', () => {
    const input = { theme: 'dark', constructor: 'malicious' };
    const result = sanitizeSettings(input);
    expect(result).toEqual({ theme: 'dark' });
    // Check that constructor was not copied as own property
    expect(Object.keys(result)).not.toContain('constructor');
  });

  it('strips prototype key', () => {
    const input = { theme: 'dark', prototype: { pollute: true } };
    const result = sanitizeSettings(input);
    expect(result).toEqual({ theme: 'dark' });
    expect(result).not.toHaveProperty('prototype');
  });

  it('strips all dangerous keys at once', () => {
    const input = {
      theme: 'dark',
      __proto__: { a: 1 },
      constructor: 'bad',
      prototype: { b: 2 },
    };
    const result = sanitizeSettings(input);
    expect(result).toEqual({ theme: 'dark' });
  });

  it('returns empty object when only dangerous keys present', () => {
    const input = { __proto__: { a: 1 }, constructor: 'bad' };
    const result = sanitizeSettings(input);
    expect(result).toEqual({});
  });

  it('handles empty object', () => {
    const result = sanitizeSettings({});
    expect(result).toEqual({});
  });

  it('recursively strips dangerous keys from nested objects', () => {
    const input = {
      theme: 'dark',
      nested: {
        color: 'blue',
        __proto__: { isAdmin: true },
        deeper: {
          constructor: 'malicious',
          valid: 'value'
        }
      }
    };
    const result = sanitizeSettings(input);
    expect(result).toEqual({
      theme: 'dark',
      nested: {
        color: 'blue',
        deeper: {
          valid: 'value'
        }
      }
    });
  });
});
