/**
 * @jest-environment node
 */

jest.mock('@/lib/auth', () => ({
  getAgentFromRequest: jest.fn(),
  jsonResponse: (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(data, { status, headers }),
  errorResponse: (error: string, hint?: string, status = 400) =>
    Response.json({ success: false, error, hint }, { status }),
}));

jest.mock('@/lib/playground/session-manager', () => ({
  checkDeadlines: jest.fn(),
  getActiveSession: jest.fn(),
}));

jest.mock('@/lib/store', () => ({
  listPlaygroundSessions: jest.fn(),
  getPlaygroundSession: jest.fn(),
  getPlaygroundActions: jest.fn(),
}));

import { GET as getActiveRoute } from '@/app/api/v1/playground/sessions/active/route';
import { GET as getSessionsRoute } from '@/app/api/v1/playground/sessions/route';
import { GET as getSessionByIdRoute } from '@/app/api/v1/playground/sessions/[id]/route';

const { getAgentFromRequest } = require('@/lib/auth');
const { checkDeadlines, getActiveSession } = require('@/lib/playground/session-manager');
const { listPlaygroundSessions, getPlaygroundSession, getPlaygroundActions } = require('@/lib/store');

describe('Playground session GET routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkDeadlines.mockResolvedValue(undefined);
  });

  describe('GET /api/v1/playground/sessions/active', () => {
    it('returns 401 when Authorization is missing or invalid', async () => {
      getAgentFromRequest.mockResolvedValue(null);

      const response = await getActiveRoute(new Request('http://localhost/api/v1/playground/sessions/active'));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unauthorized');
      expect(getActiveSession).not.toHaveBeenCalled();
    });

    it('returns no session payload when agent has no active or pending session', async () => {
      getAgentFromRequest.mockResolvedValue({ id: 'agent_1' });
      getActiveSession.mockResolvedValue(null);

      const response = await getActiveRoute(new Request('http://localhost/api/v1/playground/sessions/active'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
      expect(body.poll_interval_ms).toBe(60000);
      expect(checkDeadlines).toHaveBeenCalledTimes(1);
      expect(getActiveSession).toHaveBeenCalledWith('agent_1');
    });

    it('returns pending lobby payload when only pending session exists', async () => {
      getAgentFromRequest.mockResolvedValue({ id: 'agent_1' });
      getActiveSession.mockResolvedValue({
        needsAction: false,
        isPending: true,
        currentPrompt: 'A lobby is waiting for players.',
        session: {
          id: 'pg_pending',
          gameId: 'tennis',
          status: 'pending',
          currentRound: 0,
          maxRounds: 6,
          transcript: [],
          participants: [],
        },
      });

      const response = await getActiveRoute(new Request('http://localhost/api/v1/playground/sessions/active'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).not.toBeNull();
      expect(body.data.session_id).toBe('pg_pending');
      expect(body.data.game_id).toBe('tennis');
      expect(body.data.is_pending).toBe(true);
      expect(body.data.needs_action).toBe(false);
      expect(body.poll_interval_ms).toBe(60000);
    });

    it('returns action-needed payload in snake_case fields', async () => {
      getAgentFromRequest.mockResolvedValue({ id: 'agent_1' });
      getActiveSession.mockResolvedValue({
        needsAction: true,
        currentPrompt: 'You must decide now.',
        needsActionSince: '2026-02-24T00:00:00.000Z',
        session: {
          id: 'pg_1',
          gameId: 'prisoners-dilemma',
          status: 'active',
          currentRound: 2,
          maxRounds: 4,
          roundDeadline: '2026-02-24T01:00:00.000Z',
          transcript: [],
          participants: [
            { agentId: 'agent_1', agentName: 'Alpha', status: 'active' },
            { agentId: 'agent_2', agentName: 'Beta', status: 'active' },
          ],
        },
      });

      const response = await getActiveRoute(new Request('http://localhost/api/v1/playground/sessions/active'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.poll_interval_ms).toBe(30000);
      expect(body.data.session_id).toBe('pg_1');
      expect(body.data.game_id).toBe('prisoners-dilemma');
      expect(body.data.needs_action).toBe(true);
      expect(body.data.current_prompt).toBe('You must decide now.');
      expect(body.data.round_duration_sec).toBe(3600);
      expect(body.data.participants[0]).toEqual({
        agent_id: 'agent_1',
        agent_name: 'Alpha',
        status: 'active',
      });
    });
  });

  describe('GET /api/v1/playground/sessions', () => {
    it('returns 400 for invalid status filter', async () => {
      const response = await getSessionsRoute(
        new Request('http://localhost/api/v1/playground/sessions?status=unknown')
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid status');
      expect(listPlaygroundSessions).not.toHaveBeenCalled();
    });

    it('lists sessions with clamped paging and status filter', async () => {
      listPlaygroundSessions.mockResolvedValue([
        {
          id: 'pg_1',
          gameId: 'pub-debate',
          status: 'active',
          currentRound: 1,
          maxRounds: 5,
          participants: [],
          summary: undefined,
          createdAt: '2026-02-24T00:00:00.000Z',
          startedAt: '2026-02-24T00:01:00.000Z',
          completedAt: undefined,
        },
      ]);

      const response = await getSessionsRoute(
        new Request('http://localhost/api/v1/playground/sessions?status=active&limit=500&offset=-5')
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(checkDeadlines).toHaveBeenCalledTimes(1);
      expect(listPlaygroundSessions).toHaveBeenCalledWith({
        status: 'active',
        limit: 50,
        offset: 0,
      });
      expect(body.success).toBe(true);
      expect(body.data[0]).toMatchObject({
        id: 'pg_1',
        gameId: 'pub-debate',
        status: 'active',
      });
    });
  });

  describe('GET /api/v1/playground/sessions/[id]', () => {
    it('returns 404 when session does not exist', async () => {
      getPlaygroundSession.mockResolvedValue(null);

      const response = await getSessionByIdRoute(
        new Request('http://localhost/api/v1/playground/sessions/pg_missing'),
        { params: Promise.resolve({ id: 'pg_missing' }) }
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Session not found');
    });

    it('appends current round actions for active session', async () => {
      getPlaygroundSession.mockResolvedValue({
        id: 'pg_2',
        gameId: 'trade-bazaar',
        status: 'active',
        currentRound: 3,
        maxRounds: 6,
        currentRoundPrompt: 'Negotiate your next trade.',
        roundDeadline: '2026-02-24T10:00:00.000Z',
        participants: [
          { agentId: 'agent_1', agentName: 'Alpha', status: 'active' },
        ],
        transcript: [
          {
            round: 1,
            gmPrompt: 'Round 1',
            actions: [],
            gmResolution: 'Resolved',
            resolvedAt: '2026-02-24T08:00:00.000Z',
          },
        ],
        createdAt: '2026-02-24T07:00:00.000Z',
        startedAt: '2026-02-24T07:01:00.000Z',
      });
      getPlaygroundActions.mockResolvedValue([
        {
          id: 'act_1',
          sessionId: 'pg_2',
          round: 3,
          agentId: 'agent_1',
          content: 'I offer 2 mana crystals.',
          createdAt: '2026-02-24T09:00:00.000Z',
        },
      ]);

      const response = await getSessionByIdRoute(
        new Request('http://localhost/api/v1/playground/sessions/pg_2'),
        { params: Promise.resolve({ id: 'pg_2' }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(checkDeadlines).toHaveBeenCalledTimes(1);
      expect(getPlaygroundActions).toHaveBeenCalledWith('pg_2', 3);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('pg_2');
      expect(body.data.transcript).toHaveLength(2);
      expect(body.data.transcript[1]).toMatchObject({
        round: 3,
        gmPrompt: 'Negotiate your next trade.',
      });
      expect(body.data.transcript[1].actions[0]).toMatchObject({
        agentId: 'agent_1',
        agentName: 'Alpha',
        content: 'I offer 2 mana crystals.',
      });
    });
  });
});
