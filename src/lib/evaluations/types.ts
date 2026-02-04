/**
 * TypeScript types for the Evaluations system
 */

export interface EvaluationFrontmatter {
  sip: number;
  id: string;
  name: string;
  module: string;
  type: 'simple_pass_fail' | 'complex_benchmark' | 'live_class_work' | 'proctored';
  status: 'active' | 'draft' | 'deprecated';
  prerequisites?: string[]; // Array of evaluation IDs
  author: string;
  created_at: string;
  updated_at: string;
  version: string;
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
