/**
 * Known models, for the picker.
 *
 * Mastra's router takes any `provider/model` string, so this is a convenience
 * list rather than a whitelist — the picker always allows free text for
 * anything not listed (a new release, a local Ollama tag, an OpenRouter slug).
 * Kept in `shared` so main and renderer agree on the same catalogue.
 */

export interface ModelOption {
  /** Full router id, e.g. `anthropic/claude-opus-5`. */
  id: string
  /** Short label shown in the list. */
  label: string
  /** One-line "when would I pick this". */
  hint: string
}

export interface ProviderGroup {
  provider: string
  label: string
  /** How this provider is paid for, shown as a chip. */
  billing: 'subscription or api key' | 'api key' | 'local'
  models: ModelOption[]
}

export const MODEL_CATALOG: ProviderGroup[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    billing: 'subscription or api key',
    models: [
      { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', hint: 'deepest reasoning and long agentic runs' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'near-Opus quality, faster and cheaper' },
      { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'previous Opus — still very strong' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'previous Sonnet, well tested' },
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fastest and cheapest for simple jobs' }
    ]
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    billing: 'api key',
    models: [
      { id: 'openai/gpt-5', label: 'GPT-5', hint: 'general purpose flagship' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', hint: 'cheap and quick' },
      { id: 'openai/text-embedding-3-small', label: 'text-embedding-3-small', hint: 'embeddings, not chat' }
    ]
  },
  {
    provider: 'google',
    label: 'Google',
    billing: 'api key',
    models: [{ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'long context, strong vision' }]
  },
  {
    provider: 'ollama',
    label: 'Ollama',
    billing: 'local',
    models: [
      { id: 'ollama/llama3.2', label: 'Llama 3.2', hint: 'runs on your machine, no key needed' },
      { id: 'ollama/qwen2.5-coder', label: 'Qwen 2.5 Coder', hint: 'local coding model' }
    ]
  }
]

/**
 * Models that can actually embed.
 *
 * A separate list because embedding is not a thing every model does, and the
 * chat catalogue offered next to it is a trap: picking a chat model for the
 * embeddings role looks like it worked, saves without complaint, and then
 * quietly never embeds anything.
 *
 * Anthropic is absent on purpose, and it is the reason this list exists. It
 * publishes no embeddings endpoint at all — not for Haiku, not for any model —
 * so the Claude subscription is the one job it cannot cover. Ollama is the way
 * out: local, no key, nothing leaves the machine.
 */
export const EMBEDDING_CATALOG: ProviderGroup[] = [
  {
    provider: 'ollama',
    label: 'Ollama',
    billing: 'local',
    models: [
      {
        id: 'ollama/nomic-embed-text',
        label: 'nomic-embed-text',
        hint: 'local, no key — run: ollama pull nomic-embed-text'
      },
      {
        id: 'ollama/mxbai-embed-large',
        label: 'mxbai-embed-large',
        hint: 'local, larger and slower, better recall'
      }
    ]
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    billing: 'api key',
    models: [
      {
        id: 'openai/text-embedding-3-small',
        label: 'text-embedding-3-small',
        hint: 'cheap and good enough for recall'
      },
      {
        id: 'openai/text-embedding-3-large',
        label: 'text-embedding-3-large',
        hint: 'more accurate, costs more per token'
      }
    ]
  },
  {
    provider: 'google',
    label: 'Google',
    billing: 'api key',
    models: [
      {
        id: 'google/gemini-embedding-001',
        label: 'gemini-embedding-001',
        hint: 'Google’s embedding model'
      }
    ]
  }
]

/** Flat lookup for showing a friendly label next to a stored id. */
export function findModel(
  id: string,
  catalog: ProviderGroup[] = MODEL_CATALOG
): ModelOption | undefined {
  for (const group of catalog) {
    const hit = group.models.find((m) => m.id === id)
    if (hit) return hit
  }
  return undefined
}
