# llmusage

`llmusage` is a local-first terminal dashboard for the token usage and API-equivalent cost of Codex, Claude Code, Claude Desktop Cowork, and Grok CLI sessions. The installed command is `lu` (with `llmusage` retained as an alias). It runs on Windows, Linux, and macOS and never uploads session content.

> API-equivalent cost is an estimate of what the recorded tokens would cost at public API rates. It is not a bill and does not represent the price of a ChatGPT, Claude, or Grok subscription.

## Run it

```sh
npx --yes --package github:8a1a8/llmusage lu
```

The shorter GitHub shorthand, `npx github:8a1a8/llmusage`, also works and launches the same binary.

Or install it globally:

```sh
npm install --global https://github.com/8a1a8/llmusage/releases/download/v0.1.3/llmusage-0.1.3.tgz
lu
```

The unscoped `llmusage` npm registry name is available but v0.1.3 is distributed from GitHub until registry credentials are configured. The package is already structured for `npx llmusage@latest` after publication.

Node.js 20 or newer is required.

The interactive view refreshes every 30 seconds. Use `←`/`→` to switch day, week, month, and year; `s` to filter sources; `m` to switch between cost and tokens; `p` to switch between model and project tables; `r` to refresh; and `q`, `Q`, or Esc to quit. The active source filter is shown near the top, while the Sources row always shows every detected source.

## What it reads

| Source | Default location | Breakdown | Accuracy |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uncached input, cached input, output, reasoning | Exact recorded token deltas |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Input, cache creation, cache reads, output | Exact recorded message usage |
| Claude Desktop Cowork | Platform Claude app data under `local-agent-mode-sessions/**/.claude/projects/**/*.jsonl` | Input, cache creation, cache reads, output | Exact recorded message usage |
| Grok CLI / Grok Build | `~/.grok/sessions/**/{updates.jsonl,signals.json}` | Combined prompt context | Estimated; local logs do not expose the complete billing split |
| Generic API JSONL | User-provided paths | OpenAI-compatible input, cached input, output | Exact when a `usage` object is present |

Malformed and incomplete trailing JSONL lines are skipped, which keeps interrupted sessions readable. Files are streamed rather than loaded into memory in full. Usage can be grouped by project, combining records from different agents that share the same working directory.

Claude Desktop discovery covers local Cowork/agent sessions. On Windows it reads `%APPDATA%\Claude\local-agent-mode-sessions`; on macOS, `~/Library/Application Support/Claude/local-agent-mode-sessions`; and on Linux, `$XDG_CONFIG_HOME/Claude/local-agent-mode-sessions` (including the lowercase app-directory variant). The selected Cowork folder is used as the project; sessions without a selected folder are grouped as `Claude Desktop/Cowork`. If the same Claude session exists in both Claude Code and Desktop storage, it is counted once. Synced claude.ai chats are not counted because the local Chromium cache does not expose authoritative token usage; Anthropic's data export contains conversation history, not API billing counters.

## Refresh and memory behavior

The TUI keeps a bounded in-process cache keyed by file path, size, and modification time. Unchanged files are not reparsed, deleted or out-of-range files are evicted, and the screen is not repainted when the resulting usage data is unchanged. With automatic discovery, `--since` also skips session files whose modification time proves they cannot contain in-range records. Explicit file and directory arguments are always inspected fully so archived files with preserved timestamps remain correct.

## Commands

```sh
# Interactive dashboard using all detected sources
lu

# Non-interactive tables
lu --no-tui --period week

# JSON for scripts or jq
lu --json --since 2026-07-01 --source codex --source claude

# Scan explicit files or directories
lu ./sessions /mnt/archive/sessions.jsonl

# Use a custom pricing file
lu --pricing ./pricing.json
```

Run `lu --help` for all options. `llmusage` remains available for compatibility.

## Cost calculation

Rates are stored as USD per one million tokens. Each usage row is calculated independently:

```text
cost = (uncached_input × input_rate
      + cached_input   × cached_rate
      + cache_write_5m × cache_write_5m_rate
      + cache_write_1h × cache_write_1h_rate
      + output         × output_rate) / 1,000,000
```

The built-in table covers common OpenAI/Codex, Anthropic Claude, and xAI Grok model identifiers. Rows ending in `~` use an estimated token count, a fallback model rate, or both. Pricing changes over time, so pass a custom JSON file when auditability matters:

```json
[
  {
    "pattern": "^my-model-v2$",
    "source": "generic",
    "input": 1.25,
    "cachedInput": 0.20,
    "cacheWrite": 1.25,
    "cacheWrite1h": 2.00,
    "output": 2.50,
    "label": "My model v2"
  }
]
```

Rules are checked in order and custom rules take precedence over built-ins. `pattern` is a case-insensitive JavaScript regular expression. Omit `source` to match the model name from any source.

Published rates are based on the [OpenAI model pages](https://developers.openai.com/api/docs/models), [Anthropic pricing documentation](https://docs.anthropic.com/en/docs/about-claude/pricing), and [xAI pricing documentation](https://docs.x.ai/developers/pricing). Unknown Claude Code aliases use a clearly marked Sonnet-equivalent fallback. Grok 4.5's local session telemetry records combined context totals but not cached/input/output billing categories, so those totals are priced as uncached input and marked estimated. If detailed Grok prompt updates are unavailable, `signals.json` supplies a marked session-level fallback.

## Privacy

All processing happens in the current Node.js process. `llmusage` reads event metadata and token counters; it does not print prompts, responses, tool output, authentication data, or session content. No telemetry or network request is made by the CLI.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack
npm run memory:probe
```

The package is MIT licensed. Issues and pull requests are welcome.
