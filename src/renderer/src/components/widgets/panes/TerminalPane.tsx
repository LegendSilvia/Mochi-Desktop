import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * xterm's palette, taken from the app's own tokens.
 *
 * Its default theme is a black background and the standard sixteen ANSI
 * colours, which lands a hard black rectangle in the middle of a soft, low
 * contrast surface — and the app has no pure black anywhere else. Reading the
 * live custom properties means the terminal also follows a light/dark switch
 * instead of being permanently dark.
 *
 * The background is the app's own surface rather than `transparent`: xterm only
 * honours transparency on its DOM renderer, and on the canvas one it falls back
 * to opaque black — which is both a hard rectangle in a soft layout and the one
 * colour this design never uses.
 */
function readTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback
  const tx = token('--tx', '#e9e7e2')
  return {
    background: token('--surf', '#1e2227'),
    foreground: tx,
    cursor: token('--ac', '#9dc98a'),
    cursorAccent: token('--bg', '#15171a'),
    selectionBackground: token('--acs', 'rgba(157, 201, 138, 0.25)'),
    // Softened to sit with the palette. The stock ANSI set is fully saturated
    // and reads as neon against these surfaces.
    black: token('--bg2', '#191c20'),
    red: token('--rose', '#d99a9a'),
    green: token('--ac', '#9dc98a'),
    yellow: token('--warm', '#e0b487'),
    blue: token('--blue', '#8fb2d8'),
    magenta: '#c3a5d8',
    cyan: '#8fcfc8',
    white: tx,
    brightBlack: token('--tx3', '#6b6862'),
    brightRed: token('--rose', '#d99a9a'),
    brightGreen: token('--ac', '#9dc98a'),
    brightYellow: token('--warm', '#e0b487'),
    brightBlue: token('--blue', '#8fb2d8'),
    brightMagenta: '#d4bce6',
    brightCyan: '#a6ded8',
    brightWhite: tx
  }
}

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
      theme: readTheme(),
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

    /*
     * Follow the theme.
     *
     * `readTheme` samples the CSS custom properties once, at construction — so a
     * terminal opened in light mode kept a light palette after switching to
     * dark, sitting in the layout as a white rectangle. The theme is stamped on
     * <html>, so watching that attribute is enough.
     */
    const themeWatch = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class']
    })

    return () => {
      themeWatch.disconnect()
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
