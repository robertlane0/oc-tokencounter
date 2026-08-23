import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"


export type Tokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type ModelUsage = Tokens & {
  calls: number
  lastUsed: number
  cost: number
}

export type AgentUsage = {
  calls: number
  input: number
  output: number
  reasoning: number
}

export type SessionModelUsage = {
  input: number
  output: number
  reasoning: number
  calls: number
  cost: number
}

export type SessionRecord = {
  title: string
  created: number
  updated: number
  tokens: Tokens
  cost: number
  models: Record<string, SessionModelUsage>
  compactions: number
  lastModel: string | undefined
  processed: string[]
}

export type DirectoryStore = {
  version: 1
  directory: string
  worktree: string
  models: Record<string, ModelUsage>
  agents: Record<string, AgentUsage>
  compactions: { total: number; auto: number; manual: number }
  sessions: Record<string, SessionRecord>
  updated: number
}

export type AggregateModel = ModelUsage & {
  modelKey: string
  folders: string[]
}

export type AggregateSession = {
  sessionID: string
  directory: string
  title: string
  created: number
  updated: number
  tokens: Tokens
  cost: number
  models: Record<string, SessionModelUsage>
  compactions: number
}

export type Aggregate = {
  stores: DirectoryStore[]
  models: AggregateModel[]
  agents: Record<string, AgentUsage>
  compactions: { total: number; auto: number; manual: number }
  sessions: AggregateSession[]
  totalTokens: Tokens
  totalCost: number
  calls: number
}

export type TreeNode = {
  name: string
  path: string
  tokens: Tokens
  calls: number
  cost: number
  modelCount: number
  compactions: number
  sessions: number
  children: TreeNode[]
}

export type UsageIntent =
  | { kind: "folder" }
  | { kind: "path"; path: string }
  | { kind: "model"; query: string }
  | { kind: "models" }
  | { kind: "tree" }
  | { kind: "help" }
  | { kind: "reset" }
  | { kind: "export" }
  | { kind: "error"; message: string }


export function dataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

export function storeRoot() {
  return path.join(dataHome(), "opencode", "plugins", "usage-counter", "projects")
}

export function directoryKey(directory: string) {
  return createHash("sha1").update(path.resolve(directory)).digest("hex")
}

export function storeFileFor(directory: string, root: string = storeRoot()) {
  return path.join(root, `${directoryKey(directory)}.json`)
}


export function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptyStore(directory: string, worktree: string): DirectoryStore {
  return {
    version: 1,
    directory: path.resolve(directory),
    worktree: path.resolve(worktree || directory),
    models: {},
    agents: {},
    compactions: { total: 0, auto: 0, manual: 0 },
    sessions: {},
    updated: 0,
  }
}

function normalizeTokens(raw: unknown): Tokens {
  const t = (raw ?? {}) as Record<string, unknown>
  const cache = (t.cache ?? {}) as Record<string, unknown>
  return {
    input: numberOr(t.input, 0),
    output: numberOr(t.output, 0),
    reasoning: numberOr(t.reasoning, 0),
    cacheRead: numberOr(cache.read, 0),
    cacheWrite: numberOr(cache.write, 0),
  }
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function normalizeStore(raw: unknown, directory: string, worktree: string): DirectoryStore {
  const r = (raw ?? {}) as Partial<DirectoryStore>
  const store = emptyStore(directory, worktree)
  if (r.version !== 1) return store
  store.worktree = typeof r.worktree === "string" && r.worktree ? r.worktree : store.worktree
  store.updated = numberOr(r.updated, 0)
  for (const [key, value] of Object.entries(r.models ?? {})) {
    const m = (value ?? {}) as Partial<ModelUsage>
    store.models[key] = {
      ...normalizeTokens(m),
      calls: numberOr(m.calls, 0),
      lastUsed: numberOr(m.lastUsed, 0),
      cost: numberOr(m.cost, 0),
    }
  }
  for (const [key, value] of Object.entries(r.agents ?? {})) {
    const a = (value ?? {}) as Partial<AgentUsage>
    store.agents[key] = {
      calls: numberOr(a.calls, 0),
      input: numberOr(a.input, 0),
      output: numberOr(a.output, 0),
      reasoning: numberOr(a.reasoning, 0),
    }
  }
  const comp = (r.compactions ?? {}) as Partial<DirectoryStore["compactions"]>
  store.compactions = {
    total: numberOr(comp.total, 0),
    auto: numberOr(comp.auto, 0),
    manual: numberOr(comp.manual, 0),
  }
  for (const [sessionID, value] of Object.entries(r.sessions ?? {})) {
    const s = (value ?? {}) as Partial<SessionRecord>
    const models: SessionRecord["models"] = {}
    for (const [key, mv] of Object.entries(s.models ?? {})) {
      const m = (mv ?? {}) as Partial<SessionModelUsage>
      models[key] = {
        input: numberOr(m.input, 0),
        output: numberOr(m.output, 0),
        reasoning: numberOr(m.reasoning, 0),
        calls: numberOr(m.calls, 0),
        cost: numberOr(m.cost, 0),
      }
    }
    store.sessions[sessionID] = {
      title: typeof s.title === "string" ? s.title : "",
      created: numberOr(s.created, 0),
      updated: numberOr(s.updated, 0),
      tokens: normalizeTokens(s.tokens),
      cost: numberOr(s.cost, 0),
      models,
      compactions: numberOr(s.compactions, 0),
      lastModel: typeof s.lastModel === "string" ? s.lastModel : undefined,
      processed: Array.isArray(s.processed) ? s.processed.filter((x) => typeof x === "string") : [],
    }
  }
  return store
}

export function loadStore(directory: string, worktree: string, root: string = storeRoot()): DirectoryStore {
  const file = storeFileFor(directory, root)
  if (existsSync(file)) {
    try {
      return normalizeStore(JSON.parse(readFileSync(file, "utf8")), directory, worktree)
    } catch {

    }
  }
  return emptyStore(directory, worktree)
}

export function saveStore(store: DirectoryStore, root: string = storeRoot()) {
  const file = storeFileFor(store.directory, root)
  mkdirSync(root, { recursive: true })
  store.updated = Date.now()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
}

export function listStores(root: string = storeRoot()): DirectoryStore[] {
  if (!existsSync(root)) return []
  const stores: DirectoryStore[] = []
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue
    try {
      const raw = JSON.parse(readFileSync(path.join(root, entry), "utf8")) as Partial<DirectoryStore>
      if (raw.version === 1 && typeof raw.directory === "string") {
        stores.push(normalizeStore(raw, raw.directory, typeof raw.worktree === "string" ? raw.worktree : raw.directory))
      }
    } catch {

    }
  }
  return stores
}

export function removeStoreFiles(root: string = storeRoot()) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    if (entry.endsWith(".json")) {
      try {
        unlinkSync(path.join(root, entry))
      } catch {

      }
    }
  }
}


export function modelKey(providerID: string | undefined, id: string | undefined) {
  if (providerID && id) return `${providerID}/${id}`
  return id || "unknown/unknown"
}

function ensureSession(store: DirectoryStore, sessionID: string): SessionRecord {
  let session = store.sessions[sessionID]
  if (!session) {
    session = {
      title: "",
      created: Date.now(),
      updated: 0,
      tokens: emptyTokens(),
      cost: 0,
      models: {},
      compactions: 0,
      lastModel: undefined,
      processed: [],
    }
    store.sessions[sessionID] = session
  }
  return session
}

function addTokens(target: Tokens, source: Tokens) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  return target
}

function pushProcessed(session: SessionRecord, messageID: string, max = 500) {
  if (session.processed.includes(messageID)) return
  session.processed.push(messageID)
  if (session.processed.length > max) {
    session.processed.splice(0, session.processed.length - max)
  }
}

export function applyStep(
  store: DirectoryStore,
  sessionID: string,
  assistantMessageID: string | undefined,
  model: string | undefined,
  agent: string | undefined,
  tokens: Tokens,
  cost: number,
  now: number,
) {
  const key = model ?? "unknown/unknown"
  const modelUsage = store.models[key] ?? {
    ...emptyTokens(),
    calls: 0,
    lastUsed: 0,
    cost: 0,
  }
  addTokens(modelUsage, tokens)
  modelUsage.calls += 1
  modelUsage.lastUsed = now
  modelUsage.cost += numberOr(cost, 0)
  store.models[key] = modelUsage

  const agentName = agent || "unknown"
  const agentUsage = store.agents[agentName] ?? { calls: 0, input: 0, output: 0, reasoning: 0 }
  agentUsage.calls += 1
  agentUsage.input += tokens.input
  agentUsage.output += tokens.output
  agentUsage.reasoning += tokens.reasoning
  store.agents[agentName] = agentUsage

  const session = ensureSession(store, sessionID)
  addTokens(session.tokens, tokens)
  session.cost += numberOr(cost, 0)
  session.lastModel = key
  session.updated = now
  const sessionModel = session.models[key] ?? { input: 0, output: 0, reasoning: 0, calls: 0, cost: 0 }
  sessionModel.input += tokens.input
  sessionModel.output += tokens.output
  sessionModel.reasoning += tokens.reasoning
  sessionModel.calls += 1
  sessionModel.cost += numberOr(cost, 0)
  session.models[key] = sessionModel
  if (assistantMessageID) pushProcessed(session, assistantMessageID)
}

export function applyCompaction(store: DirectoryStore, sessionID: string, reason: string | undefined, now: number) {
  store.compactions.total += 1
  if (reason === "auto") store.compactions.auto += 1
  else if (reason === "manual") store.compactions.manual += 1
  const session = ensureSession(store, sessionID)
  session.compactions += 1
  session.updated = now
}

export function applyBackfillSession(
  store: DirectoryStore,
  sessionID: string,
  title: string | undefined,
  created: number | undefined,
  updated: number | undefined,
  messages: Array<{ info?: Record<string, any>; parts?: Array<Record<string, any>> }>,
) {
  const session = ensureSession(store, sessionID)
  if (title) session.title = title
  if (created) session.created = created
  session.updated = Math.max(session.updated, updated || 0)

  let agent = "unknown"
  for (const message of messages) {
    const info = message?.info
    if (!info) continue
    if (info.role === "user") {
      if (typeof info.agent === "string" && info.agent) agent = info.agent
      continue
    }
    if (info.role !== "assistant") continue
    // Assistant messages are persisted as soon as the turn starts, with zero
    // tokens; tokens/cost/time.completed only land when the step finishes.
    // Skip in-flight messages so they get counted on a later pass once they
    // actually complete — counting them now would mark them processed and
    // permanently lose their real usage.
    if (!info.time?.completed) continue
    if (!info.id || session.processed.includes(info.id)) continue
    const tokens = normalizeTokens(info.tokens)
    const key = modelKey(info.providerID, info.modelID)
    const completed = numberOr(info.time.completed, numberOr(info.time?.created, Date.now()))
    applyStep(store, sessionID, info.id, key, agent, tokens, numberOr(info.cost, 0), completed)
  }
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part?.type === "compaction") {
        if (part.id && session.processed.includes(part.id)) continue
        if (part.id) pushProcessed(session, part.id)
        applyCompaction(store, sessionID, part.auto === true ? "auto" : "manual", numberOr(part.time?.created, Date.now()))
      }
    }
  }
  session.updated = Math.max(session.updated, updated || 0)
}

function storeAggregate(store: DirectoryStore): Omit<Aggregate, "stores" | "models" | "sessions"> {
  const totalTokens = emptyTokens()
  let totalCost = 0
  let calls = 0
  for (const model of Object.values(store.models)) {
    addTokens(totalTokens, model)
    totalCost += model.cost
    calls += model.calls
  }
  return { agents: store.agents, compactions: store.compactions, totalTokens, totalCost, calls }
}

export function aggregate(stores: DirectoryStore[]): Aggregate {
  const models: AggregateModel[] = []
  const agents: Record<string, AgentUsage> = {}
  const compactions = { total: 0, auto: 0, manual: 0 }
  const sessions: AggregateSession[] = []
  const totalTokens = emptyTokens()
  let totalCost = 0
  let calls = 0

  for (const store of stores) {
    for (const [key, model] of Object.entries(store.models)) {
      let entry = models.find((m) => m.modelKey === key)
      if (!entry) {
        entry = { modelKey: key, folders: [], ...emptyTokens(), calls: 0, lastUsed: 0, cost: 0 }
        models.push(entry)
      }
      addTokens(entry, model)
      entry.calls += model.calls
      entry.cost += model.cost
      if (model.lastUsed > entry.lastUsed) entry.lastUsed = model.lastUsed
      if (!entry.folders.includes(store.directory)) entry.folders.push(store.directory)
    }
    for (const [key, agent] of Object.entries(store.agents)) {
      const entry = agents[key] ?? { calls: 0, input: 0, output: 0, reasoning: 0 }
      entry.calls += agent.calls
      entry.input += agent.input
      entry.output += agent.output
      entry.reasoning += agent.reasoning
      agents[key] = entry
    }
    compactions.total += store.compactions.total
    compactions.auto += store.compactions.auto
    compactions.manual += store.compactions.manual
    for (const [sessionID, session] of Object.entries(store.sessions)) {
      sessions.push({
        sessionID,
        directory: store.directory,
        title: session.title,
        created: session.created,
        updated: session.updated,
        tokens: { ...session.tokens },
        cost: session.cost,
        models: session.models,
        compactions: session.compactions,
      })
    }
    const agg = storeAggregate(store)
    addTokens(totalTokens, agg.totalTokens)
    totalCost += agg.totalCost
    calls += agg.calls
  }

  models.sort((a, b) => b.input + b.output - (a.input + a.output))
  return { stores, models, agents, compactions, sessions, totalTokens, totalCost, calls }
}

export function aggregateForPath(stores: DirectoryStore[], absPath: string): Aggregate {
  const prefix = `${path.resolve(absPath)}${path.sep}`
  const matches = stores.filter((store) => store.directory === path.resolve(absPath) || store.directory.startsWith(prefix))
  return aggregate(matches)
}

export function currentDirectoryStore(stores: DirectoryStore[], directory: string): DirectoryStore | undefined {
  return stores.find((store) => store.directory === path.resolve(directory))
}


function commonRoot(dirs: string[]) {
  if (dirs.length === 0) return path.parse(path.resolve("/")).root
  const segments = dirs.map((d) => path.resolve(d).split(path.sep).filter(Boolean))
  let i = 0
  while (i < segments[0].length && segments.every((s) => s[i] === segments[0][i])) i += 1
  return `${path.sep}${segments[0].slice(0, i).join(path.sep)}`
}

function makeNode(name: string, fullPath: string): TreeNode {
  return {
    name,
    path: fullPath,
    tokens: emptyTokens(),
    calls: 0,
    cost: 0,
    modelCount: 0,
    compactions: 0,
    sessions: 0,
    children: [],
  }
}

function addStoreToTree(root: TreeNode, store: DirectoryStore) {
  const rel = path.relative(root.path, store.directory)
  // rel === "" means the store lives exactly at the tree root (e.g. the only
  // tracked folder, or a parent that also has its own sessions). Its stats
  // belong on the node itself — skipping it used to render empty trees.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return
  let node = root
  const parts = rel.split(path.sep).filter(Boolean)
  for (const part of parts) {
    let child = node.children.find((c) => c.name === part)
    if (!child) {
      child = makeNode(part, path.join(node.path, part))
      node.children.push(child)
    }
    node = child
  }
  const agg = storeAggregate(store)
  addTokens(node.tokens, agg.totalTokens)
  node.calls += agg.calls
  node.cost += agg.totalCost
  node.modelCount = Object.keys(store.models).length
  node.compactions += store.compactions.total
  node.sessions = Object.keys(store.sessions).length
}

function sumTree(node: TreeNode) {
  for (const child of node.children) {
    sumTree(child)
    addTokens(node.tokens, child.tokens)
    node.calls += child.calls
    node.cost += child.cost
    node.compactions += child.compactions
    node.sessions += child.sessions
    node.modelCount = Math.max(node.modelCount, child.modelCount)
  }
}

export function buildTree(stores: DirectoryStore[]): TreeNode | undefined {
  if (stores.length === 0) return undefined
  const rootPath = commonRoot(stores.map((s) => s.directory))
  const root = makeNode(path.basename(rootPath) || rootPath, rootPath)
  for (const store of stores) addStoreToTree(root, store)
  sumTree(root)
  return root
}


export function findModel(stores: DirectoryStore[], query: string): AggregateModel | undefined {
  const agg = aggregate(stores)
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const exact = agg.models.find((m) => m.modelKey.toLowerCase() === q || m.modelKey.toLowerCase().endsWith(`/${q}`))
  if (exact) return exact
  const matches = agg.models
    .filter((m) => m.modelKey.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.modelKey.toLowerCase().startsWith(q) ? 0 : 1
      const bStarts = b.modelKey.toLowerCase().startsWith(q) ? 0 : 1
      return aStarts - bStarts || a.modelKey.length - b.modelKey.length
    })
  return matches[0]
}


export function parseUsageArgs(text: string, cwd: string, worktree: string): UsageIntent {
  const match = text.trimStart().match(/^\/(usage|tokens)\b\s*(.*)$/s)
  const arg = (match ? match[2] : text).trim()
  if (!arg) return { kind: "folder" }
  const lower = arg.toLowerCase()
  if (lower === "models") return { kind: "models" }
  if (lower === "tree") return { kind: "tree" }
  if (lower === "help") return { kind: "help" }
  if (lower === "reset") return { kind: "reset" }
  if (lower === "export") return { kind: "export" }
  const base = cwd || worktree || process.cwd()
  if (arg.startsWith("/") || arg.startsWith(".") || arg.includes(path.sep) || existsSync(path.resolve(base, arg))) {
    return { kind: "path", path: path.resolve(base, arg) }
  }
  return { kind: "model", query: arg }
}


export function formatTokens(n: number) {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

export function formatMoney(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "$0.00"
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

export function formatDuration(ms: number) {
  if (!ms) return ""
  const minutes = Math.floor((Date.now() - ms) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}