import { createClient, type Client } from '@libsql/client'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { databaseUrl } from './paths'
import { load } from './store'
import type { EmbedderInfo, RagDoc, RagHit } from '../shared/types'

/**
 * Retrieval over your own documents.
 *
 * Hybrid on purpose. Keyword search works the moment a file is added — no
 * model, no key, no download — so RAG is never dead on arrival. Vector search
 * is layered on top when an embedder is reachable, because keywords alone miss
 * anything phrased differently from the question.
 *
 * The embedder is swappable rather than fixed: Ollama by default (local, no
 * key, nothing leaves the machine), a hosted embedder automatically if a key
 * happens to exist. Anthropic has no embeddings API, so the Claude subscription
 * cannot supply this one thing — keyword-only is the honest fallback rather
 * than a broken feature.
 */

const CHUNK = 1100
const OVERLAP = 150
const OLLAMA = 'http://127.0.0.1:11434'

let db: Client | null = null

function conn(): Client {
  if (!db) db = createClient({ url: databaseUrl() })
  return db
}

export async function initRag(): Promise<void> {
  const c = conn()
  await c.execute(`CREATE TABLE IF NOT EXISTS rag_docs (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    bytes INTEGER NOT NULL, added_at INTEGER NOT NULL)`)
  await c.execute(`CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, ord INTEGER NOT NULL,
    text TEXT NOT NULL, embedding TEXT)`)
  // FTS5 gives real BM25 ranking for free; the external-content pattern keeps
  // the text in one place rather than duplicating every chunk.
  await c.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts
    USING fts5(text, content='rag_chunks', content_rowid='rowid')`)
}

/** Text-ish files only — a PDF read as UTF-8 is line noise, and indexing noise
 *  is worse than not indexing it, because it pollutes every later search. */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.c', '.h', '.cpp', '.cs', '.sh', '.sql', '.html', '.css', '.env.example'
])

export function isIndexable(path: string): boolean {
  return TEXT_EXT.has(extname(path).toLowerCase())
}

/** Split on blank lines first so chunks fall on paragraph seams where possible,
 *  then hard-wrap anything still oversized. Overlap keeps a sentence that
 *  straddles a boundary findable from either side. */
function chunkText(text: string): string[] {
  const paras = text.split(/\n\s*\n/)
  const out: string[] = []
  let buf = ''
  for (const p of paras) {
    if ((buf + p).length > CHUNK && buf) {
      out.push(buf.trim())
      buf = buf.slice(Math.max(0, buf.length - OVERLAP))
    }
    buf += (buf ? '\n\n' : '') + p
    while (buf.length > CHUNK * 1.6) {
      out.push(buf.slice(0, CHUNK).trim())
      buf = buf.slice(CHUNK - OVERLAP)
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter((c) => c.length > 24)
}

// --------------------------------------------------------------- embedding

/** Which embedder we can actually use right now. Checked rather than assumed —
 *  Ollama being installed and Ollama being *running* are different things. */
/**
 * Hosted embedders that speak OpenAI's `/embeddings` shape.
 *
 * OpenRouter is here rather than special-cased because it is the same request
 * with a different base URL and key. Its model ids keep the upstream provider
 * in them (`openai/text-embedding-3-small`), so `model` is everything after the
 * first slash rather than a single segment — which is why the split above keeps
 * the remainder intact instead of taking `rest[0]`.
 */
const HOSTED: Record<string, { url: string; envVar: string; detail: string }> = {
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    envVar: 'OPENAI_API_KEY',
    detail: 'hosted, billed to your OpenAI key'
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/embeddings',
    envVar: 'OPENROUTER_API_KEY',
    detail: 'hosted, billed to your OpenRouter key'
  }
}

export async function embedderInfo(): Promise<EmbedderInfo> {
  const { settings } = load()
  const configured = settings.modelRoles?.embeddings ?? ''
  const [provider, ...rest] = configured.split('/')
  const model = rest.join('/')

  const hosted = HOSTED[provider]
  if (hosted && model && process.env[hosted.envVar]) {
    return {
      kind: provider as 'openai' | 'openrouter',
      model,
      ready: true,
      detail: hosted.detail
    }
  }

  const ollamaModel = provider === 'ollama' && model ? model : 'nomic-embed-text'
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1200) })
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string }> }
      const has = (body.models ?? []).some((m) => (m.name ?? '').startsWith(ollamaModel))
      return {
        kind: 'ollama',
        model: ollamaModel,
        ready: has,
        detail: has
          ? 'local, nothing leaves this machine'
          : `Ollama is running but ${ollamaModel} is not pulled — run: ollama pull ${ollamaModel}`
      }
    }
  } catch {
    // Ollama not running; fall through.
  }
  return {
    kind: 'none',
    model: '',
    ready: false,
    detail: 'no embedder reachable — keyword search still works'
  }
}

async function embed(texts: string[]): Promise<number[][] | null> {
  const info = await embedderInfo()
  if (!info.ready) return null

  const hosted = HOSTED[info.kind]
  if (hosted) {
    const res = await fetch(hosted.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env[hosted.envVar]}`
      },
      body: JSON.stringify({ model: info.model || 'text-embedding-3-small', input: texts })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    return (body.data ?? []).map((d) => d.embedding)
  }

  // Ollama embeds one input per call.
  const out: number[][] = []
  for (const text of texts) {
    const res = await fetch(`${OLLAMA}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: info.model, prompt: text })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { embedding?: number[] }
    if (!body.embedding) return null
    out.push(body.embedding)
  }
  return out
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// ------------------------------------------------------------------ index

export async function addDocuments(paths: string[]): Promise<{ added: number; skipped: string[] }> {
  await initRag()
  const c = conn()
  const skipped: string[] = []
  let added = 0

  for (const path of paths) {
    if (!isIndexable(path)) {
      skipped.push(`${basename(path)} — not a text file`)
      continue
    }
    let text = ''
    let bytes = 0
    try {
      bytes = statSync(path).size
      text = readFileSync(path, 'utf-8')
    } catch {
      skipped.push(`${basename(path)} — could not read`)
      continue
    }

    const chunks = chunkText(text)
    if (chunks.length === 0) {
      skipped.push(`${basename(path)} — nothing to index`)
      continue
    }

    const docId = `doc-${Date.now().toString(36)}-${added}`
    // Re-adding a path replaces it rather than duplicating, so re-indexing an
    // edited file is just adding it again.
    await c.execute({ sql: 'DELETE FROM rag_docs WHERE path = ?', args: [path] })
    await c.execute({
      sql: 'INSERT INTO rag_docs (id, path, title, bytes, added_at) VALUES (?, ?, ?, ?, ?)',
      args: [docId, path, basename(path), bytes, Date.now()]
    })

    const vectors = await embed(chunks)
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}-${i}`
      await c.execute({
        sql: 'INSERT INTO rag_chunks (id, doc_id, ord, text, embedding) VALUES (?, ?, ?, ?, ?)',
        args: [chunkId, docId, i, chunks[i], vectors ? JSON.stringify(vectors[i]) : null]
      })
    }
    await c.execute(`INSERT INTO rag_fts(rag_fts) VALUES('rebuild')`)
    added++
  }

  return { added, skipped }
}

export async function listDocuments(): Promise<RagDoc[]> {
  await initRag()
  const c = conn()
  const rows = await c.execute(`
    SELECT d.id, d.path, d.title, d.bytes,
           COUNT(k.id) AS chunks,
           SUM(CASE WHEN k.embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
    FROM rag_docs d LEFT JOIN rag_chunks k ON k.doc_id = d.id
    GROUP BY d.id ORDER BY d.added_at DESC`)
  return rows.rows.map((r) => ({
    id: String(r.id),
    path: String(r.path),
    title: String(r.title),
    bytes: Number(r.bytes ?? 0),
    chunks: Number(r.chunks ?? 0),
    embedded: Number(r.embedded ?? 0)
  }))
}

export async function removeDocument(id: string): Promise<void> {
  const c = conn()
  await c.execute({ sql: 'DELETE FROM rag_chunks WHERE doc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM rag_docs WHERE id = ?', args: [id] })
  await c.execute(`INSERT INTO rag_fts(rag_fts) VALUES('rebuild')`)
}

// ----------------------------------------------------------------- search

/**
 * Hybrid retrieval.
 *
 * Keyword and vector hits are merged by reciprocal rank rather than by raw
 * score: BM25 and cosine aren't on the same scale, and normalising them against
 * each other invents a comparison neither one supports.
 */
export async function search(queryText: string, limit = 6): Promise<RagHit[]> {
  await initRag()
  const c = conn()
  const ranked = new Map<string, { hit: RagHit; score: number }>()

  const bump = (key: string, hit: RagHit, rank: number, how: RagHit['how']): void => {
    const existing = ranked.get(key)
    const rrf = 1 / (60 + rank)
    if (existing) {
      existing.score += rrf
      if (existing.hit.how !== how) existing.hit.how = 'both'
    } else {
      ranked.set(key, { hit: { ...hit, how }, score: rrf })
    }
  }

  // FTS5 treats punctuation as syntax, so the query is reduced to bare words.
  const terms = queryText.replace(/["'*^:()-]/g, ' ').split(/\s+/).filter(Boolean)
  if (terms.length > 0) {
    try {
      const rows = await c.execute({
        sql: `SELECT k.text, d.title, d.path
              FROM rag_fts f
              JOIN rag_chunks k ON k.rowid = f.rowid
              JOIN rag_docs d ON d.id = k.doc_id
              WHERE rag_fts MATCH ? ORDER BY bm25(rag_fts) LIMIT 20`,
        args: [terms.map((t) => `"${t}"`).join(' OR ')]
      })
      rows.rows.forEach((r, i) =>
        bump(
          String(r.text),
          { text: String(r.text), title: String(r.title), path: String(r.path), score: 0, how: 'keyword' },
          i,
          'keyword'
        )
      )
    } catch {
      // A malformed FTS query should degrade to vector-only, not throw.
    }
  }

  const qv = (await embed([queryText]))?.[0]
  if (qv) {
    const rows = await c.execute(`
      SELECT k.text, k.embedding, d.title, d.path
      FROM rag_chunks k JOIN rag_docs d ON d.id = k.doc_id
      WHERE k.embedding IS NOT NULL`)
    const scored = rows.rows
      .map((r) => ({
        text: String(r.text),
        title: String(r.title),
        path: String(r.path),
        sim: cosine(qv, JSON.parse(String(r.embedding)) as number[])
      }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 20)
    scored.forEach((s, i) =>
      bump(s.text, { text: s.text, title: s.title, path: s.path, score: s.sim, how: 'vector' }, i, 'vector')
    )
  }

  return [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Number(score.toFixed(4)) }))
}
