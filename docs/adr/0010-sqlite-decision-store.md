# ADR-0010: SQLite decision store

Status: accepted (2026-11-12)

## Context

Decision, outcome and usage records need durable storage for statistics and precedent. The
previous JSONL implementation read and parsed the full log synchronously on the event loop. A
full read took about 0.6 s at 100,000 records, 7 s at 1 million, and 34 s with near-out-of-memory
use at 4 million. The append-only format also had no mutable rows for future label corrections.
Precedent rebuilding read as much as 90 days of history even when the configured policy window
was shorter.

## Options considered

- **JSONL with bounded windows and a worker.** Moves heavy reads off the event loop, but retains
  append-only records and requires custom indexing and query logic.
- **`node:sqlite`.** Built into the supported Node runtime, transactional, queryable and supports
  mutable rows without a separate native dependency.
- **DuckDB.** Strong analytical queries, but adds a 96 MB native binary for this local service.
- **LMDB, LevelDB or RocksDB.** Native key-value stores; querying related decision, outcome and
  usage rows would still require application-managed indexes and joins.
- **PGlite.** Embedded PostgreSQL compatibility, but adds a 26 MB WASM payload.

## Decision

- Use `node:sqlite` as the only durable store for decisions, outcomes and usage, at
  `~/.local/share/local-decider/decider.db`. There is no JSONL backend or fallback. No migration
  is provided because there are no existing users whose records need importing.
- Use SQLite WAL mode for concurrent readers and the gateway writer. A pid lock at
  `<run>/db.lock` allows one gateway writer per data directory. Read-only CLI operations use
  read-only handles; stats run in a worker with its own read-only connection.
- Query only the largest configured `precedent.maxAgeDays` window. Rebuild precedent at startup,
  and skip a policy reload rebuild when precedent settings have not changed.
- Keep incremental auto-vacuum enabled, including for existing database files.
- Use SQLite's `user_version` for schema migrations. Backups use `VACUUM INTO`; JSONL is only an
  export format (`logs export`), not the live store.

## Consequences

- Node 24.15 or newer is required for the built-in SQLite API.
- The SQLite API is synchronous, so heavy statistics reads run in a worker thread with a 30 s
  timeout. A timed-out stats request returns 503.
- Database files use mode 0600 inside a mode 0700 data directory. The database stores hashes and
  structured decision metadata, not prompt or subject text; SQLite does not encrypt data at rest.
- SQLite permits mutable rows, so future label corrections can update existing records.
- There is one writer per data directory; readers can use independent read-only connections.
- Schema changes go through migrations tracked by `PRAGMA user_version`.
- Backups are SQLite snapshots. JSONL exports provide a portable interchange format.
