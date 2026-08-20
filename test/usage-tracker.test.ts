import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { default as plugin } from "../.opencode/plugins/usage-tracker.ts"
import { loadStore, listStores } from "../.opencode/plugins/usage-lib.ts"

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
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
        },
        parts: [{ id: "p1", type: "text" }],
      },
    ],
  }
  return {
    session: {
      list: async ({ query }: any) => ({ data: sessions }),
      messages: async ({ sessionID }: any) => ({ data: messages[sessionID] ?? [] }),
    },
  }
}

function event(type: string, properties: Record<string, any>) {
  return { event: { id: "e", type, properties } }
}

describe("usage-tracker plugin", () => {
  it("exports the expected v1 plugin shape", () => {
    assert.equal(plugin.id, "usage-counter")
    assert.equal(typeof plugin.server, "function")
  })

  it("backfills existing sessions and tracks live events", async () => {
    const directory = path.join(root, "proj")
    const { server } = plugin
    const hooks = await server({
      client: fakeClient(),
      directory,
      worktree: root,
    } as any)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const store = loadStore(directory, root)
    assert.equal(store.models["openai/gpt-5"].calls, 1)
    assert.equal(store.models["openai/gpt-5"].input, 10)
    assert.equal(store.models["openai/gpt-5"].cost, 0.01)
    assert.equal(store.sessions["s-old"].title, "Old session")

    await hooks.event!(event("session.next.step.started", {
      sessionID: "s-new",
      assistantMessageID: "am1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-4" },
    }))
    await hooks.event!(event("session.next.step.ended", {
      sessionID: "s-new",
      assistantMessageID: "am1",
      finish: "end",
      cost: 0,
      tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }))
    await hooks.event!(event("session.next.compaction.started", {
      sessionID: "s-new",
      messageID: "c1",
      reason: "manual",
    }))
    await hooks.event!(event("session.compacted", {
      sessionID: "s-new",
    }))
    await hooks.dispose!()

    const updated = loadStore(directory, root)
    assert.equal(updated.models["anthropic/claude-4"].calls, 1)
    assert.equal(updated.models["anthropic/claude-4"].input, 5)
    assert.equal(updated.agents["plan"].calls, 1)
    assert.equal(updated.compactions.total, 1)
    assert.equal(updated.compactions.manual, 1)
    assert.equal(updated.sessions["s-new"].compactions, 1)
  })

  it("tracks step.ended without a matching started event", async () => {
    const directory = path.join(root, "proj2")
    const { server } = plugin
    const hooks = await server({ client: fakeClient(), directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await hooks.event!(event("session.next.step.ended", {
      sessionID: "s2",
      assistantMessageID: "am2",
      tokens: { input: 3, output: 0 },
    }))
    await hooks.dispose!()
    const store = loadStore(directory, root)
    assert.equal(store.models["unknown/unknown"].input, 3)
  })

  it("does not double count after a restart (backfill only once)", async () => {
    const directory = path.join(root, "proj3")
    const { server } = plugin
    const hooks = await server({ client: fakeClient(), directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await hooks.dispose!()
    const hooks2 = await server({ client: fakeClient(), directory, worktree: root } as any)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await hooks2.dispose!()
    const store = loadStore(directory, root)
    assert.equal(store.models["openai/gpt-5"].calls, 1)
  })
})

rmSync(root, { recursive: true, force: true })