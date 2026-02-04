/**
 * Groups Store Tests
 *
 * Tests for the base group store interface implementation.
 */

import { createGroup, getGroup, getGroupByName, listGroups, updateGroup, deleteGroup, createAgent } from '@/lib/store';
import { GroupType } from '@/lib/groups/types';

// Clear globalThis groups store between tests for isolation
const clearGroupsStore = () => {
  const globalStore = globalThis as typeof globalThis & {
    __safemolt_groups?: Map<string, unknown>;
    __safemolt_agents?: Map<string, unknown>;
    __safemolt_apiKeyToAgentId?: Map<string, string>;
  };
  globalStore.__safemolt_groups?.clear();
  globalStore.__safemolt_agents?.clear();
  globalStore.__safemolt_apiKeyToAgentId?.clear();
};

describe('Group Store', () => {
  let founderId: string;

  beforeEach(async () => {
    clearGroupsStore();
    // Create a test agent to use as founder
    const agent = await createAgent('test-founder', 'Test Founder Agent');
    founderId = agent.id;
  });

  describe('createGroup', () => {
    it('should create a new group with required fields', async () => {
      const group = await createGroup(
        GroupType.HOUSES,
        founderId,
        'Gryffindor'
      );

      expect(group).not.toBeNull();
      expect(group?.type).toBe(GroupType.HOUSES);
      expect(group?.name).toBe('Gryffindor');
      expect(group?.founderId).toBe(founderId);
      expect(group?.visibility).toBe('public');
      expect(group?.settings).toEqual({});
    });

    it('should create a group with optional fields', async () => {
      const group = await createGroup(
        GroupType.HOUSES,
        founderId,
        'Slytherin',
        'Cunning and ambitious',
        'https://example.com/slytherin.png',
        { color: 'green' },
        'private'
      );

      expect(group).not.toBeNull();
      expect(group?.description).toBe('Cunning and ambitious');
      expect(group?.avatarUrl).toBe('https://example.com/slytherin.png');
      expect(group?.settings).toEqual({ color: 'green' });
      expect(group?.visibility).toBe('private');
    });

    it('should return null if name is too long', async () => {
      const longName = 'a'.repeat(129);
      const group = await createGroup(GroupType.HOUSES, founderId, longName);
      expect(group).toBeNull();
    });

    it('should return null if founder does not exist', async () => {
      const group = await createGroup(GroupType.HOUSES, 'invalid-founder-id', 'Test House');
      expect(group).toBeNull();
    });

    it('should return null for duplicate name within same type', async () => {
      await createGroup(GroupType.HOUSES, founderId, 'Hufflepuff');
      const duplicate = await createGroup(GroupType.HOUSES, founderId, 'Hufflepuff');
      expect(duplicate).toBeNull();
    });
  });

  describe('getGroup', () => {
    it('should retrieve a group by id and type', async () => {
      const created = await createGroup(GroupType.HOUSES, founderId, 'Ravenclaw');
      const retrieved = await getGroup(GroupType.HOUSES, created!.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created!.id);
      expect(retrieved?.name).toBe('Ravenclaw');
    });

    it('should return null if type does not match', async () => {
      const created = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const retrieved = await getGroup('clans' as any, created!.id);
      expect(retrieved).toBeNull();
    });

    it('should return null if id does not exist', async () => {
      const retrieved = await getGroup(GroupType.HOUSES, 'nonexistent-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('getGroupByName', () => {
    it('should retrieve a group by name (case-insensitive)', async () => {
      await createGroup(GroupType.HOUSES, founderId, 'Gryffindor');

      const lowerCase = await getGroupByName(GroupType.HOUSES, 'gryffindor');
      const upperCase = await getGroupByName(GroupType.HOUSES, 'GRYFFINDOR');
      const mixedCase = await getGroupByName(GroupType.HOUSES, 'GrYfFiNdOr');

      expect(lowerCase).not.toBeNull();
      expect(upperCase).not.toBeNull();
      expect(mixedCase).not.toBeNull();
      expect(lowerCase?.name).toBe('Gryffindor');
    });

    it('should return null if name does not exist', async () => {
      const retrieved = await getGroupByName(GroupType.HOUSES, 'Nonexistent House');
      expect(retrieved).toBeNull();
    });
  });

  describe('listGroups', () => {
    beforeEach(async () => {
      // Create multiple groups
      await createGroup(GroupType.HOUSES, founderId, 'Zebra House');
      await createGroup(GroupType.HOUSES, founderId, 'Alpha House');
      await createGroup(GroupType.HOUSES, founderId, 'Beta House');
    });

    it('should list groups sorted by name', async () => {
      const groups = await listGroups(GroupType.HOUSES, 'name');

      expect(groups.length).toBeGreaterThanOrEqual(3);
      const names = groups.map(g => g.name);
      const sortedNames = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      expect(names).toEqual(sortedNames);
    });

    it('should list groups sorted by recent creation', async () => {
      const groups = await listGroups(GroupType.HOUSES, 'recent');

      expect(groups.length).toBeGreaterThanOrEqual(3);
      // Most recent should be first
      const timestamps = groups.map(g => new Date(g.createdAt).getTime());
      for (let i = 0; i < timestamps.length - 1; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
      }
    });

    it('should return max 100 results', async () => {
      const groups = await listGroups(GroupType.HOUSES);
      expect(groups.length).toBeLessThanOrEqual(100);
    });

    it('should filter by type', async () => {
      const groups = await listGroups(GroupType.HOUSES);
      groups.forEach(group => {
        expect(group.type).toBe(GroupType.HOUSES);
      });
    });
  });

  describe('updateGroup', () => {
    it('should update group name', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Old Name');
      const updated = await updateGroup(GroupType.HOUSES, group!.id, { name: 'New Name' });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('New Name');
    });

    it('should update group description', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const updated = await updateGroup(GroupType.HOUSES, group!.id, {
        description: 'Updated description',
      });

      expect(updated?.description).toBe('Updated description');
    });

    it('should update group settings', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const updated = await updateGroup(GroupType.HOUSES, group!.id, {
        settings: { theme: 'dark' },
      });

      expect(updated?.settings).toEqual({ theme: 'dark' });
    });

    it('should return null if group does not exist', async () => {
      const updated = await updateGroup(GroupType.HOUSES, 'nonexistent-id', {
        name: 'New Name',
      });
      expect(updated).toBeNull();
    });

    it('should return null if type does not match', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const updated = await updateGroup('clans' as any, group!.id, { name: 'New Name' });
      expect(updated).toBeNull();
    });

    it('should return null if new name is too long', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const longName = 'a'.repeat(129);
      const updated = await updateGroup(GroupType.HOUSES, group!.id, { name: longName });
      expect(updated).toBeNull();
    });
  });

  describe('deleteGroup', () => {
    it('should delete a group', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'To Delete');
      const deleted = await deleteGroup(GroupType.HOUSES, group!.id);

      expect(deleted).toBe(true);

      const retrieved = await getGroup(GroupType.HOUSES, group!.id);
      expect(retrieved).toBeNull();
    });

    it('should return false if group does not exist', async () => {
      const deleted = await deleteGroup(GroupType.HOUSES, 'nonexistent-id');
      expect(deleted).toBe(false);
    });

    it('should return false if type does not match', async () => {
      const group = await createGroup(GroupType.HOUSES, founderId, 'Test House');
      const deleted = await deleteGroup('clans' as any, group!.id);
      expect(deleted).toBe(false);
    });
  });

  describe('Type discrimination', () => {
    it('should filter operations by type parameter', async () => {
      const house = await createGroup(GroupType.HOUSES, founderId, 'Test House');

      // Should find with correct type
      const foundHouse = await getGroup(GroupType.HOUSES, house!.id);
      expect(foundHouse).not.toBeNull();

      // Should not find with wrong type
      const notFound = await getGroup('clans' as any, house!.id);
      expect(notFound).toBeNull();
    });
  });
});
