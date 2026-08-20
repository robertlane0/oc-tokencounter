import { existsSync } from "node:fs"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  applyBackfillSession,
  applyCompaction,
  applyStep,
  loadStore,
  modelKey,
  saveStore,
  storeFileFor,
  type DirectoryStore,
  type Tokens,
} from "./usage-lib.ts"

type RuntimeEvent = {
  id: string
  type: string
  properties: Record<string, any>
}

type PendingStep = {
  sessionID: string
  assistantMessageID: string
  agent?: string
  model?: { providerID?: string; id?: string }
}

const FLUSH_MS = 1000

function unwrapArray(res: any): any[] {
  if (!res) return []
  if (Array.isArray(res)) return res
  if (Array.isArray(res.data)) return res.data
  return []
}

function tokensOf(value: any): Tokens {
  return {
    input: num(value?.input),
    output: num(value?.output),
    reasoning: num(value?.reasoning),
    cacheRead: num(value?.cache?.read),
    cacheWrite: num(value?.cache?.write),
  }
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

async function backfill(client: any, store: DirectoryStore) {
  const res = await client.session.list({ query: { directory: store.directory } })
  const sessions = unwrapArray(res)
  for (const session of sessions) {
    const id = session?.id
    if (typeof id !== "string") continue
    const messages = unwrapArray(await client.session.messages({ sessionID: id }))
    applyBackfillSession(store, id, session.title, session.time?.created, session.time?.updated, messages)
  }
}

const server = (input: PluginInput): Hooks => {
  const { directory, worktree, client } = input
  const store = loadStore(directory, worktree)

  const existed = existsSync(storeFileFor(directory))
  if (!existed) {
    backfill(client, store)
      .then(() => saveStore(store))
      .catch(() => {})
  }

  const pending = new Map<string, PendingStep>()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty) return
    dirty = false
    try {
      saveStore(store)
    } catch {
      dirty = true
    }
  }

  const scheduleFlush = () => {
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, FLUSH_MS)
  }

  const onEvent = async (input: { event: unknown }) => {
    const event = input?.event as RuntimeEvent | undefined
    const type = event?.type
    const props = event?.properties ?? {}
    const now = Date.now()
    try {
      if (type === "session.next.step.started") {
        pending.set(props.assistantMessageID, {
          sessionID: props.sessionID,
          assistantMessageID: props.assistantMessageID,
          agent: props.agent,
          model: props.model,
        })
        return
      }
      if (type === "session.next.step.ended") {
        const started = pending.get(props.assistantMessageID)
        pending.delete(props.assistantMessageID)
        applyStep(
          store,
          props.sessionID,
          props.assistantMessageID,
          started?.model ? modelKey(started.model.providerID, started.model.id) : undefined,
          started?.agent,
          tokensOf(props.tokens),
          props.cost,
          now,
        )
        scheduleFlush()
        return
      }
      if (type === "session.next.step.failed") {
        pending.delete(props.assistantMessageID)
        return
      }
      if (type === "session.next.compaction.started") {
        applyCompaction(store, props.sessionID, props.reason, now)
        scheduleFlush()
      }
    } catch {
      return
    }
  }

  return {
    event: onEvent,
    dispose: async () => {
      flush()
    },
  }
}

export default {
  id: "usage-counter",
  server,
}
