# OpenCode `/usage` Token-Counter Plugin — Implementation Plan

**Status:** Plan (approved: TUI dialog, zero tokens; global cross-folder aggregation; local plugin files)

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
│  - event hook           │  reads │  - /usage slash command   │
│  - aggregate + persist  ├───────►│  - Enter interception     │
│  - startup backfill     │  store │  - dialogs / canned errors│
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

- **`usage-tracker.ts`** runs in the OpenCode **server** process (one instance per project directory). It subscribes to events, aggregates token/model/compaction data, and writes it to a shared on-disk store.
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
- **Backfill data**: `client.session.list()` (paginated via cursor) + `client.session.messages({ sessionID })` return `Assistant` messages (`type: "assistant"`, with `model`, `tokens`, `cost`, `time.created/completed`) and `Compaction` messages (`type: "compaction"`, with `reason`). Session `Info` has aggregated `tokens`/`cost` but no per-model breakdown, so messages are needed for per-model stats.
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
- **Store schema (v1)**
  ```jsonc
  {
    "version": 1,
    "directory": "/abs/project",
    "worktree": "/abs/repo-root",
    "models": {
      "providerID/modelID": {
        "input": 0, "output": 0, "reasoning": 0,
        "cacheRead": 0, "cacheWrite": 0,
        "calls": 0, "lastUsed": 0
      }
    },
    "agents": { "build": { "calls": 0, "tokens": { "input": 0, "output": 0 } } },
    "compactions": { "total": 0, "auto": 0, "manual": 0 },
    "sessions": {
      "<sessionID>": {
        "title": "", "created": 0, "updated": 0,
        "tokens": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0 },
        "models": { "providerID/modelID": { "input": 0, "output": 0, "calls": 0 } },
        "compactions": 0,
        "processed": ["msg_...", "..."]   // capped dedup set (e.g. last 500) for backfill
      }
    },
    "updated": 0
  }
  ```
- **Aggregation API** (pure functions, tested separately):
  - `aggregate(stores)` — merge multiple per-directory stores into totals (per model / per agent / per folder).
  - `buildTree(stores)` — build directory trie from `directory` paths; each node aggregates its own file + descendants: `tokens`, `calls`, `modelCount`, `compactions`.
  - `parseUsageArgs(input, cwd, worktree)` — classify `/usage ...` argument.
  - `findModel(stores, query)` — fuzzy/prefix match on `providerID/modelID`.
  - `formatTokens(n)`, `formatBytes`/`formatCost` helpers.

### 3.2 `usage-tracker.ts` — server plugin

```ts
export const UsageTracker: Plugin = async ({ directory, client }) => { ... }
```

1. **On load:** ensure the store file for `directory` exists; run a one-time **backfill** (see §3.4). Register `event` hook.
2. **Event hook** — `switch (event.type)`:
   - `session.next.step.started` → put `{ assistantMessageID: { sessionID, model, agent } }` into a pending `Map`.
   - `session.next.step.ended` → pop pending by `assistantMessageID`; **increment** `models[providerID/modelID]` (input/output/reasoning/cache read/write, calls), `agents[agent]`, and `sessions[sessionID]` aggregates; mark `msg_` id as processed.
   - `session.next.compaction.started` → increment `compactions.total` (and `auto`/`manual` from the `reason`); also record on the session. (`session.compacted` also fires per compaction, so it is **not** handled to avoid double counting.)
   - `session.next.model.switched` → record on the session (optional, for "models used per session").
   - Ignore everything else.
3. **Persistence:** debounced write (e.g. flush at most every 2 s and always on `dispose()`) using **atomic write** (write `tmp` file then `rename`). Re-read before write if the file changed on disk to reduce cross-instance clobbering.
4. **`dispose()`:** flush pending writes.

### 3.3 `usage-tui.ts` — TUI plugin

```ts
export const UsageTui: TuiPlugin = async (api) => { ... }
```

1. **Register slash command** for discovery:
   ```ts
   api.keymap.registerLayer({
     commands: [{
       namespace: "palette", name: "usage", title: "Usage",
       desc: "Show token usage / models / compactions", slashName: "usage",
       run: () => openUsageFromPrompt(),
     }],
   })
   ```
2. **Enter-key interceptor** (the zero-token gate):
   ```ts
   api.keymap.intercept("key", ({ event }) => {
     const editor = api.renderer.currentFocusedEditor
     if (!editor) return
     const text = editor.plainText
     if (!text.startsWith("/usage")) return
     if (event.name !== "return") return          // only Enter
     event.preventDefault(); event.stopPropagation()
     handleUsage(text)                            // parse + dialog / canned error
     clearInput(editor)                           // remove "/usage ..." from the prompt
   }, { priority: 1 })
   ```
   - This covers `/usage`, `/usage models`, `/usage tree`, `/usage /path`, `/usage <model>`, and `/usage <garbage>` — **none** reach `session.prompt`.
   - The `slashName` registration only makes `/usage` appear in autocomplete for discoverability; the intercept is the single handler (the autocomplete's Enter select is beaten by the priority-1 intercept).
3. **`handleUsage(input)`** — parse args via `usage-lib.parseUsageArgs` against `api.state.path.directory`/`worktree`, read the global store, and render the matching dialog (below). Unknown input → canned error dialog.
4. **Reading the store:** on each invocation, read all `projects/*.json`, aggregate with `usage-lib`. Optionally re-read every ~2 s while a dialog is open for a live feel.

### 3.4 Backfill (historical data)

Run once per directory at tracker startup (only when the store file is newly created for that directory, to avoid double counting):

- `client.session.list()` paginated (`limit`, `cursor.next`).
- For each session, `client.session.messages({ sessionID })`.
- Count `Assistant` messages: `tokens`, `cost`, `model`, `agent`; count `Compaction` messages.
- Write aggregates into the store. Sessions already recorded in the store are skipped (incremental: only fetch messages newer than the session's stored `updated`).
- All counting is **idempotent**: live events push `msg_` ids into `sessions[id].processed`; backfill skips processed ids.

## 4. `/usage` argument parsing

`parseUsageArgs(input, cwd, worktree)`:

1. Strip leading `/usage`; trim.
2. Empty → **folder** view (current `directory`).
3. Reserved keywords (exact match): `models` → models ranking; `tree` → tree view; `help` → help; `reset` → reset store; `export` → write store to file.
4. Path-like (`/`, `.`, `..`, or resolves to an existing directory on disk) → **path** view (aggregate all tracked directories at/under that path; if none tracked, still show the folder with zeros).
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

- **Folder view**: folder path; totals (tokens input/output/reasoning/cache, calls); per-model table (model, input, output, calls, % share); per-agent table; sessions (top by tokens, incl. title, model, tokens, compactions); compaction count (auto/manual); current session highlighted via `api.route.current`.
- **Path view**: same as folder view but for the aggregated set of directories under the given path; shows the list of matched directories.
- **Model view**: model header; global totals; per-folder table (folder, input, output, calls, %); sessions using the model.
- **Models view**: ranked table (rank, model, provider, input, output, calls, #folders, #compactions) sorted by total tokens.
- **Tree view**: box/ASCII tree of directories from the store (rooted at the worktree or `~`), each node `name  [tokens · calls · models · compactions]`.
- **Help / error**: `api.ui.DialogAlert` (plain string props) or a small dialog.

## 6. Useful extras (optional, ordered by value)

1. **Estimated cost**: live events report `cost: 0`, so estimate spend from token counts using a small bundled price table (`providerID/modelID` → `$` per MTok, extendable via plugin options); backfill uses the real `cost` from messages.
2. **Per-agent stats**: `build`/`plan`/subagents — already captured in `agents`; surface in folder view.
3. **Reset**: `/usage reset` with confirm dialog deletes `projects/*.json`.
4. **Export**: `/usage export` writes `usage-export.json`/`.md` and toasts the path.
5. **Heaviest sessions**: folder view lists top-N sessions by tokens.
6. **Live refresh**: dialog re-reads the store every ~2 s while open.
7. **Session highlight**: mark the current session in tables.

## 7. Files to create

| File | Type | Purpose |
| --- | --- | --- |
| `USAGE-PLUGIN-PLAN.md` | plan | this document |
| `.opencode/plugins/lib/usage-lib.ts` | helper | store paths, schema, aggregation, tree, arg parsing, formatting (in `lib/` so the server's `plugins/*.ts` glob skips it) |
| `.opencode/plugins/usage-tracker.ts` | **server** plugin | event tracking + persistence + backfill |
| `.opencode/plugins/lib/usage-tui.ts` | **tui** plugin | `/usage` command, Enter intercept, dialogs (in `lib/`, declared via `tui.json`) |
| `.opencode/tui.json` | TUI config | declares the TUI plugin (`"plugin": ["./plugins/lib/usage-tui.ts"]`) — required, the TUI does not auto-discover plugin files |
| `.opencode/package.json` | deps | only if external packages are required (e.g. `solid-js`) |
| test files (see §8) | tests | unit tests for aggregation/parsing/tree |

Install: copy the `plugins/` directory and `tui.json` to `.opencode/` for project-local, or `~/.config/opencode/` for **global** (recommended, so every folder is tracked and `/usage models|tree|<model>` are meaningful). Both config dirs are auto-discovered by the server; the TUI plugin additionally requires the `tui.json` declaration in the same location.

## 8. Verification

1. **Unit tests** (run with `bun test` in the repo): aggregation merge, arg parsing (each branch incl. unknown), tree building, dedup, formatting.
2. **Integration, tracker**: install in a scratch project; run a few prompts with different models (switch via `/models`); force a compaction (`/compact`); confirm `projects/<hash>.json` contains expected `models`/`compactions`/`sessions`.
3. **Integration, TUI**: run `opencode`; type `/usage`, `/usage models`, `/usage tree`, `/usage <existing-path>`, `/usage <model-name>`, `/usage unknown-command-example-123` — each opens the expected dialog; the last shows the canned error.
4. **Zero-token proof**: for each `/usage` variant, confirm no request hits a provider. Reliable signal: run a provider with logging enabled, or check the OpenCode log/trace (`opencode run --trace` / `~/.local/share/opencode/log`) for the absence of a new assistant message / tool call for the `/usage` input; also confirm the prompt input is cleared after each invocation.
5. **Global aggregation**: run OpenCode in two different projects; `/usage models` and `/usage tree` reflect both.
6. **Restart**: close/reopen OpenCode; backfill must not double-count (compare totals before/after).

## 9. Known limitations / future work

- **TUI-only display.** In CLI `run`, Web, or IDE the `/usage` command has no dialog (tracking still runs). A future enhancement: a server `usage` **tool** + a `usage` command template so non-TUI surfaces get a rendered (LLM-formatted) answer — explicitly out of scope per the approved design.
- **Subdirectory/moved sessions**: events are routed to the plugin instance whose `directory` matches the session's directory; sessions moved to another directory are tracked by the instance running there. Edge case, acceptable.
- **`Step.Ended.cost` is 0**; real cost only via backfill or estimated via the optional price table.
- **Concurrent writers**: two OpenCode instances on the same directory last-writer-wins with atomic renames; no data corruption, but cross-instance merges on the same file are best-effort.
- **Local `.ts` files cannot use JSX syntax** (auto-discovery glob excludes `.tsx`); dialogs must be built with Solid element factories or the renderer API. Verify exact approach against the installed `@opentui`/`solid-js` versions during implementation.