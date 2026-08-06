import { useMemo, useState, useSyncExternalStore } from 'react'
import { Trash2, Copy, Check } from 'lucide-react'
import { ScreenHeader } from '@renderer/components/ui/Controls'
import { clear, read, subscribe, type LogChannel } from '@renderer/lib/devlog'

const CHANNELS: Array<{ key: LogChannel; label: string }> = [
  { key: 'chat', label: 'chat' },
  { key: 'tool', label: 'tools' },
  { key: 'ipc', label: 'ipc' },
  { key: 'state', label: 'state' },
  { key: 'error', label: 'errors' }
]

/**
 * The debug log, behind developer mode.
 *
 * Reads the ring buffer in `lib/devlog` through `useSyncExternalStore` so the
 * pane repaints when entries arrive without the log itself having to live in
 * React state — see the note there about why that matters during a stream.
 */
export function LogPane(): React.JSX.Element {
  const entries = useSyncExternalStore(subscribe, read)
  const [off, setOff] = useState<LogChannel[]>([])
  const [copied, setCopied] = useState(false)

  const shown = useMemo(() => entries.filter((e) => !off.includes(e.channel)), [entries, off])

  const copyAll = (): void => {
    const text = shown
      .map((e) => `${stamp(e.at)}  ${e.channel.padEnd(6)} ${e.event}${e.detail ? `  ${e.detail}` : ''}`)
      .join('\n')
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      },
      () => {
        /* clipboard denied */
      }
    )
  }

  return (
    <>
      <ScreenHeader
        title="Debug log"
        subtitle="What the backend actually did, newest last. Cleared when you leave developer mode."
      />
      <div className="screen-body log-pane">
        <div className="log-bar">
          {CHANNELS.map((c) => (
            <button
              key={c.key}
              className="chip"
              data-on={!off.includes(c.key)}
              onClick={() =>
                setOff((prev) =>
                  prev.includes(c.key) ? prev.filter((k) => k !== c.key) : [...prev, c.key]
                )
              }
            >
              {c.label}
            </button>
          ))}
          <span className="session-spacer" />
          <span className="meta">{shown.length} entries</span>
          <button className="pill-ghost tiny" onClick={copyAll} disabled={shown.length === 0}>
            {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={1.9} />}
            Copy
          </button>
          <button className="pill-ghost tiny" onClick={clear} disabled={entries.length === 0}>
            <Trash2 size={12} strokeWidth={1.9} />
            Clear
          </button>
        </div>

        {shown.length === 0 ? (
          <p className="meta log-empty">
            Nothing captured yet. Send a message and the turn shows up here.
          </p>
        ) : (
          <div className="log-rows">
            {shown.map((e) => (
              <div key={e.seq} className="log-row" data-channel={e.channel}>
                <span className="mono log-time">{stamp(e.at)}</span>
                <span className="mono log-channel">{e.channel}</span>
                <span className="log-event">{e.event}</span>
                {e.detail && <span className="mono log-detail">{e.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
