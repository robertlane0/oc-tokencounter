import { existsSync } from "node:fs"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  applyBackfillSession,
  loadStore,
  saveStore,
  storeFileFor,
  type DirectoryStore,
} from "./lib/usage-lib.ts"

const POLL_MS = 2000

function unwrapArray(res: any): any[] {
  if (!res) return []
  if (Array.isArray(res)) return res
  if (Array.isArray(res.data)) return res.data
  return []
}

async function pollSessions(client: any, store: DirectoryStore) {
  const res = await client.session.list({ query: { directory: store.directory } })
  const sessions = unwrapArray(res)
  let changed = false
  for (const session of sessions) {
    const id = session?.id
    if (typeof id !== "string") continue
    
    const stored = store.sessions[id]
    const currentUpdated = session.time?.updated || 0
    if (stored && stored.updated >= currentUpdated) {
      continue
    }

    try {
      const messages = unwrapArray(
        await client.session.messages({ path: { id }, query: { directory: store.directory } }),
      )
      applyBackfillSession(store, id, session.title, session.time?.created, currentUpdated, messages)
      changed = true
    } catch {}
  }
  return changed
}

const server = (input: PluginInput): Hooks => {
  const { directory, worktree, client } = input
  const store = loadStore(directory, worktree)

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  const runPoll = async () => {
    if (running) return
    running = true
    try {
      const changed = await pollSessions(client, store)
      if (changed || !existsSync(storeFileFor(directory))) {
        saveStore(store)
      }
    } catch {
    } finally {
      running = false
    }
  }

  // Initial poll
  runPoll()

  timer = setInterval(runPoll, POLL_MS)

  return {
    dispose: async () => {
      if (timer) clearInterval(timer)
      // Give an in-flight poll a chance to finish (bounded), then run one
      // final poll so tokens from turns that completed since the last tick
      // are recorded before the store is saved.
      const deadline = Date.now() + 5000
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await runPoll()
      saveStore(store)
    },
  }
}

export default {
  id: "usage-counter",
  server,
}
