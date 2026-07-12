# Changelog

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
