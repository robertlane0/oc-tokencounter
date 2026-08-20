# OpenCode `/usage` Token Counter

A pair of local [OpenCode](https://opencode.ai) plugins that continuously track **token usage**, **cost**, **model usage**, **per-agent stats**, and **compactions** for every session, folder, and model on your machine — and surface them in the TUI through a `/usage` slash command that costs **zero LLM tokens** (results are rendered as local dialogs, never sent to a model).

```
/usage              usage for the current folder
/usage <path>       usage for a folder (absolute or relative)
/usage <model>      global usage for a model
/usage models       global model ranking
/usage tree         folder tree with usage + models + compactions
/usage export       write a usage report to usage-report.md
/usage reset        clear all recorded usage (with confirmation)
/usage help         this help
```

`/tokens` works as an alias for `/usage`.

## Why

OpenCode does not offer a built-in cross-folder view of how many tokens and which models you consume. This project fills that gap with:

- **Zero-token queries.** Every `/usage` invocation — including invalid ones — is intercepted by a TUI key handler and rendered as a local dialog. No request ever reaches a provider.
- **Global aggregation.** Because each tracked directory writes to a shared on-disk store, queries like `/usage models` or `/usage tree` aggregate across *all* folders you've used OpenCode in on this machine.
- **Historical backfill.** On first load, each folder's past sessions are read from OpenCode's session store, so you get totals for work done before the plugin was installed — without double counting.

## Features

- Per-folder, per-path, per-model, and global usage views
- Token breakdown: input, output, reasoning, cache read/write
- Real cost from stored messages (live events report `cost: 0`; see [Known limitations](#known-limitations))
- Per-agent stats (`build`, `plan`, subagents, …)
- Compaction counts split by auto/manual
- Heaviest sessions per folder, with the current session highlighted (`*`)
- Markdown export (`/usage export` → `usage-report.md`)
- Reset with confirmation dialog (`/usage reset`)
- Idempotent counting — restarting OpenCode never double-counts

## How it works

OpenCode requires a plugin to export **either** `server` **or** `tui` — not both — so the project is split into two cooperating plugins plus a shared library:

```
┌─────────────────────────┐        ┌───────────────────────────┐
│  usage-tracker.ts       │        │  usage-tui.ts             │
│  (server plugin)        │        │  (TUI plugin)             │
│  - event hooks          │        │  - /usage slash command   │
│  - aggregation          │  reads │  - Enter-key intercept    │
│  - persistence          ├───────►│  - dialogs / canned errors│
│  - startup backfill     │  store │  - export / reset         │
└───────────┬─────────────┘        └───────────┬───────────────┘
            │ writes                          │ reads
            ▼                                 ▼
   ┌──────────────────────────────────────────────────────────┐
   │  $XDG_DATA_HOME/opencode/plugins/usage-counter/          │
   │  projects/<sha1(directory)>.json                          │
   │  (one file per directory — shared by all instances)      │
   └──────────────────────────────────────────────────────────┘
```

- **`usage-tracker.ts`** (server) subscribes to session events (`session.next.step.started` / `.ended`, `session.next.compaction.started`), correlates tokens to models via `assistantMessageID`, and writes to a per-directory JSON store with debounced, atomic (tmp + rename) writes. On first load for a directory it backfills historical usage from `client.session.list()` + `client.session.messages()`. Message IDs recorded in each session's `processed` list make both paths idempotent.
- **`usage-tui.ts`** (TUI) registers the `/usage` command (for autocomplete discoverability) and a priority-1 Enter-key interceptor. The interceptor is the actual gate: any prompt line starting with `/usage` or `/tokens` is prevented from submitting, the prompt is cleared, and a dialog is rendered — guaranteeing zero tokens are spent. Views are plain-text content passed to `DialogAlert`/`DialogConfirm`.
- **`usage-lib.ts`** (shared, no side effects) holds store paths and schema, aggregation, tree building, argument parsing, and formatting — pure functions, unit-tested independently.

### Why the files live where they do

OpenCode's plugin loader only auto-discovers top-level `plugin(s)/*.ts` files (no subdirectories, no `.tsx`). The TUI loads plugins **only** from `tui.json` declarations — it never auto-discovers files. Therefore:

- `usage-tracker.ts` sits at `plugins/` top level so the server discovers it automatically.
- `usage-tui.ts` and `usage-lib.ts` live in `plugins/lib/` so the server glob never mistakes them for server plugins, and the TUI plugin is explicitly declared in `tui.json`.

## Repository structure

```
.
├── .opencode/
│   ├── tui.json                     # declares the TUI plugin (required)
│   ├── package.json                 # dev-only types for @opencode-ai/plugin (gitignored)
│   └── plugins/
│       ├── usage-tracker.ts         # server plugin: tracking + persistence + backfill
│       └── lib/
│           ├── usage-lib.ts         # shared helpers: store, aggregation, parsing, formatting
│           └── usage-tui.ts         # TUI plugin: /usage command, interceptor, dialogs
├── test/
│   ├── usage-lib.test.ts            # unit tests: aggregation, parsing, tree, formatting
│   ├── usage-tracker.test.ts        # integration: events, backfill, idempotency
│   └── usage-tui.test.ts            # integration: interception, dialogs, export
├── USAGE-PLUGIN-PLAN.md             # detailed design & verification plan
└── LICENSE                          # MIT
```

## Prerequisites

- [OpenCode](https://opencode.ai) ≥ 1.18 (verified against 1.18.18)
- No npm package needed at runtime — the plugins are plain local `.ts` files

## Installation

The plugin pair can be installed per-project or globally. **Global installation is recommended**, because it makes `/usage models`, `/usage tree`, and `/usage <model>` meaningful across all your projects.

### Global (recommended)

```sh
cp -r .opencode/plugins ~/.config/opencode/
cp .opencode/tui.json ~/.config/opencode/
```

### Project-local

```sh
mkdir -p .opencode
cp -r .opencode/plugins .opencode/
cp .opencode/tui.json .opencode/
```

> The server auto-discovers plugins in both `.opencode/` and `~/.config/opencode/`. The TUI plugin additionally requires the `tui.json` declaration in the same location.

Restart OpenCode after installing. The server plugin backfills history for the current folder on first launch.

## Usage

In the OpenCode TUI, type a command and press Enter:

| Command | Result |
| --- | --- |
| `/usage` | Usage for the current folder: totals, model table with % share, agents, top 5 sessions (current session marked `*`) |
| `/usage <path>` | Aggregated usage for a folder, absolute or relative (e.g. `/usage ./src`). Lists matched subfolders |
| `/usage <model>` | Global usage for a model, fuzzy-matched by name (e.g. `/usage gpt-5`, `/usage claude-4`) |
| `/usage models` | Global model ranking across all tracked folders |
| `/usage tree` | Tree of tracked folders with tokens · calls · models · compactions · sessions per node |
| `/usage export` | Writes `usage-report.md` (Markdown tables of models and folders) into the worktree and toasts the path |
| `/usage reset` | Deletes all recorded usage after a confirmation dialog |
| `/usage help` | Help text listing the valid forms |

Any other argument produces a canned error dialog (still zero tokens):

```
Unknown usage query: "unknown-command-example-123"
Valid invocations:
  /usage              usage for the current folder
  /usage <path>       usage for a folder (absolute or relative)
  /usage <model>      global usage for a model
  /usage models       global model ranking
  /usage tree         folder tree with usage + models + compactions
  /usage help         this help
```

## Data storage

Usage is persisted as one JSON file per directory:

```
$XDG_DATA_HOME/opencode/plugins/usage-counter/projects/<sha1(abs-dir)>.json
```

where `$XDG_DATA_HOME` defaults to `~/.local/share`. So on a typical Linux setup the root is `~/.local/share/opencode/plugins/usage-counter/projects/`.

Store schema (v1):

```jsonc
{
  "version": 1,
  "directory": "/abs/project",
  "worktree": "/abs/repo-root",
  "models": {
    "providerID/modelID": {
      "input": 0, "output": 0, "reasoning": 0,
      "cacheRead": 0, "cacheWrite": 0,
      "calls": 0, "lastUsed": 0, "cost": 0
    }
  },
  "agents": { "build": { "calls": 0, "input": 0, "output": 0, "reasoning": 0 } },
  "compactions": { "total": 0, "auto": 0, "manual": 0 },
  "sessions": {
    "<sessionID>": {
      "title": "", "created": 0, "updated": 0,
      "tokens": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0 },
      "cost": 0,
      "models": { "providerID/modelID": { "input": 0, "output": 0, "reasoning": 0, "calls": 0, "cost": 0 } },
      "compactions": 0,
      "lastModel": "providerID/modelID",
      "processed": ["msg_..."]
    }
  },
  "updated": 0
}
```

Writes are debounced (at most once per second) and atomic (write to a temp file, then rename). Files are safe to delete to clear data manually — `/usage reset` does exactly that.

## Development

### Running tests

Tests use Node's built-in test runner and type stripping (no build step, no test framework to install):

```sh
node --test 'test/*.test.ts'
```

or, if you use bun:

```sh
bun test
```

The suite covers store paths, aggregation, tree building, argument parsing, formatting, tracker event handling + backfill idempotency, and TUI interception/dialog rendering (34 tests).

### Type checking

The `.opencode/package.json` pins `@opencode-ai/plugin` (types for both the server and TUI APIs) for editor support. Note that `package.json`, its lockfile, and `node_modules/` are gitignored — they exist for local development only; the plugins themselves run without them.

```sh
npm install --prefix .opencode
```

### Making changes

- Keep pure logic in `usage-lib.ts` — it's the unit-tested surface.
- Do not add new top-level files to `plugins/` unless they are server plugins; the server's auto-discovery glob treats every named export there as a server plugin.
- The TUI plugin must stay declared in `tui.json`.
- Local plugin files are `.ts`, and the auto-discovery glob excludes `.tsx` — dialogs must be built from plain string content (as the existing `DialogAlert` usage does).

See [USAGE-PLUGIN-PLAN.md](USAGE-PLUGIN-PLAN.md) for the full design, the verified OpenCode internals it relies on, and the verification checklist.

## Known limitations

- **TUI-only display.** In `opencode run`, Web, or IDE surfaces the `/usage` command has no dialog — but the server plugin keeps tracking usage regardless.
- **Live cost is 0.** `Step.Ended` events carry `cost: 0`; real cost only appears via backfill from stored session messages. Folder/model views therefore show cost from backfilled history (and 0 for newly recorded live steps).
- **Concurrent writers are best-effort.** Two OpenCode instances on the same directory use atomic renames (no corruption), but cross-instance merges of the same store file are last-writer-wins.
- **Moved sessions.** A session that moves to another directory is tracked by the plugin instance running in that directory.

## License

[MIT](LICENSE) © 2026 Robert Lane