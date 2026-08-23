import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  aggregate,
  aggregateForPath,
  applyBackfillSession,
  applyCompaction,
  applyStep,
  buildTree,
  directoryKey,
  emptyStore,
  findModel,
  formatMoney,
  formatTokens,
  listStores,
  loadStore,
  modelKey,
  parseUsageArgs,
  saveStore,
  storeFileFor,
} from "../.opencode/plugins/lib/usage-lib.ts"

const dir = "/projects/alpha"
const tmp = mkdtempSync(path.join(os.tmpdir(), "usage-counter-test-"))
const root = path.join(tmp, "store")

function tokens(input: number, output = 0) {
  return { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

describe("store paths", () => {
  it("directoryKey is deterministic", () => {
    assert.equal(directoryKey(dir), directoryKey(dir))
    assert.notEqual(directoryKey(dir), directoryKey("/projects/beta"))
  })
  it("storeFileFor derives from directory key", () => {
    assert.equal(storeFileFor(dir, root), path.join(root, `${directoryKey(dir)}.json`))
  })
  it("modelKey combines provider and id", () => {
    assert.equal(modelKey("openai", "gpt-5"), "openai/gpt-5")
    assert.equal(modelKey(undefined, "gpt-5"), "gpt-5")
    assert.equal(modelKey(undefined, undefined), "unknown/unknown")
  })
})

describe("applyStep", () => {
  it("records model, agent and session usage", () => {
    const store = emptyStore(dir, "/projects")
    applyStep(store, "s1", "msg1", "openai/gpt-5", "build", tokens(100, 20), 0.01, 1000)
    applyStep(store, "s1", "msg2", "openai/gpt-5", "build", tokens(50), 0.005, 2000)
    assert.equal(store.models["openai/gpt-5"].calls, 2)
    assert.equal(store.models["openai/gpt-5"].input, 150)
    assert.equal(store.models["openai/gpt-5"].cost, 0.015)
    assert.equal(store.agents["build"].calls, 2)
    assert.equal(store.sessions["s1"].models["openai/gpt-5"].calls, 2)
    assert.equal(store.sessions["s1"].processed.length, 2)
  })
  it("falls back for unknown model and agent", () => {
    const store = emptyStore(dir, "/projects")
    applyStep(store, "s1", "msg1", undefined, undefined, tokens(10), 0, 1000)
    assert.ok(store.models["unknown/unknown"])
    assert.ok(store.agents["unknown"])
  })
})

describe("applyCompaction", () => {
  it("counts auto and manual", () => {
    const store = emptyStore(dir, "/projects")
    applyCompaction(store, "s1", "auto", 1000)
    applyCompaction(store, "s1", "manual", 2000)
    assert.deepEqual(store.compactions, { total: 2, auto: 1, manual: 1 })
    assert.equal(store.sessions["s1"].compactions, 2)
  })
})

describe("applyBackfillSession", () => {
  const messages = [
    { info: { id: "u1", role: "user", agent: "build" }, parts: [] },
    {
      info: {
        id: "a1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        cost: 0.02,
        time: { created: 100, completed: 150 },
        tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 100, write: 0 } },
      },
      parts: [{ id: "p1", type: "text" }],
    },
    {
      info: {
        id: "a2",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        time: { created: 200, completed: 250 },
        tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "p2", type: "compaction", auto: true }],
    },
  ]

  it("counts assistant messages and compaction parts", () => {
    const store = emptyStore(dir, "/projects")
    applyBackfillSession(store, "s1", "Fix bug", 100, 200, messages as any)
    const model = store.models["openai/gpt-5"]
    assert.equal(model.calls, 2)
    assert.equal(model.input, 210)
    assert.equal(model.cacheRead, 100)
    assert.equal(model.cost, 0.02)
    assert.equal(store.sessions["s1"].compactions, 1)
    assert.equal(store.compactions.auto, 1)
    assert.equal(store.sessions["s1"].title, "Fix bug")
    applyBackfillSession(store, "s1", "Fix bug", 100, 200, messages as any)
    assert.equal(store.models["openai/gpt-5"].calls, 2)
  })

  it("does not count or record in-flight assistant messages until they complete", () => {
    const store = emptyStore(dir, "/projects")
    const streaming = [
      { info: { id: "u9", role: "user", agent: "build" }, parts: [] },
      {
        // Mirrors a live turn: persisted at start with zero tokens and no
        // time.completed; tokens only land when the step finishes.
        info: {
          id: "a9",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          cost: 0,
          time: { created: 500 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ]
    applyBackfillSession(store, "s1", "WIP", 400, 500, streaming as any)
    assert.equal(store.models["openai/gpt-5"], undefined)
    assert.equal(store.sessions["s1"]?.processed.includes("a9"), false)

    const completed = [
      streaming[0],
      {
        info: {
          ...streaming[1]!.info,
          cost: 0.03,
          time: { created: 500, completed: 900 },
          tokens: { input: 300, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ]
    applyBackfillSession(store, "s1", "WIP", 400, 900, completed as any)
    assert.equal(store.models["openai/gpt-5"].calls, 1)
    assert.equal(store.models["openai/gpt-5"].input, 300)
    assert.equal(store.models["openai/gpt-5"].cost, 0.03)
  })
})

describe("persistence", () => {
  it("round-trips through save/load", () => {
    const store = emptyStore(dir, "/projects")
    applyStep(store, "s1", "msg1", "openai/gpt-5", "build", tokens(100), 0.01, 1000)
    saveStore(store, root)
    const loaded = loadStore(dir, "/projects", root)
    assert.equal(loaded.models["openai/gpt-5"].input, 100)
    assert.equal(loaded.sessions["s1"].processed.length, 1)
    assert.equal(loaded.version, 1)
  })
  it("listStores returns all stores", () => {
    const a = emptyStore(dir, "/projects")
    saveStore(a, root)
    const b = emptyStore("/projects/beta", "/projects")
    applyStep(b, "s2", "m1", "anthropic/claude", "plan", tokens(5), 0, 1000)
    saveStore(b, root)
    const stores = listStores(root)
    assert.equal(stores.length, 2)
  })
  it("loadStore tolerates corrupt files", () => {
    const file = storeFileFor("/projects/corrupt", root)
    writeFileSync(file, "{not json")
    const store = loadStore("/projects/corrupt", "/projects", root)
    assert.equal(store.models["openai/gpt-5"]?.calls ?? undefined, undefined)
    assert.equal(store.version, 1)
  })
})

describe("aggregate", () => {
  const a = emptyStore(dir, "/projects")
  applyStep(a, "s1", "m1", "openai/gpt-5", "build", tokens(100, 20), 0.01, 1000)
  applyCompaction(a, "s1", "auto", 1000)
  const b = emptyStore("/projects/beta", "/projects")
  applyStep(b, "s2", "m2", "anthropic/claude", "plan", tokens(50), 0.005, 2000)
  applyCompaction(b, "s2", "manual", 2000)
  const stores = [a, b]
  const agg = aggregate(stores)

  it("merges models, agents, compactions and sessions", () => {
    assert.equal(agg.models.length, 2)
    const gpt = agg.models.find((m) => m.modelKey === "openai/gpt-5")!
    assert.equal(gpt.input, 100)
    assert.equal(gpt.folders.length, 1)
    assert.equal(agg.calls, 2)
    assert.equal(agg.totalCost, 0.015)
    assert.deepEqual(agg.compactions, { total: 2, auto: 1, manual: 1 })
    assert.equal(agg.sessions.length, 2)
  })
  it("aggregateForPath filters descendants", () => {
    const under = aggregateForPath(stores, "/projects")
    assert.equal(under.stores.length, 2)
    const alphaOnly = aggregateForPath(stores, "/projects/alpha")
    assert.equal(alphaOnly.stores.length, 1)
  })
})

describe("buildTree", () => {
  it("builds a trie with rolled-up totals", () => {
    const a = emptyStore(dir, "/projects")
    applyStep(a, "s1", "m1", "openai/gpt-5", "build", tokens(100), 0, 1000)
    const b = emptyStore("/projects/beta/deep", "/projects")
    applyStep(b, "s2", "m2", "anthropic/claude", "plan", tokens(50), 0, 2000)
    const root = buildTree([a, b])!
    assert.equal(root.calls, 2)
    assert.equal(root.tokens.input, 150)
    assert.equal(root.children.length, 2)
    const alpha = root.children.find((c) => c.name === "alpha")!
    assert.equal(alpha.calls, 1)
    const beta = root.children.find((c) => c.name === "beta")!
    assert.equal(beta.calls, 1)
    assert.equal(beta.children.length, 1)
  })
  it("counts a single store at the tree root", () => {
    const a = emptyStore(dir, "/projects")
    applyStep(a, "s1", "m1", "openai/gpt-5", "build", tokens(100, 20), 0.01, 1000)
    const root = buildTree([a])!
    assert.equal(root.path, dir)
    assert.equal(root.tokens.input, 100)
    assert.equal(root.tokens.output, 20)
    assert.equal(root.calls, 1)
    assert.equal(root.cost, 0.01)
  })
  it("does not drop a store whose directory is the common root", () => {
    const parent = emptyStore("/projects", "/projects")
    applyStep(parent, "p1", "m1", "openai/gpt-5", "build", tokens(70), 0, 1000)
    const child = emptyStore("/projects/beta", "/projects")
    applyStep(child, "c1", "m2", "anthropic/claude", "plan", tokens(30), 0, 2000)
    const root = buildTree([parent, child])!
    assert.equal(root.tokens.input, 100)
    assert.equal(root.calls, 2)
    const beta = root.children.find((c) => c.name === "beta")!
    assert.equal(beta.tokens.input, 30)
  })
})

describe("findModel", () => {
  const a = emptyStore(dir, "/projects")
  applyStep(a, "s1", "m1", "openai/gpt-5", "build", tokens(100), 0, 1000)
  applyStep(a, "s1", "m2", "anthropic/claude-4", "build", tokens(50), 0, 2000)

  it("matches exact, suffix and fuzzy queries", () => {
    assert.equal(findModel([a], "openai/gpt-5")?.modelKey, "openai/gpt-5")
    assert.equal(findModel([a], "gpt-5")?.modelKey, "openai/gpt-5")
    assert.equal(findModel([a], "gpt")?.modelKey, "openai/gpt-5")
    assert.equal(findModel([a], "claude-4")?.modelKey, "anthropic/claude-4")
  })
  it("returns undefined for unknown models", () => {
    assert.equal(findModel([a], "nope-nothing"), undefined)
  })
})

describe("parseUsageArgs", () => {
  it("parses every branch", () => {
    assert.deepEqual(parseUsageArgs("/usage", dir, "/projects"), { kind: "folder" })
    assert.deepEqual(parseUsageArgs("/usage help", dir, "/projects"), { kind: "help" })
    assert.deepEqual(parseUsageArgs("/usage models", dir, "/projects"), { kind: "models" })
    assert.deepEqual(parseUsageArgs("/usage tree", dir, "/projects"), { kind: "tree" })
    assert.deepEqual(parseUsageArgs("/usage reset", dir, "/projects"), { kind: "reset" })
    assert.deepEqual(parseUsageArgs("/usage export", dir, "/projects"), { kind: "export" })
    assert.deepEqual(parseUsageArgs("/usage /projects/beta", dir, "/projects"), { kind: "path", path: "/projects/beta" })
    assert.deepEqual(parseUsageArgs("/usage ./src", dir, "/projects"), { kind: "path", path: path.resolve(dir, "./src") })
    assert.deepEqual(parseUsageArgs("/usage gpt-5", dir, "/projects"), { kind: "model", query: "gpt-5" })
    assert.deepEqual(parseUsageArgs("/usage whatever unknown", dir, "/projects"), { kind: "model", query: "whatever unknown" })
  })
  it("treats existing filesystem entries as paths", () => {
    const target = path.join(tmp, "existing-dir")
    mkdirSync(target)
    assert.deepEqual(parseUsageArgs("/usage existing-dir", tmp, tmp), { kind: "path", path: target })
  })
})

describe("formatting", () => {
  it("formats token counts", () => {
    assert.equal(formatTokens(0), "0")
    assert.equal(formatTokens(999), "999")
    assert.equal(formatTokens(1500), "1.5k")
    assert.equal(formatTokens(1234000), "1.23M")
    assert.equal(formatTokens(1200000000), "1.20B")
  })
  it("formats money", () => {
    assert.equal(formatMoney(0), "$0.00")
    assert.equal(formatMoney(1.234), "$1.23")
    assert.equal(formatMoney(250), "$250")
  })
})

describe("cross-file persistence of listStores", () => {
  it("reads stores written by saveStore", () => {
    const dirRoot = path.join(tmp, "cross")
    const store = emptyStore(path.join(dirRoot, "x"), dirRoot)
    applyStep(store, "s1", "m1", "openai/gpt-5", "build", tokens(7), 0, 1000)
    saveStore(store, root)
    const stores = listStores(root)
    const found = stores.find((s) => s.directory === path.join(dirRoot, "x"))
    assert.ok(found)
    assert.equal(found.models["openai/gpt-5"].input, 7)
  })
})

rmSync(tmp, { recursive: true, force: true })