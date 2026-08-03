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

/** Flat lookup for showing a friendly label next to a stored id. */
export function findModel(id: string): ModelOption | undefined {
  for (const group of MODEL_CATALOG) {
    const hit = group.models.find((m) => m.id === id)
    if (hit) return hit
  }
  return undefined
}
