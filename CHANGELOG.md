# Changelog

## 0.1.5 — 2026-07-13

- Deduplicate Codex Desktop fork/replay histories against their parent token-counter sequence while retaining new usage after the fork diverges.

## 0.1.4 — 2026-07-13

- Fix live-update heap exhaustion on large all-history TUI scans.
- Cache already-priced immutable records so unchanged files retain object identity across refreshes.
- Use lossless per-session/day/model/project rollups for interactive and text-table output while keeping JSON record-level.
- Add scanner reference-reuse and exact-rollup tests plus a no-forced-GC Ink live-update soak.

## 0.1.3 — 2026-07-12

- Discover and analyze exact Claude Desktop Cowork/agent session usage on Windows, macOS, and Linux.
- Report Claude Desktop as a separate source while applying the matching Anthropic model rates.
- Attribute Desktop usage to its selected folder for project aggregation.
- Ignore audit trails and deduplicate sessions mirrored between Claude Desktop and Claude Code storage.

## 0.1.2 — 2026-07-12

- Fix long-running TUI heap exhaustion caused by repeatedly reparsing the full session history.
- Prune default session files whose modification time predates `--since`.
- Cache parsed records by file path, size, and modification time with bounded invalidation.
- Reuse immutable results and skip TUI repaints when no session file changed.
- Add repeated-scan memory diagnostics and incremental cache regression coverage.

## 0.1.1 — 2026-07-10

- Add `lu` as the preferred executable alias while retaining `llmusage`.
- Add per-project aggregation to the TUI, text tables, and JSON output.
- Add an always-visible source summary so active filters do not hide detected agents.
- Add a `signals.json` fallback for Grok sessions without detailed prompt updates.
- Harden TUI exit handling for `q`, `Q`, Esc, and Ctrl+C, including during rescans.

## 0.1.0 — 2026-07-10

- Initial Codex, Claude Code, and Grok CLI usage dashboard.
