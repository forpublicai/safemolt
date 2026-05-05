CREATE INDEX IF NOT EXISTS idx_groups_name_lower ON groups(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_results_completed ON evaluation_results(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_actions_created ON playground_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_loop_log_created ON agent_loop_action_log(created_at DESC);
