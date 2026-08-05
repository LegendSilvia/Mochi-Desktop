import type { ModelOption } from '../shared/models'

/**
 * OpenRouter's live model list.
 *
 * The catalogue in `shared/models.ts` is hand-written, which is fine for the
 * four providers that ship a handful of models each and wrong for OpenRouter,
 * which fronts hundreds and changes them weekly. Worse than incomplete, a
 * hand-written list can be confidently incorrect: `qwen/qwen3-embedding-0.6b`
 * was copied from OpenRouter's own reference and answers 404 "No endpoints
 * found", so recall silently embedded nothing until it was caught by driving
 * the app. Asking the API is the only version that cannot drift.
 *
 * Fetched in main rather than the renderer: no CORS, no key in the page, and
 * one cache shared by every picker in every window.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/models'

/** Long enough that opening the picker repeatedly costs one request, short
 *  enough that a model released this morning shows up today. */
const TTL_MS = 10 * 60 * 1000

/** OpenRouter's catalogue is large; this is the slice worth showing at once.
 *  A search narrows it server-side rather than paging through everything. */
const LIMIT = 100

interface Cached {
  at: number
  rows: ModelOption[]
}

const cache = new Map<string, Cached>()

interface ApiModel {
  id?: string
  name?: string
  description?: string
  context_length?: number
  architecture?: { output_modalities?: string[] }
  pricing?: { prompt?: string; completion?: string }
}

/** "0.00000014" per token → "$0.14". Priced per token by the API and per
 *  million everywhere humans actually discuss it. */
function dollarsPerMillion(n: number): string {
  const d = n * 1_000_000
  // Sub-dollar models are the common case and need the cents; the expensive
  // ones do not need three decimals of noise.
  return `$${d < 1 ? d.toFixed(2) : d.toFixed(d < 10 ? 1 : 0)}`
}

/**
 * What a model costs, both directions.
 *
 * Input and output are priced separately and often differ by 3–5x, so showing
 * only one is the kind of half-truth that makes a model look cheap right up
 * until the bill. Embedding models have no completion price, so they get the
 * single figure that is actually true for them.
 */
function priceLabel(pricing: ApiModel['pricing']): string | null {
  const inTok = Number(pricing?.prompt)
  const outTok = Number(pricing?.completion)
  const hasIn = Number.isFinite(inTok)
  const hasOut = Number.isFinite(outTok)
  if (!hasIn && !hasOut) return null
  if ((hasIn ? inTok : 0) === 0 && (hasOut ? outTok : 0) === 0) return 'free'
  if (!hasOut || outTok === 0) return `${dollarsPerMillion(inTok)}/M`
  return `${dollarsPerMillion(inTok)} in · ${dollarsPerMillion(outTok)} out /M`
}

function contextLabel(tokens: number | undefined): string | null {
  if (!tokens) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`
  return `${tokens} ctx`
}

function toOption(m: ApiModel): ModelOption | null {
  if (!m.id) return null
  const bits = [priceLabel(m.pricing), contextLabel(m.context_length)].filter(Boolean)
  return {
    // Prefixed so the value is a router id the rest of the app can use as-is.
    id: `openrouter/${m.id}`,
    // OpenRouter names read "Provider: Model"; the provider is already the
    // group heading, so the prefix would be said twice.
    label: (m.name ?? m.id).replace(/^[^:]+:\s*/, ''),
    hint: bits.length ? bits.join(' · ') : (m.description ?? '').slice(0, 60)
  }
}

/**
 * Models on offer, most popular first.
 *
 * `modality` maps to `output_modalities`, which is what stops a chat model
 * being offered for the embeddings role — the mistake the hand-written list
 * made possible and this makes impossible.
 */
export async function listOpenRouterModels(opts: {
  modality?: 'text' | 'embeddings'
  q?: string
}): Promise<ModelOption[]> {
  const modality = opts.modality ?? 'text'
  const q = (opts.q ?? '').trim().toLowerCase()
  const key = `${modality}|${q}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows

  const url = new URL(ENDPOINT)
  url.searchParams.set('output_modalities', modality)
  url.searchParams.set('sort', 'most-popular')
  url.searchParams.set('limit', String(LIMIT))
  if (q) url.searchParams.set('q', q)

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return hit?.rows ?? []
    const body = (await res.json()) as { data?: ApiModel[] }
    const rows = (body.data ?? [])
      .map(toOption)
      .filter((r): r is ModelOption => r !== null)
    cache.set(key, { at: Date.now(), rows })
    return rows
  } catch {
    // Offline, rate-limited, or slow. A stale list beats an empty picker, and
    // an empty one beats an error dialog — the field still takes free text.
    return hit?.rows ?? []
  }
}
