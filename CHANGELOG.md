# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (hippocampus plugin)

- Leveled file logging under `.hippocampus/logs/<YYYY-MM-DD>.log` — one line per event: `ISO timestamp LEVEL [scope] message` (messages truncated to 2000 chars, newlines flattened).
- New config keys in `.hippocampus/hippocampus.json`: `logLevel` (`"trace" | "debug" | "info" | "warn" | "error"`, default `"error"` — only events at or above the selected level are written) and `maxLogBytes` (default 10 MiB, size cap for the logs dir).
- Env override: `HIPPO_LOG_LEVEL=trace|debug|info|warn|error`; legacy `HIPPO_DEBUG=1` still works and means `debug`.
- Log events added at key points: plugin start (`info`), context-window eviction decisions (`debug`, unit counts + token/cap stats), tool-output capture for stubbing (`trace`), prune deletions (`info`), all error paths (`error`).

### Changed (hippocampus plugin)

- Errors and prune notes no longer go to `.hippocampus/errors.log`; everything is leveled into `.hippocampus/logs/`. `errors.log` stays in the gitignore list for legacy installs.
- The logs dir is pruned alongside raw/recall: age (`retentionDays`) + size (`maxLogBytes`), newest file never deleted.

## [1.0.0] - 2026-10-01

### Added

- Core memory: self-editable `## LABEL` blocks in `.opencode/letta/core-memory.md`, compiled into the system prompt every turn ("LETTA MEMORY LAYER" block, appended after existing system content); per-block (4000 chars), total-size (`maxCoreMemoryChars`) and block-count (`maxCoreBlocks`) caps.
- memfs: agent-managed note files under `.opencode/letta/memfs/` with `letta_memfs_read` / `letta_memfs_list` / `letta_memfs_write` tools, table of contents injected into the system block; per-file, file-count and total-size caps.
- Recall: append-only per-session JSONL history (`.opencode/letta/recall/<session>.jsonl`) of user text, assistant text and tool calls with args + outputs (truncated to 1024 / 4096 chars); `letta_recall_search` — streaming case-insensitive substring search with a 200k-line scan cap.
- Lossless context window: on budget overrun old conversation units are archived verbatim into `.ai-context/<session>.md` and replaced in the live request by offload markers (`u_<id>`) and tool-output stubs; `letta_context_lookup` reads segments, full tool outputs or the archive TOC back.
- Chat attachments (png/jpeg/webp/gif/svg+xml/pdf, ≤ 8 MiB) archived under `.opencode/letta/attachments/`, named by sha256 prefix.
- Audit log `.opencode/letta/memory-audit.log`: one JSON line per accepted/refused memory write with SHA-256 hashes of old/new content and char count — never the content itself.
- Kill switches: `LETTA_DISABLE=1` env var or `"enabled": false` in `.opencode/context-window.json`; plugin refuses to run when the worktree is `$HOME` or the filesystem root; `LETTA_DEBUG=1` mirrors errors to stderr.
- Retention: age-based (`retentionDays`, default 90 d) and size-based (`maxRecallBytes` 20 MiB, `maxArchiveBytes` 100 MiB) pruning of recall and archive files; the newest file in each pruned directory is never deleted; deletions logged.
- Optional user config `.opencode/context-window.json`: all keys optional, per-key validation with silent fallback to defaults (including explicit `contextLimit`).

### Changed

- All file writes are atomic: temp file + rename, with tmp cleanup on failure — no half-written files on crash.
- Archive appends are serialized per session file through a write queue — concurrent turns can no longer interleave partial JSONL/markdown lines.
- Sticky eviction with hysteresis (`evictHysteresis`, default 0.7): when over budget the window shrinks down to `budget × 0.7` and never re-inflates on later turns — stable prompt-cache prefix, no flapping at the budget edge.
- Eviction keeps at least `minKeepTurns` completed turns plus the active turn (tier-1 bound).

### Security

- Secret redaction before anything hits disk (`redactSecrets`, default on): bounded regexes with no unbounded quantifiers covering PEM private-key blocks, `sk-…`, GitHub (`ghp_`/`gho_`/`ghu_`/`ghs_`/`github_pat_`), AWS (`AKIA…`), Slack (`xox[baprs]-…`), Google (`AIza…`) token prefixes, `Bearer <token>`, JWTs, `Authorization: Basic …` values, GitLab/npm/HuggingFace/Stripe provider prefixes, quoted sensitive keys and env-style `KEY=VALUE`; only the first 1 MiB of each string is scanned.
- Untrusted-tool guard (prompt-injection defense): after a tool matching `untrustedTools` (default webfetch/websearch/fetch/browser) runs, the session cannot write core memory or memfs until the next user message; fails closed when no session id is available.
- Protected core-memory blocks (`protectedBlocks`, default PERSONA) are immutable from tools — only manual file edits modify them.
- Sensitive files (`.env*`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `credentials(.json)` by basename, case-insensitive) read via the `read` tool are recorded in recall as metadata only and withheld from the archive.
- Path safety: memfs and `.ai-context` lookups reject absolute paths, drive letters, backslashes, `..` and null bytes; symlinks are resolved and must stay inside the target directory (case-insensitive on win32).

### Fixed

- Eviction no longer drops conversation units whose messages have not been written to the archive yet: the per-session-file written-set check exempts only legacy units.
- `letta_recall_search` streams line-by-line with a scan cap instead of loading whole history files into memory.
- Secret redaction uses bounded patterns (no catastrophic backtracking) and stops scanning after 1 MiB per string.
- Session state without a session id no longer leaks into shared module maps; capture cleanup timers are cancelled and tracked per session.
