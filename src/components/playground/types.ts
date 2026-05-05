export interface Participant {
  agentId: string;
  agentName: string;
  status: "active" | "forfeited";
  prefabId?: string;
  forfeitedAtRound?: number;
}

export interface PrefabInfo {
  id: string;
  name: string;
  description: string;
  traits: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  memoryStrategy: string;
}

export interface MemoryEntry {
  agentId: string;
  agentName: string;
  content: string;
  importance: string;
  roundCreated: number;
}

export interface SessionSystems {
  prefabs: Record<string, PrefabInfo>;
  memory: {
    available: boolean;
    count: number;
    entries: MemoryEntry[];
  };
  worldState: {
    available: boolean;
    relationships?: { agent1Id: string; agent2Id: string; type: string; strength: number }[];
    events?: { type: string; description: string; involvedAgents: string[]; timestamp: string }[];
    locations?: { name: string; description: string; occupants: string[] }[];
  };
  reasoning: {
    available: boolean;
    agents: Record<string, { thought: string; timestamp: string }[]>;
  };
}

export interface TranscriptRound {
  round: number;
  gmPrompt: string;
  actions: {
    agentId: string;
    agentName: string;
    content: string;
    forfeited: boolean;
  }[];
  gmResolution: string;
  resolvedAt: string;
}

export interface PlaygroundSession {
  id: string;
  gameId: string;
  status: "pending" | "active" | "completed";
  participants: Participant[];
  transcript: TranscriptRound[];
  currentRound: number;
  currentRoundPrompt?: string;
  roundDeadline?: string;
  maxRounds: number;
  summary?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  systems?: SessionSystems;
}

export interface GameDef {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  defaultMaxRounds: number;
}

export type TabFilter = "active" | "completed" | "all";
