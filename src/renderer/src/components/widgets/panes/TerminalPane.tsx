import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * A shell, in a real terminal emulator.
 *
 * xterm.js because the PTY speaks ANSI: cursor moves, colours, alternate screen,
 * carriage returns that redraw a progress bar in place. Printing that into a
 * `<pre>` shows the escape codes rather than obeying them, which is how a
 * "terminal" ends up unable to run anything that draws.
 *
 * The emulator is created once and torn down on unmount, so collapsing the
 * widget destroys the view but not the shell — main keeps the process and its
 * backlog, and reopening replays it.
 */
export function TerminalPane({
  cwd,
  ptyId,
  onPty
}: {
  cwd: string
  /** Set once main has spawned a shell. Held by the widget rather than here so
   *  it survives this component unmounting when the widget collapses. */
  ptyId: string | null
  onPty: (id: string | null) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  /** Read inside listeners that must not be torn down and rebuilt every time
   *  the id changes. Mirrored in an effect rather than assigned during render —
   *  a render can be discarded, and this must only follow a committed one. */
  const idRef = useRef<string | null>(ptyId)
  useEffect(() => {
    idRef.current = ptyId
  }, [ptyId])

  // Build the emulator once.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      // Transparent so the widget's own surface shows through and the terminal
      // sits in the theme rather than punching a black hole in it.
      theme: { background: '#00000000' },
      allowTransparency: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const typed = term.onData((data) => {
      if (idRef.current) void window.mochi?.ptyWrite(idRef.current, data)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        if (idRef.current) void window.mochi?.ptyResize(idRef.current, term.cols, term.rows)
      } catch {
        // Fitting a zero-sized element throws; the widget is mid-collapse.
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      typed.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Attach to a shell: start one, or replay the backlog of the one already running.
  useEffect(() => {
    let cancelled = false
    const attach = async (): Promise<void> => {
      const term = termRef.current
      if (!term) return

      if (idRef.current) {
        const backlog = await window.mochi?.ptyBacklog(idRef.current)
        if (!cancelled && backlog) term.write(backlog)
        return
      }

      const available = await window.mochi?.ptyAvailable()
      if (available && !available.ok) {
        setError(available.error ?? 'No terminal support on this platform')
        return
      }
      const started = await window.mochi?.ptyStart(cwd, term.cols, term.rows)
      if (cancelled || !started) return
      if (!started.ok) {
        setError(started.error)
        return
      }
      onPty(started.id)
    }
    void attach()
    return () => {
      cancelled = true
    }
    // Runs on mount and whenever the widget is handed a different shell.
  }, [cwd, ptyId, onPty])

  // Output and exit, from main.
  useEffect(() => {
    const offData = window.mochi?.onPtyData(({ id, data }) => {
      if (id === idRef.current) termRef.current?.write(data)
    })
    const offExit = window.mochi?.onPtyExit(({ id, exitCode }) => {
      if (id !== idRef.current) return
      setExited(exitCode)
      termRef.current?.write(`\r\n\x1b[2m— exited (${exitCode}) —\x1b[0m\r\n`)
    })
    return () => {
      offData?.()
      offExit?.()
    }
  }, [])

  if (error) {
    return (
      <div className="wg-empty meta">
        The terminal could not start: {error}
      </div>
    )
  }

  return (
    <div className="wg-term">
      <div className="wg-term-host" ref={hostRef} />
      {exited !== null && (
        <button
          className="wg-btn-text wg-term-restart"
          onClick={() => {
            setExited(null)
            termRef.current?.clear()
            onPty(null)
          }}
        >
          Start a new shell
        </button>
      )}
    </div>
  )
}
