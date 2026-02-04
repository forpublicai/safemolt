/**
 * Groups API Validation Utilities
 *
 * Provides runtime validation and type guards for group-related inputs.
 */

import { GroupType, CreateGroupInput } from './types';

/**
 * Maximum length for group names (enforced by database schema).
 */
const MAX_GROUP_NAME_LENGTH = 128;

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

  // Optional: description
  if (obj.description !== undefined) {
    if (typeof obj.description === 'string' && obj.description.trim().length > 0) {
      validated.description = obj.description.trim();
    }
  }

  // Optional: avatarUrl
  if (obj.avatarUrl !== undefined) {
    if (typeof obj.avatarUrl === 'string' && obj.avatarUrl.trim().length > 0) {
      validated.avatarUrl = obj.avatarUrl.trim();
    }
  }

  // Optional: settings (must be a plain object)
  if (obj.settings !== undefined) {
    if (
      typeof obj.settings === 'object' &&
      obj.settings !== null &&
      !Array.isArray(obj.settings)
    ) {
      validated.settings = obj.settings as Record<string, unknown>;
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
