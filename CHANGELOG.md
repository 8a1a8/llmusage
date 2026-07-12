# Changelog

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
