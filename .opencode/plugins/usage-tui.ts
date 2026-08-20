import { writeFileSync } from "node:fs"
import path from "node:path"
import type { KeyEvent, TuiPlugin } from "@opencode-ai/plugin/tui"
import {
  aggregate,
  aggregateForPath,
  buildTree,
  currentDirectoryStore,
  findModel,
  formatDuration,
  formatMoney,
  formatTokens,
  listStores,
  parseUsageArgs,
  removeStoreFiles,
  type Aggregate,
  type DirectoryStore,
  type TreeNode,
  type UsageIntent,
} from "./usage-lib.ts"

type EditorLike = {
  plainText?: string
  logicalCursor?: { row: number; col: number }
  deleteRange?: (startRow: number, startCol: number, endRow: number, endCol: number) => void
}

const HELP_TEXT = `Usage commands:
  /usage              usage for the current folder
  /usage <path>       usage for a folder (absolute or relative)
  /usage <model>      global usage for a model
  /usage models       global model ranking
  /usage tree         folder tree with usage + models + compactions
  /usage export       write a usage report to usage-report.md
  /usage reset        clear all recorded usage
  /usage help         this help`

function col(value: string | number, width: number) {
  const s = String(value)
  if (s.length > width) return `${s.slice(0, Math.max(0, width - 1))}…`
  return s.padEnd(width)
}

function tokensLine(tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return [
    `input ${formatTokens(tokens.input)} · output ${formatTokens(tokens.output)} · reasoning ${formatTokens(tokens.reasoning)}`,
    `cache ${formatTokens(tokens.cacheRead)} read · ${formatTokens(tokens.cacheWrite)} write`,
  ].join("\n")
}

function folderView(
  directory: string,
  store: DirectoryStore | undefined,
  agg: Aggregate,
  currentSessionID: string | undefined,
) {
  const lines: string[] = []
  lines.push(`Usage — ${directory}`)
  if (!store) {
    lines.push("Nothing recorded yet for this folder. Usage is tracked as soon as a session runs.")
    return lines.join("\n")
  }
  lines.push(tokensLine(agg.totalTokens))
  lines.push(`calls ${agg.calls} · cost ${formatMoney(agg.totalCost)} · folders ${agg.stores.length}`)
  lines.push(
    `compactions ${agg.compactions.total} (${agg.compactions.auto} auto · ${agg.compactions.manual} manual)`,
  )
  lines.push("")
  const models = Object.entries(store.models).sort(
    (a, b) => b[1].input + b[1].output - (a[1].input + a[1].output),
  )
  if (models.length > 0) {
    lines.push("MODELS")
    lines.push(`${col("model", 28)}${col("input", 9)}${col("output", 9)}${col("calls", 6)}${col("cost", 9)}${col("share", 6)}`)
    const totalTokens = Math.max(1, agg.totalTokens.input + agg.totalTokens.output)
    for (const [key, model] of models) {
      const share = ((model.input + model.output) / totalTokens) * 100
      lines.push(
        `${col(key, 28)}${col(formatTokens(model.input), 9)}${col(formatTokens(model.output), 9)}${col(model.calls, 6)}${col(formatMoney(model.cost), 9)}${col(`${share.toFixed(0)}%`, 6)}`,
      )
    }
  }
  const agents = Object.entries(agg.agents).sort((a, b) => b[1].calls - a[1].calls)
  if (agents.length > 0) {
    lines.push("")
    lines.push("AGENTS")
    for (const [key, agent] of agents) {
      lines.push(
        `${col(key, 28)}${col(`${agent.calls} calls`, 10)}${col(formatTokens(agent.input), 9)}${col(formatTokens(agent.output), 9)} in/out`,
      )
    }
  }
  const sessions = Object.entries(store.sessions)
    .sort((a, b) => b[1].tokens.input + b[1].tokens.output - (a[1].tokens.input + a[1].tokens.output))
    .slice(0, 5)
  if (sessions.length > 0) {
    lines.push("")
    lines.push("SESSIONS")
    lines.push(`${col("#", 2)}${col("title", 32)}${col("tokens", 9)}${col("models", 6)}${col("comp", 5)}${col("age", 10)}`)
    for (const [index, [sessionID, session]] of sessions.entries()) {
      const marker = sessionID === currentSessionID ? "*" : ""
      const title = session.title || "(untitled)"
      lines.push(
        `${col(index + 1, 2)}${col(marker + title, 32)}${col(formatTokens(session.tokens.input + session.tokens.output), 9)}${col(Object.keys(session.models).length, 6)}${col(session.compactions, 5)}${col(formatDuration(session.updated), 10)}`,
      )
    }
  }
  return lines.join("\n")
}

function pathView(agg: Aggregate, absPath: string) {
  const lines: string[] = []
  lines.push(`Usage — ${absPath}`)
  if (agg.stores.length === 0) {
    lines.push("No tracked usage under this path yet.")
    return lines.join("\n")
  }
  lines.push(`folders ${agg.stores.length}`)
  for (const store of agg.stores) lines.push(`  ${store.directory}`)
  lines.push("")
  lines.push(tokensLine(agg.totalTokens))
  lines.push(`calls ${agg.calls} · cost ${formatMoney(agg.totalCost)}`)
  lines.push(`compactions ${agg.compactions.total} (${agg.compactions.auto} auto · ${agg.compactions.manual} manual)`)
  lines.push("")
  lines.push("MODELS")
  lines.push(`${col("model", 28)}${col("input", 9)}${col("output", 9)}${col("calls", 6)}${col("cost", 9)}`)
  for (const model of agg.models) {
    lines.push(
      `${col(model.modelKey, 28)}${col(formatTokens(model.input), 9)}${col(formatTokens(model.output), 9)}${col(model.calls, 6)}${col(formatMoney(model.cost), 9)}`,
    )
  }
  return lines.join("\n")
}

function modelView(stores: DirectoryStore[], query: string, model: Aggregate["models"][number]) {
  const lines: string[] = []
  lines.push(`Model — ${model.modelKey}`)
  lines.push(tokensLine(model))
  lines.push(`calls ${model.calls} · cost ${formatMoney(model.cost)} · folders ${model.folders.length}`)
  lines.push("")
  lines.push("FOLDERS")
  lines.push(`${col("folder", 34)}${col("input", 9)}${col("output", 9)}${col("calls", 6)}${col("cost", 9)}`)
  for (const store of stores) {
    const usage = store.models[model.modelKey]
    if (!usage) continue
    lines.push(
      `${col(store.directory, 34)}${col(formatTokens(usage.input), 9)}${col(formatTokens(usage.output), 9)}${col(usage.calls, 6)}${col(formatMoney(usage.cost), 9)}`,
    )
  }
  lines.push("")
  lines.push("SESSIONS")
  const sessions = stores
    .flatMap((store) =>
      Object.entries(store.sessions).map(([sessionID, session]) => ({ sessionID, store: store.directory, session })),
    )
    .filter((entry) => entry.session.models[model.modelKey])
    .sort(
      (a, b) =>
        (b.session.models[model.modelKey]?.input ?? 0) +
        (b.session.models[model.modelKey]?.output ?? 0) -
        ((a.session.models[model.modelKey]?.input ?? 0) + (a.session.models[model.modelKey]?.output ?? 0)),
    )
    .slice(0, 5)
  for (const entry of sessions) {
    const usage = entry.session.models[model.modelKey]!
    lines.push(
      `${col(entry.session.title || "(untitled)", 34)}${col(formatTokens(usage.input + usage.output), 9)}${col(usage.calls, 6)}${col(formatDuration(entry.session.updated), 10)}`,
    )
  }
  if (sessions.length === 0) lines.push("(no sessions using this model)")
  return lines.join("\n")
}

function modelsView(agg: Aggregate) {
  const lines: string[] = []
  lines.push(`Models — ${agg.stores.length} folder(s)`)
  lines.push(tokensLine(agg.totalTokens))
  lines.push(`calls ${agg.calls} · cost ${formatMoney(agg.totalCost)}`)
  lines.push("")
  lines.push(`${col("#", 3)}${col("model", 32)}${col("input", 9)}${col("output", 9)}${col("calls", 6)}${col("cost", 9)}${col("folders", 8)}${col("comp", 5)}`)
  for (const [index, model] of agg.models.slice(0, 40).entries()) {
    const compactions = agg.stores.filter((store) => store.models[model.modelKey]).reduce((sum, store) => sum + store.compactions.total, 0)
    lines.push(
      `${col(index + 1, 3)}${col(model.modelKey, 32)}${col(formatTokens(model.input), 9)}${col(formatTokens(model.output), 9)}${col(model.calls, 6)}${col(formatMoney(model.cost), 9)}${col(model.folders.length, 8)}${col(compactions, 5)}`,
    )
  }
  return lines.join("\n")
}

function treeView(root: TreeNode) {
  const lines: string[] = []
  lines.push(`Usage tree — ${root.path}`)
  const render = (node: TreeNode, depth: number) => {
    const tokens = node.tokens.input + node.tokens.output
    const suffix = `${formatTokens(tokens)} · ${node.calls} calls · ${node.modelCount} models · ${node.compactions} compactions · ${node.sessions} sessions`
    if (depth === 0) {
      lines.push(`${node.name === "/" ? "/" : node.name}  ${suffix}`)
    } else {
      lines.push(`${"  ".repeat(depth)}${node.name}  ${suffix}`)
    }
    const children = [...node.children].sort((a, b) => b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output))
    for (const child of children) render(child, depth + 1)
  }
  render(root, 0)
  return lines.join("\n")
}

function errorView(query: string) {
  return `Unknown usage query: "${query}"
Valid invocations:
  /usage              usage for the current folder
  /usage <path>       usage for a folder (absolute or relative)
  /usage <model>      global usage for a model
  /usage models       global model ranking
  /usage tree         folder tree with usage + models + compactions
  /usage help         this help`
}

function buildReport(stores: DirectoryStore[]) {
  const agg = aggregate(stores)
  const lines: string[] = []
  lines.push("# OpenCode usage report")
  lines.push("")
  lines.push(`- folders: ${agg.stores.length}`)
  lines.push(`- calls: ${agg.calls}`)
  lines.push(`- cost: ${formatMoney(agg.totalCost)}`)
  lines.push(`- compactions: ${agg.compactions.total} (${agg.compactions.auto} auto · ${agg.compactions.manual} manual)`)
  lines.push("")
  lines.push("## Models")
  lines.push("")
  lines.push("| model | input | output | reasoning | cache read | cache write | calls | cost | folders |")
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const model of agg.models) {
    lines.push(
      `| ${model.modelKey} | ${model.input} | ${model.output} | ${model.reasoning} | ${model.cacheRead} | ${model.cacheWrite} | ${model.calls} | ${formatMoney(model.cost)} | ${model.folders.length} |`,
    )
  }
  lines.push("")
  lines.push("## Folders")
  lines.push("")
  for (const store of agg.stores) {
    const folderTokens = Object.values(store.models).reduce(
      (sum, model) => ({ ...sum, input: sum.input + model.input, output: sum.output + model.output }),
      { input: 0, output: 0 },
    )
    lines.push(`- ${store.directory}: ${formatTokens(folderTokens.input)} in · ${formatTokens(folderTokens.output)} out · ${store.compactions.total} compactions`)
  }
  return lines.join("\n")
}

const tui: TuiPlugin = async (api) => {
  const show = (title: string, message: string, size: "large" | "xlarge" = "large") => {
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title,
        message,
        onConfirm: () => {},
      }),
    )
    api.ui.dialog.setSize(size)
  }

  const handleUsage = (rawText: string | undefined) => {
    const cwd = api.state.path.directory
    const worktree = api.state.path.worktree
    const stores = listStores()
    const intent = parseUsageArgs(rawText ?? "/usage", cwd, worktree)
    const currentSessionID = api.route.current?.name === "session" ? (api.route.current.params as any)?.sessionID : undefined

    switch (intent.kind) {
      case "folder": {
        const store = currentDirectoryStore(stores, cwd)
        const agg = store ? aggregate([store]) : aggregate([])
        show("Usage", folderView(cwd, store, agg, currentSessionID))
        return
      }
      case "path": {
        const agg = aggregateForPath(stores, intent.path)
        show("Usage", pathView(agg, intent.path), "xlarge")
        return
      }
      case "model": {
        const model = findModel(stores, intent.query)
        if (!model) {
          show("Usage", errorView(intent.query))
          return
        }
        show("Usage", modelView(stores, intent.query, model), "xlarge")
        return
      }
      case "models": {
        const agg = aggregate(stores)
        if (agg.models.length === 0) {
          show("Models", "No usage recorded yet.", "large")
          return
        }
        show("Models", modelsView(agg), "xlarge")
        return
      }
      case "tree": {
        const root = buildTree(stores)
        if (!root) {
          show("Usage tree", "No usage recorded yet.", "large")
          return
        }
        show("Usage tree", treeView(root), "xlarge")
        return
      }
      case "help": {
        show("Usage", HELP_TEXT, "large")
        return
      }
      case "export": {
        try {
          const file = path.join(worktree || cwd, "usage-report.md")
          writeFileSync(file, buildReport(stores))
          api.ui.toast({ message: `Usage report written to ${file}`, variant: "success" })
        } catch {
          api.ui.toast({ message: "Failed to write usage report", variant: "error" })
        }
        return
      }
      case "reset": {
        api.ui.dialog.replace(() =>
          api.ui.DialogConfirm({
            title: "Reset usage data",
            message: "Delete all recorded usage across all folders?",
            onConfirm: () => {
              removeStoreFiles()
              api.ui.toast({ message: "Usage data cleared", variant: "success" })
            },
            onCancel: () => {},
          }),
        )
        return
      }
      case "error": {
        show("Usage", errorView(intent.message))
        return
      }
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "usage.show",
        title: "Usage",
        desc: "Show token usage, models and compactions",
        slashName: "usage",
        category: "Usage",
        namespace: "palette",
        run: () => {
          handleUsage(undefined)
        },
      },
    ],
  })

  api.keymap.intercept(
    "key",
    ({ event }: { event: KeyEvent }) => {
      if (event.name !== "return") return
      const editor = api.renderer.currentFocusedEditor as EditorLike | undefined
      if (!editor) return
      const text = editor.plainText ?? ""
      if (!/^\/(usage|tokens)\b/.test(text.trimStart())) return
      event.preventDefault()
      event.stopPropagation()
      const cursor = editor.logicalCursor
      if (cursor && editor.deleteRange) {
        editor.deleteRange(0, 0, cursor.row, cursor.col)
      }
      api.keymap.dispatchCommand("prompt.autocomplete.hide")
      handleUsage(text)
    },
    { priority: 1 },
  )
}

export default {
  id: "usage-counter-tui",
  tui,
}