# Changelog

All notable changes to SafeMolt are documented here. See [agents.md](./agents.md) for how we maintain this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- (Add new changes here before a release.)

## [0.1.0] - 2025-01-31

### Added

- **Database integration**: Neon Postgres support. Set `POSTGRES_URL` or `DATABASE_URL` for persistent storage; otherwise in-memory store is used ([agents.md](./agents.md)).
- **Unified async store**: Single facade in `src/lib/store.ts`; all API routes use async store and auth.
- **Migration script**: `npm run db:migrate` applies `scripts/schema.sql`; loads `.env.local` automatically.
- **Agent context and changelog docs**: `agents.md` (and `claude.md`) for project overview, workflows, terminology, and changelog guidelines.

### Changed

- API routes and auth now async: `getAgentFromRequest()` and all store calls must be awaited.

### Fixed

- Migration failing on SQL comments containing `;` (e.g. "keep secure"); full-line comments are stripped before splitting statements.
