# llmusage

`llmusage` is a local-first terminal dashboard for the token usage and API-equivalent cost of Codex, Claude Code, and Grok CLI sessions. It runs on Windows, Linux, and macOS, reads JSONL directly, and never uploads session content.

> API-equivalent cost is an estimate of what the recorded tokens would cost at public API rates. It is not a bill and does not represent the price of a ChatGPT, Claude, or Grok subscription.

## Run it

```sh
npx github:8a1a8/llmusage
```

Or install it globally:

```sh
npm install --global https://github.com/8a1a8/llmusage/releases/download/v0.1.0/llmusage-0.1.0.tgz
llmusage
```

The unscoped `llmusage` npm registry name is available but v0.1.0 is distributed from GitHub until registry credentials are configured. The package is already structured for `npx llmusage@latest` after publication.

Node.js 20 or newer is required.

The interactive view refreshes every 30 seconds. Use `←`/`→` to switch day, week, month, and year; `s` to filter sources; `m` to switch between cost and tokens; `r` to refresh; and `q` to quit.

## What it reads

| Source | Default location | Breakdown | Accuracy |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | Uncached input, cached input, output, reasoning | Exact recorded token deltas |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Input, cache creation, cache reads, output | Exact recorded message usage |
| Grok CLI / Grok Build | `~/.grok/sessions/**/updates.jsonl` | Combined prompt context | Estimated; local logs do not expose the complete billing split |
| Generic API JSONL | User-provided paths | OpenAI-compatible input, cached input, output | Exact when a `usage` object is present |

Malformed and incomplete trailing JSONL lines are skipped, which keeps interrupted sessions readable. Files are streamed rather than loaded into memory in full.

## Commands

```sh
# Interactive dashboard using all detected sources
llmusage

# Non-interactive tables
llmusage --no-tui --period week

# JSON for scripts or jq
llmusage --json --since 2026-07-01 --source codex --source claude

# Scan explicit files or directories
llmusage ./sessions /mnt/archive/sessions.jsonl

# Use a custom pricing file
llmusage --pricing ./pricing.json
```

Run `llmusage --help` for all options.

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

Published rates are based on the [OpenAI model pages](https://developers.openai.com/api/docs/models), [Anthropic pricing documentation](https://docs.anthropic.com/en/docs/about-claude/pricing), and [xAI pricing documentation](https://docs.x.ai/developers/pricing). Unknown Claude Code aliases use a clearly marked Sonnet-equivalent fallback. Grok 4.5's local session telemetry records combined context totals but not cached/input/output billing categories, so those totals are priced as uncached input and marked estimated.

## Privacy

All processing happens in the current Node.js process. `llmusage` reads event metadata and token counters; it does not print prompts, responses, tool output, authentication data, or session content. No telemetry or network request is made by the CLI.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run build
npm pack
```

The package is MIT licensed. Issues and pull requests are welcome.
