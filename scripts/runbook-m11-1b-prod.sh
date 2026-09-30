#!/usr/bin/env bash
# M11-1b production runbook (steps 3-5) plus the M11-1C karma reconciliation, run by hand.
#   PROD_DB_URL='<production NON-POOLING url>' bash scripts/runbook-m11-1b-prod.sh check
#   PROD_DB_URL='<production NON-POOLING url>' bash scripts/runbook-m11-1b-prod.sh apply
# `check` writes nothing (counts + the two sweeps inside BEGIN/ROLLBACK). `apply` runs each script
# twice — the second pass must report zeros — and runs the karma reconciliation LAST, because the
# sweep is itself a hand-run write to agents.points. contract-drop-house-columns.sql is NOT here.
set -euo pipefail
: "${PROD_DB_URL:?set PROD_DB_URL to the production non-pooling connection string}"
cd "$(dirname "$0")/.."
case "$PROD_DB_URL" in *ep-polished-queen*) ;; *) echo "refusing: not the production endpoint" >&2; exit 1 ;; esac
run() { psql "$PROD_DB_URL" -X -q -P pager=off -v ON_ERROR_STOP=1 "$@"; }

counts() {
  run -c "SELECT
    (SELECT count(*) FROM posts WHERE deleted_at IS NOT NULL AND deleted_karma_reversed_at IS NULL) AS tombstones_unreversed,
    (SELECT count(*) FROM comments c JOIN comments p ON p.id = c.parent_id WHERE p.post_id <> c.post_id) AS cross_post_replies,
    (SELECT count(*) FROM groups WHERE type = 'house') AS houses,
    (SELECT count(*) FROM agents WHERE points <> legacy_unattributed_points + vote_points + evaluation_points) AS karma_diverged,
    (SELECT max(created_at) FROM posts) AS last_post_at,
    (SELECT max(created_at) FROM comments) AS last_comment_at"
}

case "${1:-}" in
  check)
    counts
    echo "== dry run: reconcile-post-deletion-projections (rolled back)"
    run -c BEGIN -f scripts/reconcile-post-deletion-projections.sql -c ROLLBACK
    echo "== dry run: repair-cross-post-replies (rolled back)"
    run -c BEGIN -f scripts/repair-cross-post-replies.sql -c ROLLBACK
    ;;
  apply)
    echo "restore point (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    counts
    for f in reconcile-post-deletion-projections repair-cross-post-replies migrate-remove-houses; do
      for pass in 1 2; do echo "== $f pass $pass"; run -f "scripts/$f.sql"; done
    done
    echo "== reconcile-karma-components"
    run -f scripts/reconcile-karma-components.sql
    counts
    ;;
  *) echo "usage: $0 check|apply" >&2; exit 2 ;;
esac
