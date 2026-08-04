import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Copy,
  Trash2,
  Search,
  Star,
  Check,
  Undo2,
  Wand2,
  Upload,
  Download,
  X
} from 'lucide-react'
import { useStore } from '@renderer/state/context'
import {
  ArtPlaceholder,
  AutoTextarea,
  Row,
  ScreenHeader,
  Slider,
  Toggle
} from '@renderer/components/ui/Controls'
import { clearNavGuard, setNavGuard } from '@renderer/lib/navGuard'
import { useAgentArt } from '@renderer/lib/useAgentArt'
import { ModelPicker } from '@renderer/components/ui/ModelPicker'
import { BLANK_AGENT } from '@shared/defaults'
import type { AgentLoadout } from '@shared/types'
import './screens.css'

/** Field-by-field compare of the two loadouts, so an edit that ends up matching
 *  what was already saved does not leave the screen claiming to be dirty. */
function sameLoadout(a: AgentLoadout, b: AgentLoadout): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Slugify a name into an agent id, kept unique against the existing set. */
function makeId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Agents & loadouts. A loadout *is* an agent — there is no separate mascot entity. */
export function Agents(): React.JSX.Element {
  const { agents, settings, dispatch, library, reloadLibrary, server } = useStore()
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? '')
  const [filter, setFilter] = useState('')
  const [presets, setPresets] = useState<string[]>([])
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0]

  // Re-read on every library change so a folder created in the studio shows up
  // here without a restart.
  useEffect(() => {
    void window.mochi?.listPresets().then(setPresets)
  }, [library])

  // Art per loadout, resolved from each one's own folder. This used to compare
  // against the single loaded preset, so every non-default agent showed a letter.
  const art = useAgentArt(agents.map((a) => a.spritePreset))

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return agents
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q)
    )
  }, [agents, filter])

  /*
   * Edits are held in a draft until Save.
   *
   * Every keystroke used to go straight into the store, which persists on
   * change — so a half-typed persona was already the agent's real instructions,
   * and there was nothing to undo it with. The draft makes editing a decision
   * rather than a side effect, at the cost of having to guard the ways out.
   */
  /* The draft carries the id it belongs to. Storing the pair means a draft left
   * over from another loadout is simply *not this one's* and is ignored on
   * sight — no effect needed to clear it when the selection changes, which is
   * both simpler and avoids a render cascade on every switch. */
  const [draft, setDraft] = useState<{ id: string; value: AgentLoadout } | null>(null)
  const liveDraft = draft && draft.id === selectedId ? draft.value : null
  const edited = liveDraft ?? selected
  const dirty = Boolean(liveDraft && selected && !sameLoadout(liveDraft, selected))

  const patch = (p: Partial<AgentLoadout>): void => {
    if (!selected) return
    setDraft((d) => ({
      id: selected.id,
      value: { ...(d && d.id === selected.id ? d.value : selected), ...p }
    }))
  }

  const save = (): void => {
    if (!liveDraft) return
    const personaChanged =
      !selected ||
      liveDraft.name !== selected.name ||
      liveDraft.description !== selected.description ||
      liveDraft.instructions !== selected.instructions

    const commit = (next: AgentLoadout): void => {
      dispatch({ type: 'agents', agents: agents.map((a) => (a.id === next.id ? next : a)) })
      // The live mascot reads the default agent's folder, so committing a change
      // to that agent has to re-read the library.
      if (next.id === settings.defaultAgentId) reloadLibrary()
    }

    // Save immediately; the mascot's lines catch up a moment later. Blocking the
    // button on a model call would make saving a persona feel broken, and the
    // lines are a nicety — the built-in set covers the gap.
    commit(liveDraft)
    setDraft(null)

    // Hand-written lines are not overwritten by a persona edit — if you have
    // taken the trouble to word them yourself, a rename should not discard that.
    const handWritten = (rows?: string[]): boolean => (rows ?? []).some((l) => l.trim())
    if (!personaChanged) return
    // Each list is guarded on its own: wording the finish lines by hand should
    // not also freeze the poke lines at whatever they happened to be.
    if (!handWritten(liveDraft.bubbleLines)) generateLines(liveDraft, 'finish')
    if (!handWritten(liveDraft.pokeLines)) generateLines(liveDraft, 'poke')
  }

  /** Ask the agent for lines in its own voice. Shared by save and Regenerate. */
  const generateLines = (from: AgentLoadout, kind: 'finish' | 'poke'): void => {
    if (!server) return
    setGenerating(true)
    void fetch(`${server.baseUrl}/agent-sdk/mascot-lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        persona: [from.name, from.description, from.instructions].filter(Boolean).join('\n')
      })
    })
      .then((r) => r.json() as Promise<{ lines: string[] | null }>)
      .then(({ lines }) => {
        setGenerating(false)
        if (!lines?.length) return
        // Parked and applied in an effect: the user may have edited or switched
        // loadout while this was in flight, so it must land against the current
        // list rather than the one captured when the request went out.
        setPendingLines({ id: from.id, kind, lines })
      })
      .catch(() => setGenerating(false))
  }

  /** Regenerate uses whatever is on screen, including unsaved persona edits. */
  const regenerate = (): void => {
    if (edited) {
      generateLines(edited, 'finish')
      generateLines(edited, 'poke')
    }
  }

  const [bundleNote, setBundleNote] = useState<string | null>(null)

  /** Export the saved loadout, not the draft — shipping someone half-typed
   *  instructions is not what the button appears to promise. */
  const exportAgent = (a: AgentLoadout): void => {
    void window.mochi
      ?.agentExport(a, a.spritePreset, a.id)
      .then((r) =>
        setBundleNote(
          r.ok ? `Exported ${a.name}.` : r.error === 'cancelled' ? null : `Export failed: ${r.error}`
        )
      )
  }

  const importAgent = (): void => {
    void window.mochi?.agentImport().then((r) => {
      if (!r.ok) {
        setBundleNote(r.error === 'cancelled' ? null : `Import failed: ${r.error}`)
        return
      }
      const incoming = r.value.agent
      // The id and default flag belong to *this* install, not the bundle: a
      // clashing id would overwrite an existing loadout, and an imported agent
      // must never silently take over as default.
      const id = makeId(incoming.name || 'agent', agents.map((x) => x.id))
      const next: AgentLoadout = {
        ...incoming,
        id,
        isDefault: false,
        spritePreset: r.value.preset
      }
      dispatch({ type: 'agents', agents: [...agents, next] })
      setSelectedId(id)
      setBundleNote(`Imported ${next.name} with its mascot folder “${r.value.preset}”.`)
      reloadLibrary()
    })
  }

  const discard = (): void => setDraft(null)

  /* Generated lines land asynchronously, after `save` has already returned. They
   * are parked here and applied in an effect so the write happens against the
   * current agent list rather than the one captured when the request went out. */
  const [generating, setGenerating] = useState(false)
  const [pendingLines, setPendingLines] = useState<{
    id: string
    kind: 'finish' | 'poke'
    lines: string[]
  } | null>(null)
  useEffect(() => {
    if (!pendingLines) return
    setPendingLines(null)
    dispatch({
      type: 'agents',
      agents: agents.map((a) =>
        a.id === pendingLines.id
          ? {
              ...a,
              [pendingLines.kind === 'poke' ? 'pokeLines' : 'bubbleLines']: pendingLines.lines
            }
          : a
      )
    })
    // `agents` is deliberately out of the deps: this must run once per arrival,
    // not again every time the list changes for an unrelated reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLines, dispatch])

  // The guard runs inside `dispatch`, long after this render's closure is stale,
  // so it reads dirtiness through a ref rather than capturing it. Assigned in an
  // effect because a ref write during render is a side effect in disguise.
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  /** Shared by the nav guard and by switching loadouts inside this screen. */
  const askToLeave = useCallback((): boolean => {
    if (!dirtyRef.current) return true
    return window.confirm('You have unsaved changes to this loadout. Leave and lose them?')
  }, [])

  useEffect(() => {
    setNavGuard(askToLeave)
    return () => clearNavGuard(askToLeave)
  }, [askToLeave])

  // Closing the window is the other way out of an unsaved edit.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const selectLoadout = (id: string): void => {
    if (id === selectedId) return
    if (!askToLeave()) return
    setSelectedId(id)
  }

  const create = (from?: AgentLoadout): void => {
    // Falls back to BLANK_AGENT rather than agents[0], so the very first loadout
    // can be built on a fresh install where there is nothing to clone.
    const template = from ?? agents[0] ?? BLANK_AGENT
    const name = from ? `${from.name} copy` : 'New agent'
    const id = makeId(name, agents.map((a) => a.id))
    // The first agent becomes the default, or nothing would be selectable on the
    // Start screen and settings.defaultAgentId would stay dangling.
    const isFirst = agents.length === 0
    const next: AgentLoadout = {
      ...template,
      id,
      name,
      isDefault: isFirst,
      ...(from ? {} : { description: BLANK_AGENT.description, instructions: '' })
    }
    dispatch({ type: 'agents', agents: [...agents, next] })
    if (isFirst) dispatch({ type: 'settings', patch: { defaultAgentId: id } })
    setSelectedId(id)
  }

  const remove = (a: AgentLoadout): void => {
    // Keep at least one agent, and never strand sessions on a missing default.
    if (agents.length <= 1) return
    const rest = agents.filter((x) => x.id !== a.id)
    if (a.isDefault || settings.defaultAgentId === a.id) {
      rest[0] = { ...rest[0], isDefault: true }
      dispatch({ type: 'settings', patch: { defaultAgentId: rest[0].id } })
    }
    dispatch({ type: 'agents', agents: rest })
    if (selectedId === a.id) setSelectedId(rest[0].id)
  }

  const makeDefault = (a: AgentLoadout): void => {
    dispatch({
      type: 'agents',
      agents: agents.map((x) => ({ ...x, isDefault: x.id === a.id }))
    })
    dispatch({ type: 'settings', patch: { defaultAgentId: a.id } })
  }

  return (
    <>
      <ScreenHeader
        title="Agents & loadouts"
        subtitle="One loadout is one agent — persona, sprite, stickers, voice, tools, model and memory in a single bundle."
        action={
          <>
            <button className="pill-ghost" onClick={importAgent}>
              <Download size={14} strokeWidth={1.9} />
              Import
            </button>
            <button className="pill-primary" onClick={() => create()}>
              <Plus size={14} strokeWidth={2.2} />
              New loadout
            </button>
          </>
        }
      />
      <div className="screen-body">
        {bundleNote && (
          <div className="banner-warn bundle-note">
            <span className="field-grow">{bundleNote}</span>
            <button
              className="msg-action"
              aria-label="Dismiss"
              onClick={() => setBundleNote(null)}
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )}
        {agents.length > 5 && (
          <div className="loadout-filter">
            <Search size={13} strokeWidth={1.8} />
            <input
              className="loadout-filter-input"
              placeholder={`Filter ${agents.length} loadouts…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button className="pill-ghost tiny" onClick={() => setFilter('')}>
                clear
              </button>
            )}
          </div>
        )}

        <div className="loadout-grid">
          {shown.map((a) => (
            <div
              key={a.id}
              className="loadout-card"
              data-selected={a.id === selected.id}
              onClick={() => selectLoadout(a.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && selectLoadout(a.id)}
            >
              <div className="loadout-actions" onClick={(e) => e.stopPropagation()}>
                {!a.isDefault && (
                  <button
                    className="loadout-act"
                    title="Make default"
                    aria-label={`Make ${a.name} the default agent`}
                    onClick={() => makeDefault(a)}
                  >
                    <Star size={13} strokeWidth={1.8} />
                  </button>
                )}
                <button
                  className="loadout-act"
                  title="Duplicate"
                  aria-label={`Duplicate ${a.name}`}
                  onClick={() => create(a)}
                >
                  <Copy size={13} strokeWidth={1.8} />
                </button>
                <button
                  className="loadout-act"
                  title="Export this agent and its mascot art"
                  aria-label={`Export ${a.name}`}
                  onClick={() => exportAgent(a)}
                >
                  <Upload size={13} strokeWidth={1.8} />
                </button>
                {agents.length > 1 && (
                  <button
                    className="loadout-act danger"
                    title="Delete"
                    aria-label={`Delete ${a.name}`}
                    onClick={() => remove(a)}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                )}
              </div>

              <div className="loadout-avatar">
                {art[a.spritePreset] ? (
                  <img src={art[a.spritePreset] as string} alt="" draggable={false} />
                ) : (
                  <span className="agent-initial big">{a.name[0]}</span>
                )}
              </div>
              <span className="loadout-name">{a.name}</span>
              <span className="agent-desc">{a.description}</span>
              <div className="agent-chips">
                <span className="chip">{a.model.split('/')[1] ?? a.model}</span>
                <span className="chip">{a.toolIds.length} tools</span>
                <span className="chip">{a.workingMemory ? 'memory' : 'no memory'}</span>
              </div>
              <span className="meta">{a.isDefault ? 'default agent' : a.spritePreset}</span>
            </div>
          ))}
          <button className="loadout-new" onClick={() => create()}>
            <Plus size={18} strokeWidth={1.8} />
            <span>New loadout</span>
            <span className="meta">
              {agents.length === 0
                ? 'your first agent — then give it a name and instructions below'
                : 'starts from your default, then edit below'}
            </span>
          </button>
        </div>

        {/* Only when a filter is actually narrowing something. With no agents at
            all `shown` is empty too, and saying "no loadout matches “”" is the
            first thing a first-run user reads — step 2 of the tour sends every
            new user to exactly this screen in exactly that state. The "New
            loadout" card already says what to do. */}
        {shown.length === 0 && filter.trim() !== '' && (
          <p className="meta empty-filter">No loadout matches “{filter}”.</p>
        )}

        {/* Sticky rather than at the bottom of a tall card: with Instructions
            now growing to fit, the Save button would otherwise scroll out of
            reach exactly when there is most to lose. */}
        {/* Stays up while the mascot's lines are still being written, so the bar
            does not vanish the instant you hit Save and leave that work
            invisible. */}
        {(dirty || generating) && (
          <div className="save-bar">
            <span className="save-bar-text">
              {dirty ? (
                <>
                  Unsaved changes to <strong>{edited?.name}</strong> — saving also rewrites the
                  mascot&apos;s lines
                </>
              ) : (
                <>Saved. Writing the mascot&apos;s lines in this agent&apos;s voice…</>
              )}
            </span>
            {dirty && (
              <>
                <button className="pill-ghost" onClick={discard}>
                  <Undo2 size={13} strokeWidth={1.9} />
                  Discard
                </button>
                <button className="pill-primary" onClick={save}>
                  <Check size={13} strokeWidth={2.4} />
                  Save
                </button>
              </>
            )}
          </div>
        )}

        {selected && edited && (
          <div className="config-cols">
            <section className="config-card">
              <span className="section-label">{edited.name} — who it is</span>
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  className="field-input"
                  value={edited.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">Agent id</span>
                <input className="field-input mono" value={edited.id} readOnly />
              </label>
              <label className="field">
                <span className="field-label">Instructions</span>
                <AutoTextarea
                  value={edited.instructions}
                  minRows={6}
                  maxRows={26}
                  onChange={(v) => patch({ instructions: v })}
                />
              </label>
              <label className="field">
                <span className="field-label">Expected output</span>
                <AutoTextarea
                  value={edited.expectedOutput}
                  minRows={2}
                  maxRows={12}
                  placeholder="What a good reply from this agent looks like"
                  onChange={(v) => patch({ expectedOutput: v })}
                />
              </label>
              {/* Which mascot art this loadout wears. Until now `spritePreset`
                  could only be changed from the studio, and only for whichever
                  agent happened to be the default — so every other loadout was
                  stuck on whatever it was created with. */}
              <label className="field">
                <span className="field-label">Mascot folder</span>
                <div className="field-row">
                  <select
                    className="cell-select field-grow"
                    value={edited.spritePreset}
                    onChange={(e) => patch({ spritePreset: e.target.value })}
                  >
                    {/* A folder the agent points at but which no longer exists
                        still belongs in the list, or selecting anything else
                        would silently discard the reference. */}
                    {(presets.includes(edited.spritePreset)
                      ? presets
                      : [edited.spritePreset, ...presets]
                    ).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    className="pill-ghost tiny"
                    onClick={() => dispatch({ type: 'screen', screen: 'mascot' })}
                  >
                    Manage…
                  </button>
                </div>
              </label>

              {/* Written by the agent from its own persona on save, but editable
                  here — a generated line you cannot correct is worse than none. */}
              <label className="field">
                <span className="field-label">
                  When it finishes something
                  {edited.id !== settings.defaultAgentId && (
                    <span className="meta"> · only the default agent&apos;s are used</span>
                  )}
                </span>
                <AutoTextarea
                  value={(edited.bubbleLines ?? []).join('\n')}
                  minRows={3}
                  maxRows={10}
                  placeholder={'one line per row\nwritten for you when you save'}
                  onChange={(v) => patch({ bubbleLines: v.split('\n') })}
                />
                <div className="field-row">
                  <span className="meta field-grow">
                    Said when a turn lands while you are looking elsewhere. Saving a changed
                    persona rewrites these.
                  </span>
                  <button
                    className="pill-ghost tiny"
                    disabled={generating || !server}
                    onClick={() => regenerate()}
                  >
                    <Wand2 size={12} strokeWidth={1.9} />
                    {generating ? 'Writing…' : 'Regenerate'}
                  </button>
                </div>
              </label>

              {/* Kept apart from the lines above because the two moments are
                  different: one reports on work, the other answers a poke that
                  interrupted nothing. Sharing a list had it saying "that's done"
                  when you had only prodded it. */}
              <label className="field">
                <span className="field-label">When you poke it</span>
                <AutoTextarea
                  value={(edited.pokeLines ?? []).join('\n')}
                  minRows={3}
                  maxRows={10}
                  placeholder={'one line per row\nwritten for you when you save'}
                  onChange={(v) => patch({ pokeLines: v.split('\n') })}
                />
                <span className="meta">
                  Said when you click the mascot or press Poke, with nothing in progress.
                </span>
              </label>
              <div className="field">
                <span className="field-label">Model</span>
                <ModelPicker value={selected.model} onChange={(model) => patch({ model })} />
              </div>
            </section>

            <section className="config-card">
              <span className="section-label">How it behaves</span>
              <Row label="Chattiness" hint={`${selected.chattiness}/10`}>
                <Slider
                  value={selected.chattiness}
                  onChange={(v) => patch({ chattiness: v })}
                  label="Chattiness"
                />
              </Row>
              <Row label="Sticker frequency" hint={`${selected.stickerFrequency}/10`}>
                <Slider
                  value={selected.stickerFrequency}
                  onChange={(v) => patch({ stickerFrequency: v })}
                  label="Sticker frequency"
                />
              </Row>
              <Row label="Working memory" hint="remembers facts about you between sessions">
                <Toggle
                  on={selected.workingMemory}
                  onChange={(v) => patch({ workingMemory: v })}
                  label="Working memory"
                />
              </Row>
              <Row label="Semantic recall" hint="finds relevant older messages">
                <Toggle
                  on={selected.semanticRecall}
                  onChange={(v) => patch({ semanticRecall: v })}
                  label="Semantic recall"
                />
              </Row>
              <Row label="Voice replies">
                <Toggle
                  on={selected.voiceReplies}
                  onChange={(v) => patch({ voiceReplies: v })}
                  label="Voice replies"
                />
              </Row>
              <Row
                label="Can push to git without asking"
                hint="off by default — this one is worth keeping off"
              >
                <Toggle
                  on={selected.canPushWithoutAsking}
                  onChange={(v) => patch({ canPushWithoutAsking: v })}
                  label="Push without asking"
                />
              </Row>
              <div className="field">
                <span className="field-label">Stickers it may send</span>
                <span className="meta">
                  {selected.allowedStickerIds?.length
                    ? `${selected.allowedStickerIds.length} picked — it will only use these`
                    : 'none picked — it may use any sticker in your folder'}
                </span>
                <div className="allow-grid">
                  {(library?.stickers ?? []).map((s) => {
                    const on = selected.allowedStickerIds?.includes(s.id) ?? false
                    return (
                      <button
                        key={s.id}
                        className="allow-tile"
                        data-on={on}
                        title={s.name}
                        aria-pressed={on}
                        onClick={() => {
                          const current = selected.allowedStickerIds ?? []
                          patch({
                            allowedStickerIds: on
                              ? current.filter((id) => id !== s.id)
                              : [...current, s.id]
                          })
                        }}
                      >
                        {s.src ? <img src={s.src} alt={s.name} /> : <span className="mono">{s.name}</span>}
                      </button>
                    )
                  })}
                </div>
                {selected.allowedStickerIds?.length ? (
                  <button className="pill-ghost tiny" onClick={() => patch({ allowedStickerIds: [] })}>
                    clear — allow any
                  </button>
                ) : null}
              </div>

              <Row label="Mascot preset" hint={`mascots/${selected.spritePreset}/`}>
                <button
                  className="pill-ghost"
                  onClick={() => dispatch({ type: 'screen', screen: 'mascot' })}
                >
                  Change
                </button>
              </Row>
            </section>
          </div>
        )}
      </div>
    </>
  )
}

export { ArtPlaceholder }
