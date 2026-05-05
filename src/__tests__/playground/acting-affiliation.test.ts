/**
 * @jest-environment node
 */

import {
  sanitizeActingLabel,
  sanitizeActingCompanyId,
  buildActingDisplaySummary,
  mergeAffiliationIntoParticipant,
} from '@/lib/playground/acting-affiliation';
import { formatParticipantGmRosterLine } from '@/lib/playground/engine';
import type { SessionParticipant } from '@/lib/playground/types';

describe('acting-affiliation sanitizers', () => {
  it('truncates overly long labels', () => {
    const long = 'x'.repeat(250);
    expect(sanitizeActingLabel(long)?.length).toBe(200);
  });

  it('rejects acting company ids with unsafe characters', () => {
    expect(sanitizeActingCompanyId('moiraine labs')).toBeUndefined();
    expect(sanitizeActingCompanyId('moiraine@x')).toBeUndefined();
    expect(sanitizeActingCompanyId('valid-id_01')).toBe('valid-id_01');
  });
});

describe('buildActingDisplaySummary', () => {
  it('shows indexed name plus supplemental label when both present', async () => {
    const s = await buildActingDisplaySummary({
      getAoCompany: async (id: string) =>
        id === 'c1'
          ? { id: 'c1', name: 'Moiraine Labs' }
          : null,
      actingAsCompanyId: 'c1',
      actingAsLabel: 'Observer seat',
    });
    expect(s).toContain('Moiraine Labs');
    expect(s).toContain('c1');
    expect(s).toContain('also claims: Observer seat');
  });

  it('notes unknown ids in AO index', async () => {
    const s = await buildActingDisplaySummary({
      getAoCompany: async () => null,
      actingAsCompanyId: 'unknown_co',
      actingAsLabel: undefined,
    });
    expect(s).toContain('not in SafeMolt AO index');
    expect(s).toContain('unknown_co');
  });
});

describe('mergeAffiliationIntoParticipant', () => {
  it('fills empty fields only', () => {
    const existing: SessionParticipant = {
      agentId: 'a1',
      agentName: 'Ada',
      status: 'active',
      actingAsCompanyId: 'c0',
    };
    const { next, changed } = mergeAffiliationIntoParticipant(existing, {
      actingAsCompanyId: 'c1',
      actingAsLabel: 'Guild',
      actingAsDisplaySummary: 'summary',
    });
    expect(changed).toBe(true);
    expect(next.actingAsCompanyId).toBe('c0');
    expect(next.actingAsLabel).toBe('Guild');
    expect(next.actingAsDisplaySummary).toBe('summary');
  });
});

describe('formatParticipantGmRosterLine', () => {
  it('includes unverified claims when display summary present', () => {
    const line = formatParticipantGmRosterLine({
      agentId: 'a',
      agentName: 'Ada',
      status: 'active',
      prefabId: 'the_diplomat',
      actingAsDisplaySummary: 'Industry guild',
    });
    expect(line).toContain('Ada');
    expect(line).toContain('The Diplomat');
    expect(line).toContain('claims representing: Industry guild');
  });
});
