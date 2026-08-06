import type { MenuPlacement } from './MascotMenu'

/** Matches .mo-bubble-item in mascot.css — the ring's geometry is computed
 *  here, so the two have to agree on how big a bubble is. */
const BUBBLE_PX = 38

export interface BubbleItem {
  id: string
  label: string
  icon: React.ReactNode
  onPick: () => void
}

/**
 * The bubble menu.
 *
 * Right-clicking the mascot arcs a ring of icons out from her, each one a thing
 * you can do without going to find the window. The arc bends away from whichever
 * screen edge she is parked against, because the overlay covers the work area
 * and anything drawn past its bounds is simply cut off.
 *
 * Icons rather than a list on purpose: this sits on top of whatever you were
 * doing, and a menu of words asks you to stop and read. Each carries a label
 * that appears on hover, so the meaning is one hover away rather than gone.
 */
export function BubbleMenu({
  items,
  placement,
  spriteSize,
  cardRef
}: {
  items: BubbleItem[]
  placement: MenuPlacement
  /** The sprite's configured px size. The mascot ranges from 72 to 200, so the
   *  ring has to be measured from her rather than fixed. */
  spriteSize: number
  /** Measured by the overlay's click-through hit test — see MascotMenu. */
  cardRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  /*
   * Where the arc sweeps.
   *
   * Angles are measured clockwise from straight up. A mascot in the bottom-right
   * corner has room up and to the left, so the ring opens that way; one on the
   * left opens right. The spread is deliberately less than a half-circle — a full
   * ring would put items behind the sprite where they are hard to hit.
   */
  const centre =
    placement.vertical === 'above'
      ? placement.horizontal === 'right'
        ? -45
        : placement.horizontal === 'left'
          ? 45
          : 0
      : placement.horizontal === 'right'
        ? -135
        : placement.horizontal === 'left'
          ? 135
          : 180

  const spread = 108
  // Half the sprite, plus half a bubble, plus a gap — so the ring sits just
  // outside her whatever size she is set to. A fixed radius put the bubbles on
  // top of her at anything above the default.
  const radius = Math.round(spriteSize / 2 + BUBBLE_PX / 2 + 14)
  const step = items.length > 1 ? spread / (items.length - 1) : 0
  const start = centre - spread / 2

  /*
   * The ring is given a real box.
   *
   * It used to be zero-sized, with each bubble translated out from that point —
   * which drew correctly and was completely unclickable, because the overlay's
   * click-through test measures this element's rect and a zero-sized element has
   * none. Sizing it to the circle it actually occupies is what makes the pointer
   * count as being over it.
   */
  const box = (radius + BUBBLE_PX / 2) * 2

  return (
    <div
      ref={cardRef}
      className="mo-bubbles"
      role="menu"
      aria-label="Mascot menu"
      style={{ width: box, height: box, marginLeft: -box / 2, marginTop: -box / 2 }}
    >
      {items.map((item, i) => {
        const angle = ((start + step * i) * Math.PI) / 180
        return (
          <button
            key={item.id}
            className="mo-bubble-item"
            role="menuitem"
            title={item.label}
            aria-label={item.label}
            // Each bubble is placed on the arc and staggered, so the ring reads
            // as unfolding rather than appearing all at once. The custom
            // properties feed the keyframes, which animate scale and opacity —
            // position stays put so nothing slides under the cursor mid-click.
            style={
              {
                '--x': `${Math.round(Math.sin(angle) * radius)}px`,
                '--y': `${Math.round(-Math.cos(angle) * radius)}px`,
                '--d': `${i * 34}ms`
              } as React.CSSProperties
            }
            onClick={item.onPick}
          >
            {item.icon}
            <span className="mo-bubble-label">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
