import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { default as plugin } from "../.opencode/plugins/usage-tracker.ts"
import { loadStore, listStores } from "../.opencode/plugins/lib/usage-lib.ts"

const root = mkdtempSync(path.join(os.tmpdir(), "usage-tracker-test-"))
process.env.XDG_DATA_HOME = path.join(root, "xdg")

function fakeClient() {
  const sessions = [
    {
      id: "s-old",
      title: "Old session",
      time: { created: 100, updated: 200 },
    },
  ]
  const messages: Record<string, Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>> = {
    "s-old": [
      { info: { id: "u1", role: "user", agent: "build" }, parts: [] },
      {
        info: {
          id: "a1",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5",
          cost: 0.01,
          time: { completed: 150 },
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
        },
        parts: [{ id: "p1", type: "text" }],
      },
    ],
  }
  return {
    _pushSession(s: any) {
      sessions.push(s)
    },
    _pushMessage(sessionID: string, m: any) {
      if (!messages[sessionID]) messages[sessionID] = []
      messages[sessionID].push(m)
    },
    session: {
      list: async ({ query }: any) => ({ data: [...sessions] }),
      // Mirrors the real @opencode-ai/sdk client: the session id is a path
      // param (`path: { id }`), not a flat `sessionID` field. A mock that
      // accepted `{ sessionID }` here previously let this test pass while
      // the real SDK call silently failed against a live server.
      messages: async ({ path }: any) => ({ data: messages[path?.id] ?? [] }),
    },
  }
}

describe("usage-tracker plugin", () => {
  it("exports the expected v1 plugin shape", () => {
    assert.equal(plugin.id, "usage-counter")
    assert.equal(typeof plugin.server, "function")
  })

  it("backfills existing sessions and tracks live events via polling", async () => {
    const directory = path.join(root, "proj")
    const { server } = plugin
    const client = fakeClient()
    const hooks = await server({
      client,
      directory,
      worktree: root,
    } as any)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const store = loadStore(directory, root)
    assert.equal(store.models["openai/gpt-5"].calls, 1)
    assert.equal(store.models["openai/gpt-5"].input, 10)
    assert.equal(store.models["openai/gpt-5"].cost, 0.01)
    assert.equal(store.sessions["s-old"].title, "Old session")

    client._pushSession({
      id: "s-new",
      title: "New session",
      time: { created: 300, updated: 400 },
    })
    client._pushMessage("s-new", {
      info: { id: "u2", role: "user", agent: "plan" }, parts: []
    })
    client._pushMessage("s-new", {
      info: {
        id: "am1",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-4",
        cost: 0.02,
        time: { completed: 350 },
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      },
      parts: [
        { id: "c1", type: "compaction", auto: false, time: { created: 350 } }
      ]
    })

    await new Promise((resolve) => setTimeout(resolve, 2050))
    await hooks.dispose!()

    const updated = loadStore(directory, root)
    assert.equal(updated.models["anthropic/claude-4"].calls, 1)
    assert.equal(updated.models["anthropic/claude-4"].input, 5)
    assert.equal(updated.agents["plan"].calls, 1)
    assert.equal(updated.compactions.total, 1)
    assert.equal(updated.compactions.manual, 1)
    assert.equal(updated.sessions["s-new"].compactions, 1)
  })

  it("does not double count after a restart (backfill only once)", async () => {
    const directory = path.join(root, "proj3")
    const { server } = plugin
    const hooks = await server({ client: fakeClient(), directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await hooks.dispose!()
    const hooks2 = await server({ client: fakeClient(), directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await hooks2.dispose!()
    const store = loadStore(directory, root)
    assert.equal(store.models["openai/gpt-5"].calls, 1)
  })

  it("runs a final poll on dispose so last-turn tokens are not lost", async () => {
    const directory = path.join(root, "proj-final")
    const client = fakeClient()
    const { server } = plugin
    const hooks = await server({ client, directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // A turn completes right before shutdown — there is no time for another
    // 2s poll tick, so dispose must catch it.
    client._pushSession({
      id: "s-last",
      title: "Last session",
      time: { created: 600, updated: 700 },
    })
    client._pushMessage("s-last", {
      info: { id: "u3", role: "user", agent: "build" },
      parts: [],
    })
    client._pushMessage("s-last", {
      info: {
        id: "a3",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-4",
        cost: 0.04,
        time: { completed: 690 },
        tokens: { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })

    await hooks.dispose!()

    const store = loadStore(directory, root)
    assert.equal(store.models["anthropic/claude-4"].calls, 1)
    assert.equal(store.models["anthropic/claude-4"].input, 40)
    assert.equal(store.sessions["s-last"].title, "Last session")
  })
})

rmSync(root, { recursive: true, force: true })