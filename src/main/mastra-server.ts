import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { HonoBindings, HonoVariables, MastraServer } from '@mastra/hono'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMastra } from '../mastra/index'
import { provideDocs } from '../mastra/tools/mochi-tools'
import { registerAgentSdkRoute } from './agent-sdk-route'
import { databaseUrl } from './paths'
import { load } from './store'
import { addNote, embedderInfo, search } from './rag'
import { workspaceFor } from './workspace'
import type { ServerInfo } from '../shared/types'

/**
 * The embedded Mastra server.
 *
 * The handoff assumed the renderer would talk to Mastra over IPC. It doesn't:
 * Mastra's documented path is an HTTP server, and going through it is what gives
 * us streaming, tool-call parts and approval states without hand-rolling stream
 * framing over IPC. The server runs *inside* the Electron main process via the
 * Hono adapter, so there is still only one process and no `mastra dev` to ship.
 *
 * Port 0 asks the OS for a free port — never hard-code 4111, a desktop app cannot
 * assume it is available.
 */

let info: ServerInfo | null = null
let handle: { close: () => void } | null = null

export async function startMastraServer(appVersion: string): Promise<ServerInfo> {
  if (info) return info

  // Hand the Mastra tools the document library. Injected rather than imported
  // so src/mastra stays free of main-process dependencies.
  provideDocs({ search, addNote })

  const { agents } = load()

  /*
   * Semantic recall runs on the same embedder RAG uses, resolved the same way —
   * one answer to "can this machine embed right now", not two that can disagree.
   *
   * Reachability is checked rather than assumed because the local option is a
   * server: Ollama being installed and Ollama being *running* are different
   * things, and an embedder that isn't there throws mid-turn. That would fail
   * the user's message rather than the feature, which is the wrong end to fail
   * at — better to come up with recall off and plain history working.
   *
   * The empty string is deliberate: it builds no embedder, so recall stays off
   * for every loadout no matter what their toggles say.
   */
  const embedder = await embedderInfo()
  const mastra = createMastra({
    databaseUrl: databaseUrl(),
    loadouts: agents,
    embeddingModel: embedder.ready ? `${embedder.kind}/${embedder.model}` : '',
    // Hands the agent the same folder-keyed Workspace the widgets use, so
    // "what the agent can reach" and "what you can browse" are one thing.
    workspaceFor
  })

  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>()

  // CORS has to be registered here, on the app, before any route.
  //
  // `createMastra` sets `server.cors`, but that config only applies to Mastra's
  // own standalone server — embedding via `new MastraServer({ app, mastra })`
  // never reads it. The result was that every renderer fetch failed the preflight
  // with a 404 and surfaced as "Failed to fetch", on the Mastra route as much as
  // the Agent SDK one. It went unnoticed because both routes answer a non-browser
  // client (curl, a script) perfectly well; only a browser enforces CORS.
  const allowedOrigins = new Set(
    ['http://localhost:5173', 'file://', 'null', process.env['ELECTRON_RENDERER_URL']].filter(
      (o): o is string => Boolean(o)
    )
  )
  app.use(
    '*',
    cors({
      // Packaged builds load the renderer over file://, which Chromium sends as
      // either `file://` or the opaque origin `null`. Both are accepted; anything
      // else is refused, and the server is bound to loopback regardless.
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization']
    })
  )

  const server = new MastraServer({ app, mastra })
  await server.init()

  // The subscription backend rides the same server so the renderer only ever
  // needs one base URL. Mastra owns /chat/:agentId, this owns /agent-sdk/chat/:agentId.
  registerAgentSdkRoute(app, appVersion)

  const port = await new Promise<number>((resolve, reject) => {
    try {
      handle = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (addr) => {
        resolve(addr.port)
      })
    } catch (err) {
      reject(err)
    }
  })

  info = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    mastraVersion: await resolveMastraVersion(),
    appVersion
  }
  return info
}

export function getServerInfo(): ServerInfo | null {
  return info
}

export function stopMastraServer(): void {
  handle?.close()
  handle = null
  info = null
}

/**
 * Resolve the real installed @mastra/core version. The title bar renders this —
 * the handoff's hard-coded "mastra 0.20" was stale placeholder copy (M0-11).
 */
async function resolveMastraVersion(): Promise<string> {
  try {
    const url = await import.meta.resolve?.('@mastra/core/package.json')
    if (url) {
      // fileURLToPath, not URL.pathname: on Windows the latter yields
      // `/E:/…/package.json`, which fs resolves to `E:\E:\…` and throws ENOENT,
      // so the version silently fell back to "unknown" in the title bar.
      const text = await readAll(fileURLToPath(url))
      return (JSON.parse(text) as { version: string }).version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

function readAll(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const s = createReadStream(path, 'utf-8')
    s.on('data', (c) => (out += c))
    s.on('end', () => resolve(out))
    s.on('error', reject)
  })
}
