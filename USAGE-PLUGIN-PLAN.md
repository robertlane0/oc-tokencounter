# OpenCode `/usage` Token-Counter Plugin — Implementation Plan

**Status:** Implemented. This document retains the original plan as design reference; places where the shipped code diverged are marked **Implemented:**. Approved: TUI dialog, zero tokens; global cross-folder aggregation; local plugin files

## 1. Goal

A pair of local OpenCode plugins that track **token usage**, **number of compactions**, and **which models are used** at all times (every session, every folder, every model) and display them in the TUI via a `/usage` command:

| Command | Meaning |
| --- | --- |
| `/usage` | Usage for the current folder |
| `/usage <path>` | Usage for a full or relative path (aggregates subfolders) |
| `/usage <model-name>` | Global usage of a given model (across all folders) |
| `/usage models` | Global ranking of all models |
| `/usage tree` | Tree view of folders + usage + models + compactions |
| `/usage <unknown>` | **Canned error dialog, zero tokens burned** |
| `/usage help` | Help text listing the valid forms |

Design constraints (confirmed with user):

- Display is a **TUI dialog** — **zero LLM tokens** are spent for any `/usage` invocation, including invalid/unknown invocations.
- **Global** queries aggregate across **all folders** the user has used OpenCode in on this machine.
- Distributed as **local plugin files** under the config/plugin directories (no npm package).

## 2. Architecture

```
┌─────────────────────────┐        ┌───────────────────────────┐
│  usage-tracker.ts       │        │  usage-tui.ts             │
│  (server plugin, one    │        │  (TUI plugin, one per TUI)│
│   per project instance) │        │                           │
│  - 2 s session polling  │  reads │  - /usage slash command   │
│  - aggregate + persist  ├───────►│  - Enter interception     │
│  - backfill + live turns│  store │  - dialogs / canned errors│
└───────────┬─────────────┘        └───────────┬───────────────┘
            │ writes                          │ reads
            ▼                                 ▼
   ┌────────────────────────────────────────────────┐
   │  Global store: ~/.local/share/opencode/plugins/│
   │  usage-counter/projects/<sha1(dir)>.json        │
   │  (one file per directory, shared by all         │
   │   project instances → global aggregation)       │
   └────────────────────────────────────────────────┘
```

- **`usage-tracker.ts`** runs in the OpenCode **server** process (one instance per project directory). It aggregates token/model/compaction data and writes it to a shared on-disk store. **Implemented:** instead of subscribing to events (§3.2's original design), it polls the SDK every 2 s — see §3.2 for the shipped behavior.
- **`usage-tui.ts`** runs in the **TUI** process. It registers the `/usage` command and an Enter-key interceptor, reads the shared store, and renders dialogs. It never talks to an LLM.
- **`usage-lib.ts`** — shared helpers (store paths, schema, aggregation, tree building) imported by both files.

Note: OpenCode requires a plugin to export **either** `server` **or** `tui` — not both (`packages/opencode/src/plugin/shared.ts:293`). Two files are therefore needed.

**Discovery mechanism (verified against 1.18.18):** only the **server** auto-discovers files via the glob `{plugin,plugins}/*.{ts,js}` (top-level only, `packages/opencode/src/config/plugin.ts:21`). The **TUI** loads plugins **only from `tui.json` declarations** (`TuiConfig.pluginOrigins()`, `packages/opencode/src/config/tui.ts`), so the TUI plugin must be declared in `tui.json`. Helper modules must live in a subdirectory (e.g. `plugins/lib/`) so the server glob never picks them up — otherwise the server's legacy loader treats every named export function as a server plugin (`isServerPlugin` = "is a function", `plugin/index.ts:86`) and fails with `{} is not iterable`, and a `tui`-only file fails with `must default export an object with server()`.

### 2.1 Key codebase facts (verified in opencode source at `/tmp/opencode`)

- **Events a server plugin receives** (`event` hook, `packages/opencode/src/plugin/index.ts:253`): the hook is called with `{ id, type, properties }` for every `EventV2` publish routed to the plugin's directory. The relevant session events are:
  - `session.next.step.started` — `{ sessionID, assistantMessageID, agent, model: { providerID, id, variant? }, ... }`
  - `session.next.step.ended` — `{ sessionID, assistantMessageID, finish, cost, tokens: { input, output, reasoning, cache: { read, write } }, ... }`
  - `session.next.compaction.started` — `{ sessionID, messageID, reason: "auto"|"manual" }` (verified in source: `session.next.compaction.ended` does not exist)
  - `session.compacted` — `{ sessionID }`
  - `session.next.model.switched` — `{ sessionID, messageID, model }` (optional)
  - Published from `packages/core/src/session/runner/publish-llm-event.ts:78`, `packages/core/src/session/runner/llm.ts:333`, and `packages/core/src/session/compaction.ts:192,222`.
- **`Step.Ended` carries `cost: 0`** (hardcoded in `llm.ts:338`); token counts are accurate. Real cost is available only from stored messages (used by backfill).
- **Tokens are correlated to a model** by matching `Step.Started`/`Step.Ended` on `assistantMessageID` (started has the model, ended has the tokens).
- **The SDK `Event` type union does not include `session.next.*`** — the plugin must switch on `event.type` as a string and cast `properties` (the runtime events are not reflected in generated types).
- **`client.session.messages()` takes the session id as a path parameter** — `client.session.messages({ path: { id } })`, not a flat `sessionID`; passing it flat silently returns no messages (verified against 1.18.18).
- **Backfill data**: `client.session.list()` + `client.session.messages({ path: { id } })` return `Assistant` messages (`type: "assistant"`, with `model`, `tokens`, `cost`, `time.created/completed`) and `Compaction` messages (`type: "compaction"`, with `reason`). Session `Info` has aggregated `tokens`/`cost` but no per-model breakdown, so messages are needed for per-model stats.
- **TUI plugins** (`@opencode-ai/plugin/tui`) get `api.keymap` (register commands/bindings, `intercept("key", handler, { priority })`), `api.ui` (dialogs, toasts), `api.state.path.{directory,worktree}`, `api.renderer.currentFocusedEditor` (`.plainText`), and `api.route.current` (current `sessionID`).
- **Key interception pattern** (verified in `packages/tui/src/app.tsx:423`): `keymap.intercept("key", ({ event }) => { ...; event.preventDefault(); event.stopPropagation() }, { priority: 1 })` fires before normal bindings, so it can prevent the prompt submit → guarantees `/usage ...` never reaches the LLM.
- **Command routing** (`packages/tui/src/component/prompt/index.tsx:1071`): text starting with `/` routes to `session.command` **only if** it is a registered server command; otherwise it falls through to a normal `session.prompt` (LLM). Therefore the TUI intercept is the only reliable zero-token gate; we do **not** rely on registering a server command.
- **Global data dir**: OpenCode uses `Global.Path.data` = `~/.local/share/opencode` (`packages/core/src/global.ts`), honoring `XDG_DATA_HOME`. The plugin computes the same path itself (it has full filesystem access) so it works across project instances.

## 3. Components

### 3.1 `usage-lib.ts` — shared store helpers

- **Store location**
  ```
  dataHome  = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  storeRoot = path.join(dataHome, "opencode", "plugins", "usage-counter", "projects")
  ```
  One JSON file per absolute directory keyed by `sha1(directory).json`.
- **Store schema (v1, as shipped)**
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
        "processed": ["msg_...", "..."]   // capped dedup set (last 500) for idempotent counting
      }
    },
    "updated": 0
  }
  ```
- **Aggregation API** (pure functions in `usage-lib.ts`, tested separately):
  - `aggregate(stores)` — merge multiple per-directory stores into totals (per model / per agent / per folder).
  - `aggregateForPath(stores, absPath)` — aggregate only stores at or under `absPath`.
  - `buildTree(stores)` — build directory trie from `directory` paths; each node aggregates its own file + descendants: `tokens`, `calls`, `modelCount`, `compactions`, `sessions`.
  - `parseUsageArgs(input, cwd, worktree)` — classify `/usage ...` argument.
  - `findModel(stores, query)` — fuzzy/prefix match on `providerID/modelID`.
  - `applyStep` / `applyCompaction` / `applyBackfillSession` — record one step / compaction / a full session's stored messages into a store.
  - Store helpers: `loadStore`, `saveStore`, `listStores`, `removeStoreFiles`, `storeFileFor`, `directoryKey`.
  - `formatTokens(n)`, `formatMoney(n)`, `formatDuration(ms)` formatting helpers.

### 3.2 `usage-tracker.ts` — server plugin

```ts
export default { id: "usage-counter", server }
// server = (input: PluginInput): Hooks
```

> **Implemented:** the original event-hook design (subscribe to `session.next.step.started` / `.ended` / compaction events, correlate via `assistantMessageID`) was replaced by SDK polling — it is simpler, covers both history and live turns through one code path, and sidesteps the fact that live `Step.Ended` events carry `cost: 0`. The shipped behavior:

1. **On load:** load (or create) the store file for `directory`, run one poll immediately, then `setInterval` every 2 s (`POLL_MS`).
2. **Each poll** (`client.session.list({ query: { directory } })`):
   - Skip sessions whose stored `updated` ≥ the session's current `time.updated` (incremental; no rework on restart).
   - For changed sessions, fetch persisted messages via `client.session.messages({ path: { id }, query: { directory } })` and fold them in with `applyBackfillSession`: completed assistant messages increment `models[providerID/modelID]` (input/output/reasoning/cache read/write, calls, cost), `agents[agent]` (agent taken from the preceding user message), and `sessions[sessionID]` aggregates; `compaction` parts increment `compactions.total` (+ `auto`/`manual`). In-flight assistant messages (no `time.completed` yet) are skipped so they are counted once, with real tokens and cost, on a later poll.
3. **Persistence:** after any poll that changed data (or when the store file is missing), write atomically (temp file + rename).
4. **`dispose()`:** clear the timer, wait (bounded) for an in-flight poll, run one final poll so last-turn tokens are recorded, then save.

### 3.3 `usage-tui.ts` — TUI plugin

```ts
export default { id: "usage-counter-tui", tui }
// tui: TuiPlugin = async (api) => { ... }
```

1. **Register slash command** for discovery:
   ```ts
   api.keymap.registerLayer({
     commands: [{
       name: "usage.show", namespace: "palette", category: "Usage",
       title: "Usage", desc: "Show token usage, models and compactions",
       slashName: "usage",
       run: () => handleUsage(undefined),
     }],
   })
   ```
2. **Enter-key interceptor** (the zero-token gate):
   ```ts
   api.keymap.intercept(
     "key",
     ({ event }) => {
       if (event.name !== "return") return
       const editor = api.renderer.currentFocusedEditor
       if (!editor) return
       const text = editor.plainText ?? ""
       if (!/^\/(usage|tokens)\b/.test(text.trimStart())) return
       event.preventDefault(); event.stopPropagation()
       editor.deleteRange(0, 0, editor.logicalCursor.row, editor.logicalCursor.col)
       api.keymap.dispatchCommand("prompt.autocomplete.hide")
       handleUsage(text)                            // parse + dialog / canned error
     },
     { priority: 1 },
   )
   ```
   - This covers `/usage`, `/usage models`, `/usage tree`, `/usage /path`, `/usage <model>`, and `/usage <garbage>` — **none** reach `session.prompt`.
   - The `slashName` registration only makes `/usage` appear in autocomplete for discoverability; the intercept is the single handler (the autocomplete's Enter select is beaten by the priority-1 intercept).
3. **`handleUsage(input)`** — parse args via `usage-lib.parseUsageArgs` against `api.state.path.directory`/`worktree`, read the global store, and render the matching dialog (below). Unknown input → canned error dialog.
4. **Reading the store:** on each invocation, read all `projects/*.json`, aggregate with `usage-lib`. Optionally re-read every ~2 s while a dialog is open for a live feel.

### 3.4 Backfill (historical data)

**Implemented:** no longer a one-time startup pass — it is the same incremental poll described in §3.2, run every 2 s:

- `client.session.list({ query: { directory } })`; sessions already up to date in the store (stored `updated` ≥ session `time.updated`) are skipped, so history is fetched once and afterwards only changed sessions are re-read.
- For each changed session, `client.session.messages({ path: { id } })`.
- Count completed `Assistant` messages: `tokens`, `cost`, `model` (`providerID`/`modelID`), agent from the preceding `user` message; count `compaction` parts (`auto === true` → auto, else manual).
- In-flight assistant messages are skipped (no `time.completed`) so their usage is recorded exactly once, when complete.
- All counting is **idempotent**: message/part ids land in `sessions[id].processed` and are skipped on re-reads.

## 4. `/usage` argument parsing

`parseUsageArgs(input, cwd, worktree)`:

1. Strip a leading `/usage` (or the `/tokens` alias, **Implemented**); trim.
2. Empty → **folder** view (current `directory`).
3. Reserved keywords (exact match): `models` → models ranking; `tree` → tree view; `help` → help; `reset` → reset store; `export` → write store to file.
4. Path-like (`/`, `.`, `..`, contains a path separator, or resolves to an existing entry on disk) → **path** view (aggregate all tracked directories at/under that path; if none tracked, still show the folder with zeros).
5. Otherwise → **model** view: `findModel` across the store (prefix / substring match on `modelID` or `providerID/modelID`). One or more matches → pick best match; **no match → canned error**.
6. Anything not matching the above → **canned error**.

Canned error (dialog, zero tokens):

> Unknown usage query: "unknown-command-example-123"
> Valid invocations:
>   /usage              usage for the current folder
>   /usage <path>       usage for a folder (absolute or relative)
>   /usage <model>      global usage for a model
>   /usage models       global model ranking
>   /usage tree         folder tree with usage + models + compactions
>   /usage help         this help

## 5. Dialogs (Solid elements via `@opentui/solid`)

Rendered through `api.ui.dialog.replace(() => <Dialog .../>)`. Because local plugin files are `.ts` (the auto-discovery glob is `{plugin,plugins}/*.{ts,js}`, not `.tsx`), build elements **without JSX syntax** using Solid's `createElement`/`h` (or the renderer API if Solid element creation is impractical — verify during implementation). Theme colors from `api.theme.current`.

**Implemented:** dialogs are plain multi-line **strings** rendered via `api.ui.DialogAlert` / `api.ui.DialogConfirm` inside `api.ui.dialog.replace(...)`, with `api.ui.dialog.setSize("large" | "xlarge")` for bigger views — no Solid element factories needed.

- **Folder view**: folder path; totals (tokens input/output/reasoning/cache, calls); per-model table (model, input, output, calls, % share); per-agent table; sessions (top by tokens, incl. title, model, tokens, compactions); compaction count (auto/manual); current session highlighted via `api.route.current`.
- **Path view**: same as folder view but for the aggregated set of directories under the given path; shows the list of matched directories.
- **Model view**: model header; global totals; per-folder table (folder, input, output, calls, %); sessions using the model.
- **Models view**: ranked table (rank, model, provider, input, output, calls, #folders, #compactions) sorted by total tokens.
- **Tree view**: box/ASCII tree of directories from the store, each node `name  [tokens · calls · models · compactions · sessions]`. **Implemented:** rooted at the common parent of all tracked directories (not worktree/`~`), children sorted by tokens.
- **Help / error**: `api.ui.DialogAlert` (plain string props) or a small dialog.

## 6. Useful extras (optional, ordered by value)

Shipped: 2, 3, 4, 5, 7. Not shipped: 1 (moot — real cost comes from stored messages) and 6.

1. **Estimated cost**: live events report `cost: 0`, so estimate spend from token counts using a small bundled price table (`providerID/modelID` → `$` per MTok, extendable via plugin options); backfill uses the real `cost` from messages.
2. **Per-agent stats**: `build`/`plan`/subagents — already captured in `agents`; surface in folder view. ✅
3. **Reset**: `/usage reset` with confirm dialog deletes `projects/*.json`. ✅
4. **Export**: `/usage export` writes `usage-export.json`/`.md` and toasts the path. ✅ (Markdown only: `usage-report.md`)
5. **Heaviest sessions**: folder view lists top-N sessions by tokens. ✅ (top 5)
6. **Live refresh**: dialog re-reads the store every ~2 s while open.
7. **Session highlight**: mark the current session in tables. ✅ (`*`)

## 7. Files to create

| File | Type | Purpose |
| --- | --- | --- |
| `USAGE-PLUGIN-PLAN.md` | plan | this document |
| `.opencode/plugins/lib/usage-lib.ts` | helper | store paths, schema, aggregation, tree, arg parsing, formatting (in `lib/` so the server's `plugins/*.ts` glob skips it) |
| `.opencode/plugins/usage-tracker.ts` | **server** plugin | event tracking + persistence + backfill |
| `.opencode/plugins/lib/usage-tui.ts` | **tui** plugin | `/usage` command, Enter intercept, dialogs (in `lib/`, declared via `tui.json`) |
| `.opencode/tui.json` | TUI config | declares the TUI plugin (`"plugin": ["./plugins/lib/usage-tui.ts"]`) — required, the TUI does not auto-discover plugin files |
| `.opencode/package.json` | dev-only types | pins `@opencode-ai/plugin` for editor type support (gitignored; the plugins run without it) |
| `install.sh` / `install.bat` | installers | copy `plugins/` + `tui.json` to the global or project-local config, merging the TUI declaration into an existing `tui.json` |
| test files (see §8) | tests | unit tests for aggregation/parsing/tree |

Install: run `install.sh`/`install.bat` (global by default, `--local` for project-local), or manually copy the `plugins/` directory and `tui.json` to `.opencode/` for project-local, or `~/.config/opencode/` for **global** (recommended, so every folder is tracked and `/usage models|tree|<model>` are meaningful). Both config dirs are auto-discovered by the server; the TUI plugin additionally requires the `tui.json` declaration in the same location.

## 8. Verification

1. **Unit tests** (run with `node --test 'test/*.test.ts'`, or `bun test`): aggregation merge, arg parsing (each branch incl. unknown), tree building, dedup, formatting, tracker polling/backfill idempotency, TUI interception/dialog rendering.
2. **Integration, tracker**: install in a scratch project; run a few prompts with different models (switch via `/models`); force a compaction (`/compact`); confirm `projects/<hash>.json` contains expected `models`/`compactions`/`sessions`.
3. **Integration, TUI**: run `opencode`; type `/usage`, `/usage models`, `/usage tree`, `/usage <existing-path>`, `/usage <model-name>`, `/usage unknown-command-example-123` — each opens the expected dialog; the last shows the canned error.
4. **Zero-token proof**: for each `/usage` variant, confirm no request hits a provider. Reliable signal: run a provider with logging enabled, or check the OpenCode log/trace (`opencode run --trace` / `~/.local/share/opencode/log`) for the absence of a new assistant message / tool call for the `/usage` input; also confirm the prompt input is cleared after each invocation.
5. **Global aggregation**: run OpenCode in two different projects; `/usage models` and `/usage tree` reflect both.
6. **Restart**: close/reopen OpenCode; backfill must not double-count (compare totals before/after).

## 9. Known limitations / future work

- **TUI-only display.** In CLI `run`, Web, or IDE the `/usage` command has no dialog (tracking still runs). A future enhancement: a server `usage` **tool** + a `usage` command template so non-TUI surfaces get a rendered (LLM-formatted) answer — explicitly out of scope per the approved design.
- **Subdirectory/moved sessions**: tracking is scoped per directory (`client.session.list({ query: { directory } })`); sessions moved to another directory are tracked by the plugin instance running there. Edge case, acceptable.
- **~2 s recording latency**: usage is picked up on the next poll tick; `dispose()` runs a final poll + save so last-turn tokens are not lost.
- **Concurrent writers**: two OpenCode instances on the same directory last-writer-wins with atomic renames; no data corruption, but cross-instance merges on the same file are best-effort.
- **Local `.ts` files cannot use JSX syntax** (auto-discovery glob excludes `.tsx`) — moot in practice: dialogs are plain strings passed to `DialogAlert`/`DialogConfirm`.