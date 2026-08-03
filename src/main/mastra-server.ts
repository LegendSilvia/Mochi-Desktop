import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { HonoBindings, HonoVariables, MastraServer } from '@mastra/hono'
import { createReadStream } from 'node:fs'
import { createMastra } from '../mastra/index'
import { databaseUrl } from './paths'
import { load } from './store'
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

  const { agents, settings } = load()
  const mastra = createMastra({
    databaseUrl: databaseUrl(),
    loadouts: agents,
    embeddingModel: settings.modelRoles.embeddings
  })

  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>()
  const server = new MastraServer({ app, mastra })
  await server.init()

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
      const text = await readAll(new URL(url).pathname)
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
