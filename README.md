# hippocampus — persistent memory + lossless context window for opencode

A single-file TypeScript plugin (`hippocampus/hippocampus.ts`) that gives an agent in an opencode project **tiered persistent memory (T0–T3)** and a **lossless sliding context window**. No runtime dependencies: `node:` builtins (including `node:sqlite` FTS5) plus the `@opencode/plugin` v2 API, which opencode provides at load time.

## What it does

- **Lossless context window** — on token-budget overrun, old conversation units are archived verbatim to `.hippocampus/raw/<session>.md` and replaced in the live request by offload markers (`[offloaded → …#u_<id> — "hint"]`) and tool-output stubs. Nothing is summarized; the model retrieves any segment byte-for-byte via `grep`/`sed`, or through the tools below.
- **T0 core memory** — `.hippocampus/core-memory.md`: self-editable `## LABEL` blocks (default: PERSONA, HUMAN), compiled into a "HIPPOCAMPUS MEMORY LAYER" block appended to the system prompt every turn; rewritten with `hippo_memory_edit`, effective from the next turn.
- **T1 memfs** — agent-managed note files under `.hippocampus/memfs/` (durable facts, decisions, preferences) with per-file / file-count / total-size caps and TTL pruning. A table of contents is injected into the system block.
- **T2 wiki** — typed knowledge pages (YAML frontmatter: title/type/description/sources) under `.hippocampus/wiki/` plus an FTS5 index (`wiki/index.db`) for ranked search with 1-hop wikilink expansion.
- **T3 archive** — cold storage `memfs/archive/`; not listed, found by grep only.
- **Recall** — append-only per-session JSONL history (`.hippocampus/recall/<session>.jsonl`): user text, assistant text, tool calls with args + outputs; case-insensitive substring search with a scan cap (`hippo_recall_search`).
- **Checkpoints** — periodic verbatim session snapshots under `.hippocampus/checkpoints/`.
- **Attachments** — user media (base64) archived by sha256 name under `.hippocampus/attachments/`; the model sees a short text ref instead of raw bytes.
- **Secret redaction** — secrets in tool outputs are redacted before anything is written to disk (`redactSecrets`).

## Install

Copy or symlink the single file into opencode's global plugin directory, then restart opencode:

    cp hippocampus/hippocampus.ts ~/.config/opencode/plugin/
    # or: ln -s "$PWD/hippocampus/hippocampus.ts" ~/.config/opencode/plugin/

The plugin is per-worktree: all data lives under `.hippocampus/` in each project root, and on first run the required entries are appended to the project's `.gitignore`. The worktree must not be `$HOME` or the filesystem root.

## Tools

| Tool | Purpose |
|---|---|
| `hippo_memory_edit` | Replace a core-memory block (T0) by label |
| `hippo_memfs_read` / `hippo_memfs_list` / `hippo_memfs_write` | Read / list / write T1 note files |
| `hippo_wiki_read` / `hippo_wiki_search` / `hippo_wiki_write` | Read / FTS5-search / create-or-overwrite T2 wiki pages |
| `hippo_recall_search` | Substring search over all past conversation history (T3 recall JSONL) |
| `hippo_lookup` | Pull back offloaded segments, full tool outputs or the archive TOC from `.hippocampus/raw/` |
| `hippo_consolidate` | Run memory consolidation now: dedup wiki pages, archive expired pages |

## Where data lives

    <worktree>/.hippocampus/
      core-memory.md          T0 self-editable blocks (tracked)
      hippocampus.json        per-project config (37 keys; gitignored)
      memfs/                  T1 agent notes (gitignored) + archive/ (T3 cold)
      wiki/                   T2 typed pages (tracked) + index.db (gitignored)
      recall/<session>.jsonl  append-only history (gitignored)
      raw/<session>.md        verbatim offload archive, self-indexing ## u_ headers (gitignored)
      checkpoints/            periodic session snapshots (gitignored)
      attachments/            user media by sha256 name (gitignored)
      logs/                   leveled plugin log (gitignored)
      memory-audit.log        one JSON line per accepted/refused memory write, hashes only

## Configuration

Per-project config file: `.hippocampus/hippocampus.json` — 37 keys with defaults; the auto-generated reference is [docs/config-reference.md](./docs/config-reference.md). The file self-heals on load (missing/incomplete files are rewritten with all keys visible and editable).

- Kill switch: `"enabled": false`.
- Log level: `logLevel` key (`trace|debug|info|warn|error`, default `error`) — logs go to `.hippocampus/logs/`.
- Budgets: `capRatio` (eviction threshold vs. model window), `hysteresis` (anti-flap eviction target), `maxUnitTokens`, `freshTurns`, `markerBudgetTokens`, plus per-tier size/count caps and retention days.

## Security & privacy

- **Secret redaction** — key/credential patterns in tool outputs are replaced before disk writes (`redactSecrets`, capped at `redactMaxBytes`).
- **Untrusted sources** — output of configured tools (default: webfetch, websearch, fetch, browser) is treated as untrusted data; instructions found inside it must not be persisted to memory.
- **Protected blocks** — core-memory labels in `protectedBlocks` (default PERSONA) cannot be overwritten by content originating from tool outputs or web content (taint guard).
- **Audit log** — every accepted/refused memory write is logged with SHA-256 hashes of old/new content and char counts, never the content itself.

## Limits

- Context window: the plugin evicts proactively at `capRatio` × model window; if a request still overflows the provider limit mid-turn that is unrecoverable — `unknownContextWindow` (default 32768) is deliberately conservative to avoid it.
- opencode's own spill-file cap (256 KB) applies to tool outputs before they reach the plugin; everything the plugin holds is saved in full.
- Single long session = one growing raw file per session; grep/sed by line offset stay instant, and cleanup is `rm` of one file.

## Development

    npm test         # node --experimental-strip-types --test tests/*.ts
    npm run typecheck
    npm run docs:check   # config-ref regen + doctest (bash blocks) + linkcheck + i18n coverage

Set `HIPPO_TEST=1` to expose internals on `globalThis.__hippoInternals` for testing. The design history of the lossless window lives in [DESIGN.md](./DESIGN.md).

## License

MIT — see [LICENSE](./LICENSE).
