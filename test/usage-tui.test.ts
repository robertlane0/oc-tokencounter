import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { default as plugin } from "../.opencode/plugins/lib/usage-tui.ts"
import { applyStep, applyCompaction, emptyStore, saveStore } from "../.opencode/plugins/lib/usage-lib.ts"

const root = mkdtempSync(path.join(os.tmpdir(), "usage-tui-test-"))
process.env.XDG_DATA_HOME = path.join(root, "xdg")
const projectsRoot = path.join(root, "xdg", "opencode", "plugins", "usage-counter", "projects")

function makeApi() {
  const dialogs: string[] = []
  const toasts: string[] = []
  let interceptHandler: ((input: { event: any }) => void) | undefined
  let interceptPriority: number | undefined
  let registeredLayers: any[] = []
  const api: any = {
    keymap: {
      registerLayer: (layer: any) => {
        registeredLayers.push(layer)
      },
      intercept: (name: string, handler: any, options: any) => {
        assert.equal(name, "key")
        interceptHandler = handler
        interceptPriority = options?.priority
        return () => {}
      },
      dispatchCommand: () => {},
    },
    ui: {
      DialogAlert: (props: any) => {
        dialogs.push(`alert:${props.title}\n${props.message}`)
        return props
      },
      DialogConfirm: (props: any) => {
        dialogs.push(`confirm:${props.title}\n${props.message}`)
        return props
      },
      dialog: {
        replace: (render: () => any) => {
          render()
        },
        setSize: (size: string) => {
          dialogs[dialogs.length - 1] = `${size}|${dialogs[dialogs.length - 1]}`
        },
        clear: () => {},
      },
      toast: (input: any) => {
        toasts.push(input.message)
      },
    },
    state: {
      path: {
        directory: "/projects/alpha",
        worktree: "/projects",
      },
    },
    route: {
      current: { name: "session", params: { sessionID: "s1" } },
    },
    renderer: {
      currentFocusedEditor: null,
    },
  }
  return {
    api,
    dialogs,
    toasts,
    get interceptHandler() {
      return interceptHandler!
    },
    get interceptPriority() {
      return interceptPriority!
    },
    get registeredLayers() {
      return registeredLayers
    },
  }
}

function seedStore() {
  const store = emptyStore("/projects/alpha", "/projects")
  applyStep(store, "s1", "m1", "openai/gpt-5", "build", { input: 1000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, 0.01, Date.now())
  applyStep(store, "s1", "m2", "anthropic/claude-4", "plan", { input: 400, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, 0.02, Date.now())
  applyCompaction(store, "s1", "auto", Date.now())
  saveStore(store, projectsRoot)
}

describe("usage-tui plugin", () => {
  it("exports the expected v1 plugin shape", () => {
    assert.equal(plugin.id, "usage-counter-tui")
    assert.equal(typeof plugin.tui, "function")
  })

  it("registers the usage slash command and intercept with priority 1", async () => {
    const h = makeApi()
    const { api } = h
    await plugin.tui(api)
    assert.equal(h.interceptPriority, 1)
    const commands = h.registeredLayers.flatMap((layer) => layer.commands)
    const usage = commands.find((c: any) => c.slashName === "usage")
    assert.ok(usage)
    assert.equal(usage.namespace, "palette")
  })

  it("intercepts Enter on /usage without submitting", async () => {
    seedStore()
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "/usage",
      logicalCursor: { row: 0, col: 6 },
      deleteRange: (sr: number, sc: number, er: number, ec: number) => {
        api.renderer.currentFocusedEditor.plainText = ""
      },
    }
    let prevented = false
    let stopped = false
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {
          prevented = true
        },
        stopPropagation: () => {
          stopped = true
        },
      },
    })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    assert.equal(api.renderer.currentFocusedEditor.plainText, "")
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes("Usage"))
    assert.ok(dialogs[0].includes("openai/gpt-5"))
  })

  it("shows the canned error for unknown queries", async () => {
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "/usage unknown-command-example-123",
      logicalCursor: { row: 0, col: 30 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes('Unknown usage query: "unknown-command-example-123"'))
    assert.ok(dialogs[0].includes("/usage models"))
  })

  it("renders the models ranking view", async () => {
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "/usage models",
      logicalCursor: { row: 0, col: 13 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes("Models"))
    assert.ok(dialogs[0].includes("openai/gpt-5"))
    assert.ok(dialogs[0].includes("anthropic/claude-4"))
  })

it("renders the tree view", async () => {
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "/usage tree",
      logicalCursor: { row: 0, col: 11 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes("Usage tree"))
    assert.ok(dialogs[0].includes("alpha"))
  })

  it("renders the path view", async () => {
    seedStore()
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "/usage /projects",
      logicalCursor: { row: 0, col: 14 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes("Usage — /projects"))
    assert.ok(dialogs[0].includes("/projects/alpha"))
    assert.ok(dialogs[0].includes("openai/gpt-5"))
  })

  it("shows an empty message when the folder has no data", async () => {
    const h = makeApi(); const { api, dialogs } = h
    api.state.path.directory = "/projects/never-tracked"
    api.renderer.currentFocusedEditor = {
      plainText: "/usage",
      logicalCursor: { row: 0, col: 6 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.ok(dialogs.length > 0)
    assert.ok(dialogs[0].includes("/projects/never-tracked"))
    assert.ok(dialogs[0].includes("Nothing recorded yet"))
  })

  it("ignores Enter on non-usage input", async () => {
    const h = makeApi(); const { api, dialogs } = h
    api.renderer.currentFocusedEditor = {
      plainText: "hello world",
      logicalCursor: { row: 0, col: 11 },
      deleteRange: () => {
        throw new Error("should not clear non-usage input")
      },
    }
    let prevented = false
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {
          prevented = true
        },
        stopPropagation: () => {},
      },
    })
    assert.equal(prevented, false)
    assert.equal(dialogs.length, 0)
  })

  it("export writes a markdown report and toasts", async () => {
    seedStore()
    const h = makeApi()
    const { api, toasts } = h
    api.state.path.worktree = root
    api.renderer.currentFocusedEditor = {
      plainText: "/usage export",
      logicalCursor: { row: 0, col: 13 },
      deleteRange: () => {},
    }
    await plugin.tui(api)
    h.interceptHandler({
      event: {
        name: "return",
        preventDefault: () => {},
        stopPropagation: () => {},
      },
    })
    assert.equal(toasts.length, 1)
    const report = readFileSync(path.join(root, "usage-report.md"), "utf8")
    assert.ok(report.includes("# OpenCode usage report"))
    assert.ok(report.includes("openai/gpt-5"))
  })
})

rmSync(root, { recursive: true, force: true })