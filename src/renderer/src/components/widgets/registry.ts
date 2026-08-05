import {
  Users,
  Activity,
  FileText,
  Sparkles,
  ShieldCheck,
  FolderTree,
  FileCode,
  SquareTerminal,
  Search,
  BookOpen,
  ListChecks
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WidgetKind, WidgetGeom } from '@shared/types'

/**
 * What every widget kind is, in one table.
 *
 * The host reads this rather than switching on kind in five places, so adding a
 * widget is one entry plus one component.
 */
export interface WidgetMeta {
  label: string
  icon: LucideIcon
  /** Panel widgets appear on their own once they have something to say. Tool
   *  widgets are opened by the user, or by another widget — clicking a file in
   *  the navigator opens an editor. */
  auto: boolean
  /** Several can be open at once, each with its own state: three terminals, or
   *  two files side by side. */
  multi?: boolean
  /** Useless without a folder, so its bubble stays hidden until one is set. */
  needsFolder?: boolean
  size: { w: number; h: number }
}

export const WIDGETS: Record<WidgetKind, WidgetMeta> = {
  agents: { label: 'Agents', icon: Users, auto: true, size: { w: 300, h: 220 } },
  activity: { label: 'Activity', icon: Activity, auto: true, size: { w: 340, h: 280 } },
  files: { label: 'Files touched', icon: FileText, auto: true, size: { w: 360, h: 260 } },
  rules: { label: 'Rules', icon: Sparkles, auto: true, size: { w: 320, h: 240 } },
  permissions: { label: 'Permissions', icon: ShieldCheck, auto: true, size: { w: 300, h: 190 } },
  tasks: { label: 'Tasks', icon: ListChecks, auto: true, size: { w: 340, h: 300 } },
  navigator: {
    label: 'Files',
    icon: FolderTree,
    auto: false,
    needsFolder: true,
    size: { w: 300, h: 420 }
  },
  editor: {
    label: 'Editor',
    icon: FileCode,
    auto: false,
    multi: true,
    needsFolder: true,
    size: { w: 560, h: 460 }
  },
  terminal: {
    label: 'Terminal',
    icon: SquareTerminal,
    auto: false,
    multi: true,
    size: { w: 560, h: 340 }
  },
  search: {
    label: 'Search',
    icon: Search,
    auto: false,
    needsFolder: true,
    size: { w: 420, h: 400 }
  },
  skills: {
    label: 'Skills',
    icon: BookOpen,
    auto: false,
    needsFolder: true,
    size: { w: 340, h: 320 }
  }
}

/** The order tool widgets are offered in, and the order their bubbles stack. */
export const TOOL_KINDS: WidgetKind[] = ['navigator', 'editor', 'terminal', 'search', 'skills']
export const PANEL_KINDS: WidgetKind[] = [
  'tasks',
  'activity',
  'files',
  'agents',
  'rules',
  'permissions'
]

/** Smallest a widget may be dragged to. Below this the header alone fills it and
 *  the resize stops being reversible by pointer. */
export const MIN_W = 240
export const MIN_H = 150

/** Docked column sizing. The minimum is what a file tree needs to stay usable;
 *  the default is a comfortable reading width for an editor. */
export const MIN_DOCK = 260
export const DEFAULT_DOCK = 420
/** The bottom strip is measured in height, and wants to be shorter than a side
 *  column is wide — it is a terminal or a task list, not a document. */
export const MIN_DOCK_H = 130
export const DEFAULT_DOCK_H = 260

/** How close to an edge a drag has to get before it offers to snap there.
 *  Wide enough to hit without aiming, narrow enough that a widget parked near
 *  the side does not snap by accident. */
export const SNAP_EDGE = 42

/**
 * Where a newly opened widget lands.
 *
 * Staggered by how many are already open, so opening three terminals does not
 * put three identical rectangles on top of each other. Wraps back to the top
 * rather than marching off the bottom of a short window.
 */
export function defaultGeom(kind: WidgetKind, openCount: number, host: DOMRect): WidgetGeom {
  const { w, h } = WIDGETS[kind].size
  const step = 28
  const wrap = Math.max(1, Math.floor((host.height - h - 80) / step) || 1)
  const n = openCount % wrap
  return {
    // Right-anchored, clear of the bubble rail: the rail is the thing you just
    // clicked, and opening a panel over it would hide it under your own cursor.
    x: Math.max(12, host.width - w - 74 - n * step),
    y: 64 + n * step,
    w: Math.min(w, Math.max(MIN_W, host.width - 96)),
    h: Math.min(h, Math.max(MIN_H, host.height - 96))
  }
}

/** Keep a widget inside the chat, whatever the window did since it was placed. */
export function clampGeom(geom: WidgetGeom, host: DOMRect): WidgetGeom {
  const w = Math.min(Math.max(MIN_W, geom.w), Math.max(MIN_W, host.width - 16))
  const h = Math.min(Math.max(MIN_H, geom.h), Math.max(MIN_H, host.height - 16))
  return {
    w,
    h,
    // At least a header's worth stays reachable, so a widget dragged to the edge
    // can always be dragged back.
    x: Math.min(Math.max(-w + 120, geom.x), host.width - 60),
    y: Math.min(Math.max(0, geom.y), Math.max(0, host.height - 44))
  }
}
