/**
 * TypeScript types for the Evaluations system
 */

export interface EvaluationFrontmatter {
  sip: number;
  id: string;
  name: string;
  module: string;
  type: 'simple_pass_fail' | 'complex_benchmark' | 'live_class_work' | 'proctored' | 'agent_certification';
  status: 'active' | 'draft' | 'deprecated';
  prerequisites?: string[]; // Array of evaluation IDs
  author: string;
  created_at: string;
  updated_at: string;
  version: string;
  points?: number; // Points awarded for passing (default: 0)
  config?: Record<string, unknown>;
  executable: {
    handler: string; // Handler function name (e.g., "poaw_handler")
    script_path: string; // Path to executable script
  };
}

export interface EvaluationDefinition extends EvaluationFrontmatter {
  file_path: string; // Path to .md file
  content: string; // Markdown content (without frontmatter)
}

export interface EvaluationContext {
  agentId: string;
  evaluationId: string;
  registrationId: string;
  input: unknown; // Submission data from agent
  config?: Record<string, unknown>; // From evaluation definition
}

export interface EvaluationResult {
  passed: boolean;
  score?: number; // Optional score (for benchmarks)
  maxScore?: number; // Optional max score
  resultData?: Record<string, unknown>; // Detailed results
  error?: string; // Error message if failed
}

export interface EvaluationRegistration {
  id: string;
  agentId: string;
  evaluationId: string;
  registeredAt: string;
  status: 'registered' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
}

export interface StoredEvaluationResult {
  id: string;
  registrationId: string;
  agentId: string;
  evaluationId: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number; // Points earned for this result (null if failed)
  resultData?: Record<string, unknown>;
  completedAt: string;
  proctorAgentId?: string;
  proctorFeedback?: string;
}

export interface EvaluationListItem {
  id: string;
  sip: number;
  name: string;
  description: string;
  module: string;
  type: string;
  status: string;
  prerequisites: string[];
  registrationStatus?: 'available' | 'registered' | 'in_progress' | 'completed' | 'prerequisites_not_met';
  hasPassed?: boolean;
  canRegister: boolean;
}

// ============================================
// Agent Certification Types
// ============================================

export interface CertificationPrompt {
  id: string;
  text: string;
  category?: string;
}

export interface RubricCriteria {
  promptId: string;
  criteria: string;
  weight: number;
  maxScore: number;
}

export interface CertificationConfig {
  prompts: CertificationPrompt[];
  rubric: RubricCriteria[];
  passingScore: number;
  judgeModelId?: string; // e.g., "gpt-4o", "claude-3-opus"
  nonceValidityMinutes?: number; // default 30
}

export type CertificationJobStatus = 'pending' | 'submitted' | 'judging' | 'completed' | 'failed' | 'expired';

export interface CertificationJob {
  id: string;
  registrationId: string;
  agentId: string;
  evaluationId: string;
  nonce: string;
  nonceExpiresAt: string;
  transcript?: TranscriptEntry[];
  status: CertificationJobStatus;
  submittedAt?: string;
  judgeStartedAt?: string;
  judgeCompletedAt?: string;
  judgeModel?: string;
  judgeResponse?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
}

export interface TranscriptEntry {
  promptId: string;
  prompt: string;
  response: string;
  toolCalls?: unknown[]; // optional
}

export interface JudgeScoreEntry {
  promptId: string;
  score: number;
  maxScore: number;
  feedback: string;
}

export interface JudgeResponse {
  scores: JudgeScoreEntry[];
  totalScore: number;
  maxScore: number;
  passed: boolean;
  summary: string;
}
