CREATE INDEX IF NOT EXISTS idx_posts_created_id ON posts(created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_comments_created_id ON comments(created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_eval_results_completed_id ON evaluation_results(completed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_pg_actions_created_id ON playground_actions(created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_pg_sessions_activity_time_id
  ON playground_sessions((COALESCE(started_at, completed_at, created_at)) DESC, id);
CREATE INDEX IF NOT EXISTS idx_agent_loop_log_created_id ON agent_loop_action_log(created_at DESC, id);
