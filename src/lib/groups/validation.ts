/**
 * Groups API Validation Utilities
 *
 * Provides runtime validation and type guards for group-related inputs.
 *
 * @security XSS Prevention: Description and other user-provided text fields must be
 * HTML-escaped on render to prevent XSS attacks. This module performs input validation
 * only; output encoding is the responsibility of the rendering layer.
 */

import { GroupType, CreateGroupInput } from './types';

/**
 * Maximum length for group names (enforced by database schema).
 */
const MAX_GROUP_NAME_LENGTH = 128;

/**
 * Maximum length for group descriptions.
 */
export const MAX_DESCRIPTION_LENGTH = 10000;

/**
 * Maximum length for avatar URLs.
 */
export const MAX_AVATAR_URL_LENGTH = 2048;

/**
 * Allowed protocols for avatar URLs.
 * Only http and https are permitted to prevent XSS via javascript:, data:, or file: URLs.
 */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Keys that are dangerous in settings objects and must be stripped to prevent prototype pollution.
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Type guard to check if a string is a valid GroupType.
 * Enables type narrowing in TypeScript.
 *
 * @param type - String to validate
 * @returns True if type is a valid GroupType, with type narrowing
 *
 * @example
 * const type: string = 'houses';
 * if (isValidGroupType(type)) {
 *   // type is now narrowed to GroupType
 *   const group: StoredGroup = { type, ... };
 * }
 */
export function isValidGroupType(type: string): type is GroupType {
  return Object.values(GroupType).includes(type as GroupType);
}

/**
 * Validates a group name against business rules.
 *
 * Rules:
 * - Must be non-empty after trimming
 * - Must not exceed 128 characters
 * - Must contain at least one non-whitespace character
 *
 * @param name - Group name to validate
 * @returns Validation result with success flag and optional error message
 *
 * @example
 * const result = validateGroupName('My House');
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 */
export function validateGroupName(name: string): { valid: boolean; error?: string } {
  // Check for null/undefined
  if (name == null) {
    return { valid: false, error: 'Group name is required' };
  }

  // Trim whitespace
  const trimmed = name.trim();

  // Check for empty after trim
  if (trimmed.length === 0) {
    return { valid: false, error: 'Group name cannot be empty' };
  }

  // Check length constraint
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) {
    return {
      valid: false,
      error: `Group name cannot exceed ${MAX_GROUP_NAME_LENGTH} characters`,
    };
  }

  // Check for at least one non-whitespace character
  if (!/\S/.test(trimmed)) {
    return { valid: false, error: 'Group name must contain at least one non-whitespace character' };
  }

  return { valid: true };
}

/**
 * Validates a group description against length constraints.
 *
 * @security Description must be HTML-escaped on render to prevent XSS attacks.
 * This function only validates input length; output encoding is the responsibility
 * of the rendering layer.
 *
 * @param desc - Description string to validate
 * @returns Validation result with success flag and optional error message
 *
 * @example
 * const result = validateDescription('This is my group description');
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 */
export function validateDescription(desc: string): { valid: boolean; error?: string } {
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`,
    };
  }
  return { valid: true };
}

/**
 * Validates an avatar URL against security constraints.
 *
 * Rules:
 * - Must not exceed 2048 characters
 * - Must be a valid URL
 * - Must use http: or https: protocol (rejects javascript:, data:, file:, etc.)
 *
 * @param url - URL string to validate
 * @returns Validation result with success flag and optional error message
 *
 * @example
 * const result = validateAvatarUrl('https://example.com/avatar.png');
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 */
export function validateAvatarUrl(url: string): { valid: boolean; error?: string } {
  if (url.length > MAX_AVATAR_URL_LENGTH) {
    return {
      valid: false,
      error: `URL exceeds maximum length of ${MAX_AVATAR_URL_LENGTH} characters`,
    };
  }

  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return {
        valid: false,
        error: 'URL must use http or https protocol',
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Sanitizes a settings object by stripping dangerous keys that could cause prototype pollution.
 *
 * Removes the following keys:
 * - __proto__: Prevents prototype chain manipulation
 * - constructor: Prevents constructor manipulation
 * - prototype: Prevents prototype manipulation
 *
 * @param obj - Settings object to sanitize
 * @returns Sanitized copy of the object with dangerous keys removed
 *
 * @example
 * const input = { theme: 'dark', __proto__: { isAdmin: true } };
 * const safe = sanitizeSettings(input);
 * // safe = { theme: 'dark' }
 */
export function sanitizeSettings(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.includes(key)) continue;

    // Recursively sanitize nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeSettings(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Validates and normalizes CreateGroupInput from untrusted sources.
 *
 * Performs runtime type checking and sanitization:
 * - Validates required fields (name)
 * - Validates name length constraints
 * - Normalizes optional fields to undefined if invalid
 * - Ensures settings is a plain object
 *
 * @param input - Untrusted input to validate
 * @returns Validated CreateGroupInput or null if invalid
 *
 * @example
 * const input = JSON.parse(requestBody);
 * const validated = validateCreateGroupInput(input);
 * if (validated === null) {
 *   return { error: 'Invalid input' };
 * }
 * await createGroup(validated);
 */
export function validateCreateGroupInput(input: unknown): CreateGroupInput | null {
  // Type guard: must be an object
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const obj = input as Record<string, unknown>;

  // Validate required field: name
  if (typeof obj.name !== 'string') {
    return null;
  }

  const nameValidation = validateGroupName(obj.name);
  if (!nameValidation.valid) {
    return null;
  }

  // Build validated input
  const validated: CreateGroupInput = {
    name: obj.name.trim(),
  };

  // Optional: description (with length validation)
  if (obj.description !== undefined) {
    if (typeof obj.description === 'string' && obj.description.trim().length > 0) {
      const trimmedDesc = obj.description.trim();
      const descValidation = validateDescription(trimmedDesc);
      if (descValidation.valid) {
        validated.description = trimmedDesc;
      }
      // If validation fails, we silently skip (or could return null for strict mode)
    }
  }

  // Optional: avatarUrl (with URL validation)
  if (obj.avatarUrl !== undefined) {
    if (typeof obj.avatarUrl === 'string' && obj.avatarUrl.trim().length > 0) {
      const trimmedUrl = obj.avatarUrl.trim();
      const urlValidation = validateAvatarUrl(trimmedUrl);
      if (urlValidation.valid) {
        validated.avatarUrl = trimmedUrl;
      }
      // If validation fails, we silently skip (or could return null for strict mode)
    }
  }

  // Optional: settings (must be a plain object, sanitized for prototype pollution)
  if (obj.settings !== undefined) {
    if (
      typeof obj.settings === 'object' &&
      obj.settings !== null &&
      !Array.isArray(obj.settings)
    ) {
      validated.settings = sanitizeSettings(obj.settings as Record<string, unknown>);
    }
  }

  // Optional: visibility
  if (obj.visibility !== undefined) {
    if (obj.visibility === 'public' || obj.visibility === 'private') {
      validated.visibility = obj.visibility;
    }
  }

  return validated;
}
