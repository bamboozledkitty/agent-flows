import type { ClientModule, ClientPointerEvent, ClientKeyEvent } from 'claude-code'

import type {
  AvailableSession,
  CanvasBatch,
  CanvasEdge,
  CanvasMessage,
  CanvasNode,
  CanvasProps,
  CardKind,
  CheckKind,
  Effort,
  PermMode,
  RunStatus,
} from '../types'

// Card size in cells; keep in step with CARD in flow.ts (new-card placement).
export const NODE_W = 28
export const NODE_H = 6
const DOUBLE_CLICK_MS = 450

/**
 * A post in the same frame as another replaces it, so a click that saves a box and
 * runs the flow would lose the save. Each post carries the messages of the last
 * two seconds, numbered; the hooks module takes each number once.
 */
const SENDER = Math.random().toString(36).slice(2)
const RESEND_MS = 2000
/** Whether the latest drawing had a card running: the blink clock stops when none does. */
let isRunningNow = false
let lastSeq = 0
let recent: { seq: number; at: number; m: CanvasMessage }[] = []
function postMessage(post: (b: CanvasBatch) => void, m: CanvasMessage) {
  const at = Date.now()
  recent = [...recent.filter(r => at - r.at < RESEND_MS), { seq: ++lastSeq, at, m }].slice(-30)
  post({ t: 'batch', sender: SENDER, items: recent.map(({ seq, m }) => ({ seq, m })) })
}
// Layout: the Flows list on the left, details on the right, the open flow's canvas between.
const LEFT_W = 26
const RIGHT_W = 38

type Drag =
  | { kind: 'node'; id: string; dx: number; dy: number; moved: boolean }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  /**
   * A new link being dragged out of a dot; x, y: the pointer, in world cells. `out`:
   * from `from`'s output `port` to a card's input; `in`: back from `from`'s input to
   * a card's output.
   */
  | { kind: 'link'; dir: 'out' | 'in'; from: string; port: string; sx: number; sy: number; x: number; y: number; moved: boolean; toModel?: boolean }
  /** A link's arrowhead being dragged to another card. */
  | { kind: 'rewire'; edgeId: string; from: string; to: string; sx: number; sy: number; x: number; y: number; moved: boolean }

/**
 * A text field being typed into on the canvas, until Enter saves it. `card`: one of
 * a logic card's settings, named by `field`. `run`: the command Run flow sends.
 */
type Edit = { kind: 'name' | 'prompt' | 'instructions' | 'flow-name' | 'card' | 'run' | 'test'; id: string; text: string; field?: string; pos?: number }

type Local = {
  pan: { x: number; y: number }
  drag: Drag | null
  /** Position overrides while dragging, until the hooks module echoes the move. */
  held: Record<string, { x: number; y: number }>
  lastDown: { id: string; at: number } | null
  edit: Edit | null
  /** The flow whose Delete was pressed once; a second press deletes it. */
  confirmDelete: string | null
  /** Why the last drop made no link, shown until the next click. */
  notice: string | null
  /** The Add card menu is open. */
  menu: boolean
  /** The view's scale, one of ZOOMS. Pan is in view cells. */
  zoom: number
  /** The running-chat browser: its search, the highlighted row and first row shown, and the folder box while typed in. */
  browse: Browse | null
  /** The last paste taken in. */
  pasteSeq?: number
  /** The chat view: its first row shown while scrolled back, for the chat it was scrolled in; absent, it follows the newest. */
  chatFirst?: number
  chatFor?: string
  /** The details panel's first row shown, for the card or link it was scrolled on. */
  detailTop?: number
  detailFor?: string | null
  /** Which half of a running card's blink is drawn, and whether its clock has started. */
  blink?: boolean
  /** The canvas code whose blink clock runs: a reloaded one starts its own. */
  ticking?: string
}

type Browse = { dir: string; q: string; hi: number; top: number; folder: string | null; qPos?: number; fPos?: number }

/** The orange that marks folders with running chats in them or below. */
const CHAT_ORANGE = '#FF8700'

// Keep in step with showPath and matchChat in picker.ts (the canvas module draws on its own).
const showPath = (path: string, home: string) =>
  path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
const matchChat = (c: AvailableSession, query: string, dir: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const below = c.cwd.startsWith(dir) ? c.cwd.slice(dir.length) : c.cwd
  return c.name.toLowerCase().includes(q) || below.toLowerCase().includes(q)
}
const parentOf = (dir: string) => (dir.lastIndexOf('/') <= 0 ? '/' : dir.slice(0, dir.lastIndexOf('/')))

/** Key names the host sends for keys that type nothing. */
const NAMED_KEYS = new Set(['up', 'down', 'left', 'right', 'return', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape', 'insert', 'clear'])
/** The text a key types: one character, or a whole paste; null for a named key or a shortcut. */
const typedText = (k: ClientKeyEvent) => {
  if (k.ctrl || k.meta) return null
  if (k.key === 'space') return ' '
  if ([...k.key].length === 1) return k.key
  return NAMED_KEYS.has(k.key) || /^f\d{1,2}$/.test(k.key) ? null : k.key.replace(/[\r\n\t]+/g, ' ')
}

/** A text box's text and its cursor, 0 to the text's length. */
type Caret = { text: string; pos: number }
type Line = { start: number; text: string }
const CARET = '▏'

/**
 * Lays text out in lines of at most `width`, breaking after a space and keeping
 * every character, so a cursor position and a clicked cell map onto each other.
 */
function layoutText(text: string, width: number): Line[] {
  const w = Math.max(1, width)
  const lines: Line[] = []
  let i = 0
  while (text.length - i > w) {
    const cut = text.lastIndexOf(' ', i + w - 1)
    const end = cut >= i ? cut + 1 : i + w
    lines.push({ start: i, text: text.slice(i, end) })
    i = end
  }
  lines.push({ start: i, text: text.slice(i) })
  return lines
}
const lineAt = (lines: Line[], pos: number) => {
  let i = 0
  while (i + 1 < lines.length && lines[i + 1]!.start <= pos) i++
  return i
}
/** Where a click `dx` cells into a shown line puts the cursor; `caretCol`: where the cursor is drawn on it, if it is. */
const posIn = (line: Line, dx: number, caretCol: number | null) =>
  line.start + Math.max(0, Math.min(caretCol !== null && dx > caretCol ? dx - 1 : dx, line.text.length))

/**
 * One key in a text box: the text and cursor after it, or null for a key the box
 * doesn't take. `lines`: the box's layout, for up, down, Home and End by line.
 */
function keyInto(c: Caret, k: ClientKeyEvent, lines?: Line[]): Caret | null {
  const key = k.key
  const at = (pos: number): Caret => ({ text: c.text, pos: Math.max(0, Math.min(c.text.length, pos)) })
  const i = lines ? lineAt(lines, c.pos) : 0
  const line = lines?.[i]
  if (key === 'left') return at(c.pos - 1)
  if (key === 'right') return at(c.pos + 1)
  if (key === 'home' || (k.ctrl && key === 'a')) return at(line ? line.start : 0)
  if (key === 'end' || (k.ctrl && key === 'e')) {
    if (!line || !lines || i === lines.length - 1) return at(line ? line.start + line.text.length : c.text.length)
    return at(line.start + line.text.length - 1) // before the space the line breaks at
  }
  if (key === 'up' || key === 'down') {
    if (!lines || !line) return null
    const to = lines[i + (key === 'up' ? -1 : 1)]
    if (!to) return at(key === 'up' ? 0 : c.text.length)
    const last = to === lines[lines.length - 1]
    return at(to.start + Math.min(c.pos - line.start, to.text.length - (last ? 0 : 1)))
  }
  if (key === 'backspace' || key === 'delete') {
    if (c.pos === 0) return c
    return { text: c.text.slice(0, c.pos - 1) + c.text.slice(c.pos), pos: c.pos - 1 }
  }
  const typed = typedText(k)
  if (typed === null) return null
  return { text: c.text.slice(0, c.pos) + typed + c.text.slice(c.pos), pos: c.pos + typed.length }
}
/** A box's text and cursor; with no cursor yet, at the end. */
const caretOf = (e: { text: string; pos?: number }): Caret => ({ text: e.text, pos: Math.min(e.pos ?? e.text.length, e.text.length) })
const insertAt = (c: Caret, text: string): Caret => ({ text: c.text.slice(0, c.pos) + text + c.text.slice(c.pos), pos: c.pos + text.length })
const isPasteKey = (k: ClientKeyEvent) => (k.meta || k.ctrl) && k.key.toLowerCase() === 'v'

type Cell = { ch: string; color?: string; bold?: boolean; dim?: boolean }

// Line joins: each cell keeps which sides a line touches, then picks the box glyph.
const U = 1, D = 2, L = 4, R = 8
const JOIN: Record<number, string> = {
  [L]: '─', [R]: '─', [L | R]: '─', [U]: '│', [D]: '│', [U | D]: '│',
  [R | D]: '╭', [L | D]: '╮', [R | U]: '╰', [L | U]: '╯',
  [L | R | D]: '┬', [L | R | U]: '┴', [U | D | R]: '├', [U | D | L]: '┤', [U | D | L | R]: '┼',
}

const STATUS_COLOR: Record<RunStatus, string | undefined> = {
  idle: undefined, queued: 'blue', running: 'yellow', done: 'green', error: 'red', stopped: 'gray',
}
const STATUS_ICON: Record<RunStatus, string> = {
  idle: '○', queued: '◔', running: '●', done: '✓', error: '✕', stopped: '■',
}
const statusWord = (n: { status: RunStatus; hasSession: boolean }) =>
  n.status === 'idle'
    ? n.hasSession ? 'Idle' : 'Not started'
    : { queued: 'Queued', running: 'Working…', done: 'Done', error: 'Error', stopped: 'Stopped' }[n.status]

/** Status in one short word, for the Flows list. */
const statusShort = (n: { status: RunStatus; hasSession: boolean }) =>
  n.status === 'idle'
    ? n.hasSession ? 'idle' : 'new'
    : { queued: 'queued', running: 'working', done: 'done', error: 'error', stopped: 'stopped' }[n.status]

const CHECKS: { check: CheckKind; label: string }[] = [
  { check: 'judge', label: 'Claude judges it true…' },
  { check: 'contains', label: 'It contains text…' },
  { check: 'not-contains', label: "It doesn't contain text…" },
  { check: 'regex', label: 'It matches a pattern…' },
]
const valueLabel = (c: CheckKind) => (c === 'regex' ? 'PATTERN' : c === 'judge' ? 'CLAUDE CHECKS THAT…' : 'TEXT')
const valueHint = (c: CheckKind) => (c === 'regex' ? 'e.g. score: [89]\\d' : c === 'judge' ? 'e.g. the review approved it' : 'e.g. PASS')

// Keep in step with KINDS in cards.ts (the canvas module draws on its own).
const KINDS: { kind: CardKind; icon: string; label: string; blurb: string; color: string }[] = [
  { kind: 'agent', icon: '●', label: 'Agent', blurb: 'A Claude chat', color: 'white' },
  { kind: 'start', icon: '▶', label: 'Start', blurb: 'The command a run begins with', color: 'green' },
  { kind: 'if', icon: '◇', label: 'If / Else', blurb: 'Yes or no on a condition', color: 'yellow' },
  { kind: 'switch', icon: '⑂', label: 'Switch', blurb: 'Pick one named branch', color: 'yellow' },
  { kind: 'all', icon: '⧓', label: 'And (all)', blurb: 'Wait for every input', color: 'blue' },
  { kind: 'first', icon: '⧗', label: 'Or (first)', blurb: 'Pass on the first reply', color: 'blue' },
  { kind: 'prompt', icon: '✎', label: 'Prompt', blurb: 'Rewrite the message', color: 'magenta' },
  { kind: 'loop', icon: '↻', label: 'Loop until', blurb: 'Again until a condition holds', color: 'yellow' },
  { kind: 'model', icon: '◈', label: 'Model', blurb: "Set agents' model and effort", color: 'blue' },
  { kind: 'end', icon: '■', label: 'End', blurb: 'Show and save the final answer', color: 'green' },
  { kind: 'note', icon: '✐', label: 'Note', blurb: 'A note for the team', color: 'gray' },
]
const metaOf = (k: CardKind) => KINDS.find(x => x.kind === k)!
const portLabel = (port: string) =>
  ({ out: 'Out', yes: 'Yes', no: 'No', other: 'Other', done: 'Done', again: 'Again' } as Record<string, string>)[port] ?? port
/**
 * A card in bands: title, then the sockets row (input left, output right), then its
 * body, and for an agent its status and button. These rows, from a card's top, are
 * where the dots sit; keep in step with portRow in cards.ts.
 */
const SOCKET_ROW = { agent: 4, other: 3 }
/** The row, from a card's top, of its input dot on the left edge. */
const inputRow = (n: Pick<CanvasNode, 'kind'>) => (n.kind === 'agent' ? SOCKET_ROW.agent : SOCKET_ROW.other)
/** An agent's second input, under the first: its model, from a Model card. */
const MODEL_ROW = SOCKET_ROW.agent + 1
/** The row a link from `port` leaves at: the sockets row for one output, else one row each under the body. */
const portRow = (n: CanvasNode, port: string) => (n.ports.length <= 1 ? inputRow(n) : 7 + Math.max(0, n.ports.indexOf(port)))

/** Zoom steps, out to in. Text cells can't grow, so 100% is the closest view. */
const ZOOMS = [0.5, 0.75, 1]
/**
 * Card size and dot rows at a zoom. Below 100% cards are compact: a name row and
 * a status (or summary) row, or one row per named output; dots sit one row higher.
 */
type Geo = { z: number; w: number; isCompact: boolean }
const geoAt = (z: number): Geo => (z >= 1 ? { z: 1, w: NODE_W, isCompact: false } : { z, w: Math.round(NODE_W * z), isCompact: true })
/** A card's input dot row, and an agent's model dot row, at a zoom. */
const inRowAt = (n: Pick<CanvasNode, 'kind'>, g: Geo) => (g.isCompact ? 1 : inputRow(n))
const modelRowAt = (g: Geo) => (g.isCompact ? 2 : MODEL_ROW)
const portRowAt = (n: CanvasNode, port: string, g: Geo) =>
  !g.isCompact ? portRow(n, port) : n.ports.length <= 1 ? 1 : 2 + Math.max(0, n.ports.indexOf(port))
const heightAt = (n: CanvasNode, g: Geo) => (!g.isCompact ? n.ht : n.ports.length > 1 ? n.ports.length + 3 : 4)
/** Cards a link can't start from, or end at. */
const canLinkFrom = (n: CanvasNode) => n.ports.length > 0
const canLinkTo = (n: CanvasNode) => n.kind !== 'start' && n.kind !== 'note' && n.kind !== 'model'

// Keep in step with EFFORTS in cards.ts; unset is the model's own default.
const EFFORTS: { effort: Effort | ''; label: string }[] = [
  { effort: '', label: 'Default' },
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra high' },
  { effort: 'max', label: 'Max' },
]
const shortModel = (id: string) => id.replace(/^claude-/, '')

const MODES: { mode: PermMode; label: string }[] = [
  { mode: 'default', label: 'Ask' },
  { mode: 'acceptEdits', label: 'Edits' },
  { mode: 'plan', label: 'Plan' },
]

const clip = (text: string, n: number) => (n <= 0 ? '' : text.length > n ? text.slice(0, Math.max(0, n - 1)) + '…' : text)
const clipStart = (text: string, n: number) => (text.length > n ? '…' + text.slice(text.length - n + 1) : text)
/** Cuts from the middle, so a name's end (an agent's number) stays readable. */
const clipMid = (text: string, n: number) => {
  if (text.length <= n) return text
  const tail = Math.min(8, Math.floor((n - 1) / 2))
  return text.slice(0, n - 1 - tail) + '…' + text.slice(text.length - tail)
}
const oneLine =(s: string) => s.replace(/\s+/g, ' ').trim()

/** Text in lines of `width`, its own line breaks kept, `max` lines at most. */
function wrapText(text: string, width: number, max: number): string[] {
  const out = text.split('\n').flatMap(l => (l.trim() ? wrap(l, width, 1000) : ['']))
  while (out.length && !out[0]) out.shift()
  return out.length > max ? [...out.slice(0, max - 1), '… (more in the chat view)'] : out
}

/** Markdown's marks taken out, for text drawn in cells: **bold**, `code`, [links](url), # headings. */
const plain = (s: string) =>
  s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/gm, '')

/**
 * An agent's newest activity in `max` lines of `width`: its reply lines (the prompt
 * that started the turn left out when there are any), wrapped, the latest kept.
 */
function activityTail(preview: string[], width: number, max: number): string[] {
  const replies = preview.filter(p => !p.startsWith('▸'))
  const text = (replies.length ? replies : preview).map(plain).join('\n')
  const lines = text.split('\n').flatMap(l => (l.trim() ? wrap(l, width, 1000) : []))
  if (lines.length <= max) return lines
  const kept = lines.slice(-max)
  kept[0] = clip('… ' + kept[0], width)
  return kept
}

/** An agent card's foot: what clicking it opens, or how to start one with no chat yet. */
const agentCta = (n: CanvasNode): { text: string; style: { color?: string; bold?: boolean; dim?: boolean }; opens: boolean } =>
  n.status === 'running' ? { text: 'Watch live ›', style: { color: 'yellow', bold: true }, opens: true }
    : n.hasSession ? { text: 'See response ›', style: { color: 'cyan', bold: true }, opens: true }
      : { text: 'Double-click to start', style: { dim: true }, opens: false }

/** The selected agent's activity drawer, under its card: width, and rows at most. */
const DRAWER_W = 60
const DRAWER_ROWS = 14

/** A card's name in two lines at most, broken after a hyphen or at a space where one is near. */
function wrapName(name: string, width: number): string[] {
  if (name.length <= width) return [name]
  const dash = name.lastIndexOf('-', width - 1)
  const space = name.lastIndexOf(' ', width)
  const at = dash > width / 3 ? dash + 1 : space > width / 3 ? space : width
  return [name.slice(0, at).trimEnd(), clipMid(name.slice(at).trimStart(), width)]
}

/** A running card's dot: bright, then dim, every BLINK_MS. */
const BLINK_MS = 600

/** Word-wraps to `width`, at most `max` lines, the last one ending in … when cut. */
function wrap(text: string, width: number, max: number): string[] {
  const words = oneLine(text).split(' ').filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (next.length <= width) line = next
    else {
      if (line) out.push(line)
      // A word wider than a line breaks across lines rather than being cut.
      let rest = w
      while (rest.length > width) {
        out.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      line = rest
    }
  }
  if (line) out.push(line)
  if (out.length > max) {
    const kept = out.slice(0, max)
    kept[max - 1] = clip(kept[max - 1]! + ' …', width)
    return kept
  }
  return out
}

/** Text being typed: wrapped, its last `max` lines kept so the caret stays in view. */
function wrapTail(text: string, width: number, max: number): string[] {
  const all = wrap(text, width, Infinity)
  if (all.length <= max) return all
  const kept = all.slice(-max)
  kept[0] = '…' + kept[0]!.slice(1)
  return kept
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000))
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

// A panel row: pieces of text, each optionally clickable; a whole-row click is `act`.
/** A clickable piece's action gets the clicked column, from the piece's first cell. */
type Act = (dx: number) => void
type Seg = { text: string; act?: Act; color?: string; bold?: boolean; dim?: boolean }
/** A button in a grid: its label, what it does, its colour. */
type GridButton = [string, () => void, string]
type Row = { segs: Seg[]; act?: Act; color?: string; bold?: boolean; dim?: boolean; right?: Seg }
const row = (text: string, opts: Omit<Row, 'segs'> = {}): Row => ({ segs: [{ text }], ...opts })
const heading = (text: string): Row => row(text, { dim: true, bold: true })
const blank = (): Row => row('')
const button = (label: string, act: () => void, color = 'cyan'): Seg => ({ text: `[ ${label} ]`, act, color, bold: true })
const gap = (n = 2): Seg => ({ text: ' '.repeat(n) })

type Hit = { x1: number; x2: number; y: number; act: Act }
type Panel = { x: number; y: number; w: number; ht: number; hits: Hit[] }

type LaidEdge = { id: string; points: [number, number][]; label: string; lx: number; ly: number; arrow: [number, number, string] }

/**
 * Routes every link out of its source's output dot (right edge) and into its
 * target's input dot (left edge), so every card reads left-in, right-out. A target
 * well to the right takes a straight run; any other (left of, above, below, or
 * overlapping the source) takes a lane of its own around the cards, its across run
 * on the nearest row that crosses no card. The handle sits on the line.
 */
export function layoutEdges(nodes: CanvasNode[], edges: CanvasProps['edges'], g: Geo = geoAt(1)): LaidEdge[] {
  const at = new Map(nodes.map(n => [n.id, n]))
  const live = edges.flatMap(e => {
    const a = at.get(e.from)
    const b = at.get(e.to)
    return a && b ? [{ e, a, b, isRight: a.id !== b.id && b.x >= a.x + g.w + 6 }] : []
  })
  const inCard = (x: number, y: number, skip: string[] = []) =>
    nodes.some(n => !skip.includes(n.id) && x >= n.x && x < n.x + g.w && y >= n.y && y < n.y + n.ht)

  /** The handle sits on the line itself, at the middle of its longest run: never on a card. */
  const onLine = (pts: [number, number][], label: string) => {
    let best = { x1: pts[0]![0], y1: pts[0]![1], x2: pts[0]![0], y2: pts[0]![1], len: -1 }
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i]!
      const [x2, y2] = pts[i + 1]!
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1)
      if (len > best.len) best = { x1, y1, x2, y2, len }
    }
    const mx = Math.round((best.x1 + best.x2) / 2)
    const my = Math.round((best.y1 + best.y2) / 2)
    return { lx: best.y1 === best.y2 ? mx - Math.floor(label.length / 2) : mx, ly: my }
  }

  // Each source spreads its straight runs' turning columns, and each lane route its own lane.
  const rightIndex = new Map<string, number>()
  const laneIndex = new Map<string, number>()
  const perSource = new Map<string, number>()
  for (const l of live) {
    if (l.isRight) {
      const i = perSource.get(l.a.id) ?? 0
      rightIndex.set(l.e.id, i)
      perSource.set(l.a.id, i + 1)
    } else laneIndex.set(l.e.id, laneIndex.size)
  }

  return live.map(({ e, a, b, isRight }): LaidEdge => {
    const sx = a.x + g.w
    const sy = a.y + portRowAt(a, e.port, g)
    const tx = b.x - 1
    const ty = b.y + (e.isModel ? modelRowAt(g) : inRowAt(b, g))
    if (isRight) {
      const lane = rightIndex.get(e.id) ?? 0
      const mx = Math.min(tx - 2, sx + 3 + lane * 2)
      const points: [number, number][] = sy === ty ? [[sx, sy], [tx, ty]] : [[sx, sy], [mx, sy], [mx, ty], [tx, ty]]
      return { id: e.id, points, label: e.label, ...onLine(points, e.label), arrow: [tx, ty, '▶'] }
    }
    // Around: out right, along a clear row, down (or up) to the target's input row, in from the left.
    const k = laneIndex.get(e.id) ?? 0
    const ox = sx + 2 + k
    const ix = b.x - 3 - k
    const ends = [a.id, b.id]
    const isClear = (ry: number) => {
      for (let x = Math.min(ix, ox); x <= Math.max(ix, ox); x++) if (inCard(x, ry)) return false
      for (let y = Math.min(sy, ry); y <= Math.max(sy, ry); y++) if (inCard(ox, y, ends)) return false
      for (let y = Math.min(ry, ty); y <= Math.max(ry, ty); y++) if (inCard(ix, y, ends)) return false
      return true
    }
    // Rows between the two cards first, then above and below both.
    const top = Math.min(a.y, b.y)
    const bottom = Math.max(a.y + a.ht, b.y + b.ht)
    const between = b.y >= a.y + a.ht ? range(a.y + a.ht, b.y - 1) : a.y >= b.y + b.ht ? range(b.y + b.ht, a.y - 1).reverse() : []
    const candidates = [...between, ...Array.from({ length: 16 }, (_, i) => [top - 2 - i - k, bottom + 1 + i + k]).flat()]
    const ry = candidates.find(isClear) ?? top - 2 - k
    const points: [number, number][] = [[sx, sy], [ox, sy], [ox, ry], [ix, ry], [ix, ty], [tx, ty]]
    return { id: e.id, points, label: e.label, ...onLine(points, e.label), arrow: [tx, ty, '▶'] }
  })
}

/** Whether two cells draw in one style. */
const same = (a: Cell, b: Cell) => a.color === b.color && a.bold === b.bold && a.dim === b.dim

/** Terminal colors the desktop app's light theme washes out, as the theme's own. */
const DESKTOP_COLOR: Record<string, string> = { yellow: 'warning' }

/** A symbol or line glyph: wider than a cell in the desktop app's font, so each is placed in its own. */
const isGlyph = (ch: string) => ch.codePointAt(0)! >= 0x2190
const LINE = '─━┄'
const GLYPH_BOX = { width: 1, justifyContent: 'center' } as const

type DesktopRun = {
  x: number
  text: string
  cell: Cell
  /** Cells it is held to: a glyph's one, a line's length; a text's none. */
  width?: number
}
/** A run on its row; `height` on an upright line, one glyph drawn down that many rows. */
type DesktopPiece = DesktopRun & { y: number; height?: number }
const UPRIGHT = '│┃┆'

/**
 * Every row's runs, an upright line's glyphs gathered into one piece per column:
 * card and panel sides are most of what a canvas holds, and a tree has a size limit.
 */
function desktopPieces(grid: Cell[][]): DesktopPiece[] {
  const out: DesktopPiece[] = []
  const open = new Map<number, DesktopPiece>()
  grid.forEach((line, y) => {
    for (const run of desktopRuns(line)) {
      const above = open.get(run.x)
      if (UPRIGHT.includes(run.text)) {
        if (above && above.text === run.text && above.y + above.height! === y && same(above.cell, run.cell)) above.height!++
        else {
          const piece = { ...run, y, height: 1 }
          open.set(run.x, piece)
          out.push(piece)
        }
      } else out.push({ ...run, y })
    }
  })
  return out
}

/**
 * A row as the desktop app can draw it. Its text font is proportional, so nothing
 * lines up by counting characters: each piece is placed at its own column instead.
 * Words keep together, a gap of two spaces or more starts a new piece, a glyph
 * sits centred in its cell, and a horizontal line is cut to its length and its one
 * row: its glyphs are wider than cells, and what doesn't fit would wrap below.
 */
function desktopRuns(line: Cell[]): DesktopRun[] {
  const out: DesktopRun[] = []
  let text: DesktopRun | null = null
  for (let x = 0; x < line.length; x++) {
    const cell = line[x]!
    const ch = cell.ch
    if (isGlyph(ch)) {
      text = null
      const last = out[out.length - 1]
      if (LINE.includes(ch) && last?.width && last.text[0] === ch && last.x + last.width === x && same(last.cell, cell)) {
        last.text += ch
        last.width++
      } else out.push({ x, text: ch, cell, width: 1 })
    } else if (ch === ' ') {
      // One space keeps a phrase together; a second ends the piece.
      if (text && line[x + 1] && line[x + 1]!.ch !== ' ' && !isGlyph(line[x + 1]!.ch) && same(text.cell, line[x + 1]!)) text.text += ' '
      else text = null
    } else if (text && same(text.cell, cell)) text.text += ch
    else out.push((text = { x, text: ch, cell }))
  }
  return out
}

const range = (lo: number, hi: number) => (hi < lo ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))

const Canvas: ClientModule<CanvasProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = Math.max(20, surface.columns)
  const rows = Math.max(6, props.desktop?.rows ?? surface.rows)
  const leftW = cols >= 120 ? LEFT_W : 0
  const rightW = cols >= 90 ? RIGHT_W : 0
  const local: Local = surface.state ?? {
    pan: { x: -(leftW + 3), y: -2 },
    drag: null,
    held: {},
    lastDown: null,
    edit: null,
    confirmDelete: null,
    menu: false,
    notice: null,
    zoom: 1,
    browse: null,
    // A paste from before this canvas opened isn't for it.
    pasteSeq: props.paste?.seq,
  }
  const zoom = local.zoom ?? 1
  const g = geoAt(zoom)
  const W = g.w
  const M_ROW = modelRowAt(g)
  const rowAt = (n: CanvasNode, port: string) => portRowAt(n, port, g)
  const send = (m: CanvasMessage) => postMessage(b => surface.post(b), m)

  // Running cards blink: one clock for the instance, redrawing only while one runs.
  const anyRunning = props.nodes.some(n => n.status === 'running')
  if (local.ticking !== SENDER) {
    surface.every(BLINK_MS, () => {
      const st = surface.state as Local | undefined
      if (st && (st.blink || isRunningNow)) surface.setState({ ...st, blink: !st.blink })
    })
    // Kept in the state, so a later redraw doesn't start a second clock.
    local.ticking = SENDER
    surface.setState({ ...local })
  }
  isRunningNow = anyRunning
  /** A running card's status dot, as this half of the blink draws it. */
  const pulse = (n: { status: RunStatus }) =>
    n.status === 'running' ? { color: 'yellow', bold: !local.blink, dim: !!local.blink } : { color: STATUS_COLOR[n.status], dim: !STATUS_COLOR[n.status] }

  // Drop overrides the hooks module has caught up with.
  const held = { ...local.held }
  for (const n of props.nodes) {
    const ht = held[n.id]
    if (ht && ht.x === n.x && ht.y === n.y && local.drag?.kind !== 'node') delete held[n.id]
  }
  // Cards keep full-size positions; the view scales them, and everything drawn or clicked is in view cells.
  const worldNodes = props.nodes.map(n => (held[n.id] ? { ...n, ...held[n.id] } : n))
  const nodes = worldNodes.map(n => ({ ...n, x: Math.round(n.x * zoom), y: Math.round(n.y * zoom), ht: heightAt(n, g) }))
  const edges = layoutEdges(nodes, props.edges, g)
  // Every change one event makes accumulates, so a later set() keeps an earlier one.
  let changes: Partial<Local> = {}
  const set = (patch: Partial<Local>) => {
    changes = { ...changes, ...patch }
    surface.setState({ ...local, held, ...changes })
  }

  const selId = props.selected.kind === 'none' ? null : props.selected.id
  const selNode = props.selected.kind === 'node' ? nodes.find(n => n.id === selId) : undefined
  /** The details panel scrolls back to its top for another card or link. */
  const detailTop = local.detailFor === selId ? local.detailTop ?? 0 : 0
  /** Where the details panel was drawn scrolled to, and how far it goes: PgUp / PgDn stay within it. */
  let detailRange: { first: number; last: number } | null = null
  const pageDetails = (dir: 1 | -1) => {
    if (!detailRange) return
    const to = Math.max(0, Math.min(detailRange.last, detailRange.first + dir * Math.max(4, rows - 8)))
    set({ detailTop: to, detailFor: selId })
  }
  const selEdge: CanvasEdge | undefined = props.selected.kind === 'edge' ? props.edges.find(x => x.id === selId) : undefined
  const nameOf = (id: string) => nodes.find(n => n.id === id)?.name ?? '?'
  const openFlow = props.flows.find(f => f.id === props.openFlowId)
  const edit: Edit | null = local.edit
  /** Ctrl+V: the hooks module reads the Mac clipboard and hands it back as `props.paste`. */
  const askPaste = () => send({ t: 'paste' })
  // A paste has arrived (Ctrl+V's, or Cmd+V's caught on its way to the prompt box): into the box being typed in, at its cursor.
  if (props.paste && props.paste.seq !== local.pasteSeq) {
    const text = props.paste.text
    const b = local.browse
    if (props.picker && b && b.folder !== null) {
      const c = insertAt(caretOf({ text: b.folder, pos: b.fPos }), text)
      set({ browse: { ...b, folder: c.text, fPos: c.pos } })
    } else if (props.picker && b) {
      const c = insertAt(caretOf({ text: b.q, pos: b.qPos }), text)
      set({ browse: { ...b, q: c.text, qPos: c.pos, hi: 0, top: 0 } })
    } else if (local.edit) {
      const c = insertAt(caretOf(local.edit), text)
      set({ edit: { ...local.edit, text: c.text, pos: c.pos } })
    } else if (text) set({ notice: 'Click a text box to paste into it.' })
    set({ pasteSeq: props.paste.seq })
  }

  /** World point at the middle of the open canvas area, between the side panels. */
  const midX = Math.floor((leftW + cols - rightW) / 2)
  const viewCentre = () => ({ x: local.pan.x + midX - W / 2, y: local.pan.y + Math.floor(rows / 2) - 3 })
  /** Where a new card goes: the view's middle, in full-size positions. */
  const centre = () => {
    const c = viewCentre()
    return { x: Math.round(c.x / zoom), y: Math.round(c.y / zoom) }
  }
  /** Zooms about the middle of the view, so what's there stays there. */
  const zoomTo = (z: number) => {
    const cx = (local.pan.x + midX) / zoom
    const cy = (local.pan.y + Math.floor(rows / 2)) / zoom
    set({ zoom: z, pan: { x: Math.round(cx * z - midX), y: Math.round(cy * z - Math.floor(rows / 2)) } })
  }
  const zoomStep = (dir: 1 | -1) => {
    const next = ZOOMS[ZOOMS.indexOf(zoom) + dir]
    if (next !== undefined) zoomTo(next)
  }
  const focusOn = (n: CanvasNode) =>
    set({ pan: { x: n.x + W / 2 - midX, y: n.y + Math.floor(n.ht / 2) - Math.floor(rows / 2) }, edit: null })

  /** Run flow: with one Start card, its command opens to edit first; otherwise the hooks run (or add) Start cards. */
  function runFlowNow() {
    if (!props.openFlowId) return
    const starts = nodes.filter(n => n.kind === 'start')
    const start = starts[0]
    // A command being typed in the Start card's box, not yet saved, is the one to run.
    const typed = edit && edit.id === start?.id && (edit.kind === 'prompt' || edit.field === 'prompt') ? edit.text : undefined
    if (start && starts.length === 1) set({ edit: { kind: 'run', id: start.id, text: typed ?? start.prompt }, menu: false })
    else send({ t: 'flow-run', id: props.openFlowId })
  }
  function submitRun() {
    if (edit?.kind === 'test') send({ t: 'run', id: edit.id, prompt: edit.text })
    else if (edit?.kind === 'run' && props.openFlowId) send({ t: 'flow-run', id: props.openFlowId, command: edit.text, startId: edit.id })
    else return
    set({ edit: null })
  }
  /** A text box's typing, kept: on Enter, or a click anywhere else. Run and Test boxes send only on ▶ Run. */
  function saveEdit(e: Edit) {
    if (e.kind === 'run' || e.kind === 'test') return
    if (e.kind === 'flow-name') send({ t: 'flow-patch', id: e.id, patch: { name: e.text } })
    else if (e.kind === 'card' && e.field) {
      const value = e.field === 'branches' ? e.text.split(',').map(b => b.trim()).filter(Boolean) : e.text
      send({ t: 'card', id: e.id, patch: { [e.field]: value } })
    } else if (e.kind !== 'card') send({ t: 'node', id: e.id, patch: { [e.kind]: e.text } })
  }
  /** ▶ Run on one agent: a test message to edit first, the last one filled in. */
  const testAgent = (n: CanvasNode) => set({ edit: { kind: 'test', id: n.id, text: n.prompt }, menu: false })

  const cardAt = (x: number, y: number) => [...nodes].reverse().find(n => x >= n.x && x < n.x + W && y >= n.y && y < n.y + n.ht)
  /** A card's output dot under a point: a named output's label, or a single output's dot on the right edge. */
  const portAt = (n: CanvasNode, x: number, y: number) =>
    n.ports.length > 1
      ? x >= n.x + W - Math.min(12, W - 2) ? n.ports.find(p => n.y + rowAt(n, p) === y) : undefined
      : n.ports.length === 1 && x >= n.x + W - 2 && y === n.y + rowAt(n, n.ports[0]!) ? n.ports[0] : undefined
  /** A card's input dot under a point, on the left edge. */
  const isInputAt = (n: CanvasNode, x: number, y: number) => canLinkTo(n) && x <= n.x + 1 && y === n.y + inRowAt(n, g)
  /** An agent's model dot under a point, on the left edge under its input. */
  const isModelInputAt = (n: CanvasNode, x: number, y: number) => n.kind === 'agent' && x <= n.x + 1 && y === n.y + M_ROW
  /**
   * Where a dragged link would land: the card, and for a drag back from an input,
   * the output it would leave by; or why it can't (an output on an output, an input
   * on an input, a card with no input or output, the card itself).
   */
  type Drop = { target?: CanvasNode; port?: string; why?: string }
  const judgeDrop = (d: Extract<Drag, { kind: 'link' | 'rewire' }>, x: number, y: number): Drop => {
    const t = cardAt(x, y)
    if (!t) return {}
    if (t.id === d.from) return { why: "A card can't link to itself" }
    const dir = d.kind === 'rewire' ? 'out' : d.dir
    const fromModel = nodes.find(n => n.id === d.from)?.kind === 'model'
    if (dir === 'out') {
      if (portAt(t, x, y)) return { why: 'Outputs link to inputs' }
      if (fromModel && t.kind !== 'agent') return { why: 'Only agents take a model' }
      if (!fromModel && isModelInputAt(t, x, y)) return { why: 'Only a Model card links here' }
      if (!canLinkTo(t)) return { why: `${t.name} takes no input` }
      if (d.kind === 'rewire' && t.id === d.to) return {}
      return { target: t }
    }
    if (isInputAt(t, x, y) || isModelInputAt(t, x, y)) return { why: 'Inputs link to outputs' }
    if (d.kind === 'link' && d.toModel && t.kind !== 'model') return { why: 'Only a Model card links here' }
    if (!canLinkFrom(t)) return { why: `${t.name} has no output` }
    return { target: t, port: portAt(t, x, y) ?? t.ports[0] }
  }
  /** While a link is dragged: the card it would land on, if it can take it. */
  const dragging = local.drag && (local.drag.kind === 'link' || local.drag.kind === 'rewire') ? local.drag : null
  const drop: Drop = dragging?.moved ? judgeDrop(dragging, dragging.x, dragging.y) : {}
  const dropTarget = drop.target

  // ---------- painting ----------
  const grid: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ' })))
  const masks: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))
  const lineColor: string[][] = Array.from({ length: rows }, () => Array(cols).fill(''))
  const putS = (x: number, y: number, cell: Cell) => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y]![x] = cell
  }
  const put = (wx: number, wy: number, cell: Cell) => putS(wx - local.pan.x, wy - local.pan.y, cell)
  const text = (wx: number, wy: number, s: string, style: Omit<Cell, 'ch'> = {}) =>
    [...s].forEach((ch, i) => put(wx + i, wy, { ch, ...style }))
  /** A band's edge across a card: ├────┤ in its border colour (the left side dashed, for a Note). */
  const divider = (n: CanvasNode, dy: number, color: string, vt: string) => {
    const W2 = geoAt(local.zoom ?? 1).w
    put(n.x, n.y + dy, { ch: vt === '┆' ? '┆' : vt === '┃' ? '┣' : '├', color })
    for (let dx = 1; dx < W2 - 1; dx++) put(n.x + dx, n.y + dy, { ch: vt === '┃' ? '━' : '─', color })
    put(n.x + W2 - 1, n.y + dy, { ch: vt === '┆' ? '┆' : vt === '┃' ? '┫' : '┤', color })
  }
  /**
   * The sockets row's words beside its dots: `in` at the left, faintly followed by
   * the card it hears from (and how many more), and `out` at the right.
   */
  const socketLabels = (n: CanvasNode, dy: number, hasIn: boolean, hasOut: boolean) => {
    const W2 = geoAt(local.zoom ?? 1).w
    if (hasIn) {
      text(n.x + 2, n.y + dy, 'in', { dim: true })
      const from = [...new Set(props.edges.filter(e => e.to === n.id && !e.isModel).map(e => e.fromName))]
      if (from.length) {
        const more = from.length > 1 ? ` +${from.length - 1}` : ''
        const room = W2 - 4 - 3 - (hasOut ? 5 : 0) - more.length
        text(n.x + 4, n.y + dy, ` ← ${clipMid(from[0]!, room - 1)}${more}`, { color: 'gray', dim: true })
      }
    }
    if (hasOut) text(n.x + W2 - 5, n.y + dy, 'out', { dim: true })
  }
  const mark = (wx: number, wy: number, bits: number, color: string) => {
    const x = wx - local.pan.x
    const y = wy - local.pan.y
    if (y >= 0 && y < rows && x >= 0 && x < cols) {
      masks[y]![x]! |= bits
      lineColor[y]![x] = color
    }
  }

  const panels: Panel[] = []
  /** Draws a bordered panel in screen cells and records what each clickable piece does. */
  const drawPanel = (
    x: number, y: number, w: number, title: string, body: Row[],
    opts: { ht?: number; color?: string; footer?: Row[]; scroll?: { top: number; to: (top: number) => void } } = {},
  ) => {
    const color = opts.color ?? 'gray'
    const ht = opts.ht ?? body.length + (opts.footer?.length ?? 0) + 2
    const hits: Hit[] = []
    const t = clip(` ${title} `, w - 4)
    const top = '╭─' + t + '─'.repeat(Math.max(0, w - 3 - t.length)) + '╮'
    ;[...top].forEach((ch, i) => putS(x + i, y, { ch, color: i > 1 && i < t.length + 2 ? undefined : color, bold: i > 1 && i < t.length + 2 }))
    let footer = opts.footer ?? []
    let shown = body
    let scrolled: { first: number; last: number } | null = null
    // Taller than the panel: a page of it, and ▲ ▼ above the footer to move through it.
    const room = ht - 2 - footer.length
    if (opts.scroll && body.length > room) {
      const page = room - 1
      const first = Math.max(0, Math.min(opts.scroll.top, body.length - page))
      const to = opts.scroll.to
      shown = body.slice(first, first + page)
      scrolled = { first, last: body.length - page }
      footer = [{
        segs: [
          { text: '▲', bold: true, color: first > 0 ? 'cyan' : undefined, dim: first === 0, act: () => to(Math.max(0, first - page + 2)) },
          gap(2),
          { text: '▼', bold: true, color: first + page < body.length ? 'cyan' : undefined, dim: first + page >= body.length, act: () => to(Math.min(body.length - page, first + page - 2)) },
          { text: `  ${first + 1}–${Math.min(body.length, first + page)} of ${body.length} · PgUp PgDn`, dim: true },
        ],
      }, ...footer]
    }
    const lines: (Row | undefined)[] = [...shown.slice(0, ht - 2 - footer.length)]
    while (lines.length < ht - 2 - footer.length) lines.push(undefined)
    lines.push(...footer)
    lines.forEach((r, i) => {
      const yy = y + 1 + i
      putS(x, yy, { ch: '│', color })
      putS(x + w - 1, yy, { ch: '│', color })
      for (let j = x + 1; j < x + w - 1; j++) putS(j, yy, { ch: ' ' })
      if (!r) return
      let cx = x + 2
      const end = x + w - 2 - (r.right ? r.right.text.length + 1 : 0)
      for (const seg of r.segs) {
        const s = clip(seg.text, end - cx)
        const start = cx
        for (const ch of s) putS(cx++, yy, { ch, color: seg.color ?? r.color, bold: seg.bold ?? r.bold, dim: seg.dim ?? r.dim })
        if (seg.act && s) hits.push({ x1: start, x2: cx - 1, y: yy, act: seg.act })
      }
      if (r.right) {
        const rx = x + w - 2 - r.right.text.length
        for (const [j, ch] of [...r.right.text].entries()) putS(rx + j, yy, { ch, color: r.right.color, dim: r.right.dim, bold: r.right.bold })
        if (r.right.act) hits.push({ x1: rx, x2: rx + r.right.text.length - 1, y: yy, act: r.right.act })
      }
      if (r.act) hits.push({ x1: x + 1, x2: x + w - 2, y: yy, act: r.act })
    })
    const bottom = '╰' + '─'.repeat(w - 2) + '╯'
    ;[...bottom].forEach((ch, i) => putS(x + i, y + ht - 1, { ch, color }))
    panels.push({ x, y, w, ht, hits })
    return scrolled
  }

  // Lines first, then cards, then labels on the lines.
  const isModelEdge = new Set(props.edges.filter(e => e.isModel).map(e => e.id))
  const edgeColor = (id: string) => (selEdge?.id === id ? 'cyan' : isModelEdge.has(id) ? 'blue' : 'gray')
  for (const edge of edges) {
    const color = edgeColor(edge.id)
    for (let i = 0; i + 1 < edge.points.length; i++) {
      const [x1, y1] = edge.points[i]!
      const [x2, y2] = edge.points[i + 1]!
      if (y1 === y2) {
        const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1]
        for (let x = lo; x <= hi; x++) mark(x, y1, (x > lo ? L : 0) | (x < hi ? R : 0), color)
      } else {
        const [lo, hi] = y1 < y2 ? [y1, y2] : [y2, y1]
        for (let y = lo; y <= hi; y++) mark(x1, y, (y > lo ? U : 0) | (y < hi ? D : 0), color)
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const m = masks[y]![x]!
      if (m) grid[y]![x] = { ch: JOIN[m] ?? '┼', color: lineColor[y]![x] || 'gray' }
    }
  }
  for (const edge of edges) {
    const [ax, ay, glyph] = edge.arrow
    put(ax, ay, { ch: glyph, color: edgeColor(edge.id) })
  }

  const inner = W - 4
  for (const n of nodes) {
    const isSel = selNode?.id === n.id
    const isSource = props.connectFrom === n.id
    const m = metaOf(n.kind)
    const isAgent = n.kind === 'agent'
    const H = n.ht
    const isDropTarget = dropTarget?.id === n.id
    const border = isDropTarget || isSource ? 'magenta' : isSel ? 'cyan' : isAgent ? STATUS_COLOR[n.status] ?? 'gray' : n.kind === 'note' ? 'gray' : m.color
    const [tl, tr, bl, br, hz, vt] = isSel || isSource || isDropTarget
      ? ['┏', '┓', '┗', '┛', '━', '┃']
      : n.kind === 'note' ? ['┌', '┐', '└', '┘', '┄', '┆'] : ['╭', '╮', '╰', '╯', '─', '│']
    // Frame.
    put(n.x, n.y, { ch: tl, color: border })
    put(n.x + W - 1, n.y, { ch: tr, color: border })
    put(n.x, n.y + H - 1, { ch: bl, color: border })
    put(n.x + W - 1, n.y + H - 1, { ch: br, color: border })
    for (let dx = 1; dx < W - 1; dx++) {
      put(n.x + dx, n.y, { ch: hz, color: border })
      put(n.x + dx, n.y + H - 1, { ch: hz, color: border })
    }
    for (let dy = 1; dy < H - 1; dy++) {
      put(n.x, n.y + dy, { ch: vt, color: border })
      put(n.x + W - 1, n.y + dy, { ch: vt, color: border })
      for (let dx = 1; dx < W - 1; dx++) put(n.x + dx, n.y + dy, { ch: ' ' })
    }
    if (g.isCompact) {
      // Zoomed out: the name, then the status, a summary, or the named outputs.
      if (isAgent) {
        const mark = n.status === 'running' ? 2 : n.isOpen ? 2 : 0
        text(n.x + 2, n.y + 1, clipMid(n.name, inner - mark), { bold: true })
        if (n.status === 'running') text(n.x + W - 3, n.y + 1, '●', pulse(n))
        else if (n.isOpen) text(n.x + W - 3, n.y + 1, '⧉', { color: 'green' })
        text(n.x + 2, n.y + 2, clip(`${STATUS_ICON[n.status]} ${statusWord(n)}`, inner), pulse(n))
      } else {
        text(n.x + 2, n.y + 1, clip(`${m.icon} ${clipMid(n.name, inner - 2)}`, inner), { bold: true })
        if (n.ports.length > 1) {
          n.ports.forEach(port => {
            const label = `${clip(portLabel(port), inner - 2)} ●`
            const isPicked = isSource && props.connectPort === port
            text(n.x + W - 2 - label.length, n.y + rowAt(n, port), label, { color: isPicked ? 'magenta' : m.color, bold: isPicked })
          })
        } else text(n.x + 2, n.y + 2, clip(n.kind === 'note' ? n.card.text || 'Write a note' : n.summary, inner), { dim: true })
      }
    } else if (isAgent) {
      // Title: the name (two lines when long), a blinking dot at its right while it
      // runs (else the open-in-a-tab mark).
      wrapName(n.name, inner - 2).forEach((l, i) => text(n.x + 2, n.y + 1 + i, l, { bold: true }))
      if (n.status === 'running') text(n.x + W - 3, n.y + 1, '●', pulse(n))
      else if (n.isOpen) text(n.x + W - 3, n.y + 1, '⧉', { color: 'green' })
      divider(n, 3, border, vt)
      // Sockets: messages in and out, then the model it runs on.
      socketLabels(n, SOCKET_ROW.agent, true, true)
      text(n.x + 2, n.y + MODEL_ROW, 'model', { dim: true })
      text(n.x + 9, n.y + MODEL_ROW, clip(n.model ?? 'your default', inner - 7), n.model ? { color: 'blue' } : { dim: true })
      divider(n, 6, border, vt)
      // Status, then the way to its work: the chat view, live while it runs.
      text(n.x + 2, n.y + 7, `${STATUS_ICON[n.status]} ${statusWord(n)}`, pulse(n))
      const cta = agentCta(n)
      text(n.x + 2, n.y + 8, clip(cta.text, inner), cta.style)
    } else {
      // Title, then the sockets row, then the body; named outputs get their own band.
      text(n.x + 2, n.y + 1, `${m.icon} `, { color: m.color, bold: true })
      text(n.x + 4, n.y + 1, clipMid(n.name, inner - 2), { bold: true })
      divider(n, 2, border, vt)
      if (n.kind === 'note') {
        wrap(n.card.text || 'Write a note', inner, H - 4).forEach((l, i) => text(n.x + 2, n.y + 3 + i, l, { dim: !n.card.text }))
      } else {
        socketLabels(n, SOCKET_ROW.other, canLinkTo(n), n.ports.length === 1)
        const extra = (n.kind === 'all' && n.waiting) || (n.kind === 'end' && n.result)
        wrap(n.summary, inner, extra ? 1 : 2).forEach((l, i) => text(n.x + 2, n.y + 4 + i, l, { dim: true }))
        if (n.kind === 'all' && n.waiting) {
          text(n.x + 2, n.y + 5, `waiting ${n.waiting.got} of ${n.waiting.of}`, { color: 'yellow' })
        } else if (n.kind === 'end' && n.result) {
          text(n.x + 2, n.y + 5, `✓ ${clip(oneLine(plain(n.result.text)), inner - 2)}`, { color: 'green' })
        }
        if (n.ports.length > 1) {
          divider(n, 6, border, vt)
          // Each output: its name and a dot on the right edge, where its links leave.
          n.ports.forEach(port => {
            const label = `${clip(portLabel(port), inner - 2)} ●`
            const isPicked = isSource && props.connectPort === port
            text(n.x + W - 2 - label.length, n.y + rowAt(n, port), label, { color: isPicked ? 'magenta' : m.color, bold: isPicked })
          })
        }
      }
    }
    // A single output's dot sits on the right edge, where its links leave: drag it to link.
    if (n.ports.length === 1) put(n.x + W - 1, n.y + rowAt(n, n.ports[0]!), { ch: '●', color: isSource ? 'magenta' : m.color === 'white' ? 'cyan' : m.color, bold: true })
    // The input dot on the left edge: filled once something links in.
    if (canLinkTo(n)) {
      const hasIn = props.edges.some(e => e.to === n.id && !e.isModel)
      put(n.x, n.y + inRowAt(n, g), { ch: hasIn ? '◉' : '○', color: isDropTarget ? 'magenta' : m.color === 'white' ? 'cyan' : m.color, bold: true })
    }
    // An agent's model dot, under its input: filled once a Model card links in.
    if (isAgent) put(n.x, n.y + M_ROW, { ch: n.model ? '◉' : '○', color: 'blue', bold: true })
    // A wiring problem, on the bottom edge.
    if (n.warning) text(n.x + 2, n.y + H - 1, clip(` ⚠ ${n.warning} `, W - 4), { color: 'yellow' })
  }

  // The selected agent's activity drawer, hung under its card and wider than it:
  // its thinking while it works, the prompt it's on, and its newest lines, wrapped.
  let drawer: { x: number; y: number; w: number; ht: number; chatRow: number } | null = null
  const opened = selNode?.kind === 'agent' && !g.isCompact ? nodes.find(n => n.id === selNode.id) : undefined
  if (opened && (opened.preview.length || opened.thinking)) {
    const n = opened
    const w = Math.max(W, Math.min(DRAWER_W, cols - leftW - rightW - 4))
    const inner = w - 4
    const prompt = n.preview.find(p => p.startsWith('▸'))
    const thinking = n.status === 'running' && n.thinking?.trim() ? wrapTail(plain(n.thinking), inner - 2, 3) : []
    const head: { text: string; style: Omit<Cell, 'ch'> }[] = [
      ...(prompt ? wrap(plain(prompt), inner, 2).map(t => ({ text: t, style: { color: 'cyan' } })) : []),
      ...thinking.map(t => ({ text: `∴ ${t}`, style: { dim: true } })),
    ]
    const tail = activityTail(n.preview, inner, Math.max(3, DRAWER_ROWS - head.length))
    const body = [...head, ...tail.map(t => ({ text: t, style: t.startsWith('⚙') ? { color: 'blue' } : {} }))]
    const ht = body.length + 3
    const x = n.x
    const y = n.y + n.ht - 1
    const color = 'cyan'
    // Joined to the card: its bottom edge becomes the drawer's top.
    put(x, y, { ch: '┣', color })
    for (let dx = 1; dx < w - 1; dx++) put(x + dx, y, { ch: dx < W - 1 ? '━' : '─', color })
    put(x + W - 1, y, { ch: w > W ? '┻' : '┫', color })
    put(x + w - 1, y, { ch: w > W ? '╮' : '┫', color })
    for (let dy = 1; dy < ht - 1; dy++) {
      put(x, y + dy, { ch: '┃', color })
      put(x + w - 1, y + dy, { ch: '│', color })
      for (let dx = 1; dx < w - 1; dx++) put(x + dx, y + dy, { ch: ' ' })
    }
    put(x, y + ht - 1, { ch: '┗', color })
    for (let dx = 1; dx < w - 1; dx++) put(x + dx, y + ht - 1, { ch: '─', color })
    put(x + w - 1, y + ht - 1, { ch: '╯', color })
    body.forEach((l, i) => text(x + 2, y + 1 + i, clip(l.text, inner), l.style))
    const hint = 'View chat (v) for all of it ›'
    text(x + 2, y + ht - 2, hint, { color: 'cyan', dim: true })
    drawer = { x, y, w, ht, chatRow: y + ht - 2 }
  }

  // The link being dragged: from its dot to the pointer, across then down.
  if (dragging?.moved) {
    const { sx, sy, x, y } = dragging
    const color = dropTarget ? 'magenta' : drop.why ? 'yellow' : 'gray'
    const [lo, hi] = sx < x ? [sx, x] : [x, sx]
    for (let cx = lo; cx <= hi; cx++) put(cx, sy, { ch: '┄', color, bold: true })
    const [ylo, yhi] = sy < y ? [sy, y] : [y, sy]
    for (let cy = ylo; cy <= yhi; cy++) put(x, cy, { ch: cy === sy ? (y > sy ? '╮' : y < sy ? '╯' : '┄') : '┆', color, bold: true })
    put(x, y, { ch: dropTarget ? '◉' : drop.why ? '⚠' : '○', color, bold: true })
    if (drop.why) text(x + 2, y, ` ${drop.why} `, { color: 'yellow', bold: true })
  }
  // Why the last drop made no link.
  if (local.notice && !dragging) {
    const line = `⚠ ${local.notice}`
    ;[...line].forEach((ch, i) => putS(Math.floor((leftW + cols - rightW - line.length) / 2) + i, rows - 1, { ch, color: 'yellow', bold: true }))
  }

  for (const edge of edges) {
    const isSel = selEdge?.id === edge.id
    text(edge.lx, edge.ly, edge.label, { color: isSel ? 'cyan' : 'magenta', bold: true })
  }

  if (props.nodes.length === 0) {
    const c = viewCentre()
    const lines = props.openFlowId
      ? ['This flow is empty', '', 'Press n to add a card: a Start,', 'agents, and If / Switch / And / End']
      : ['No flows in this project yet', '', 'Click [ + New flow ] on the left', 'or press n to start one']
    lines.forEach((l, i) => text(c.x + W / 2 - Math.floor(l.length / 2), c.y + i, l, { dim: i > 0, bold: i === 0 }))
  }

  // ---------- zoom (bottom left of the canvas) ----------
  {
    const segs: Seg[] = [
      { ...button('−', () => zoomStep(-1), zoom > ZOOMS[0]! ? 'cyan' : 'gray'), dim: zoom <= ZOOMS[0]! },
      { text: ` ${Math.round(zoom * 100)}% `.padStart(6), bold: true, act: () => zoomTo(1) },
      { ...button('+', () => zoomStep(1), zoom < 1 ? 'cyan' : 'gray'), dim: zoom >= 1 },
    ]
    const x = leftW + 1
    const y = rows - 1
    const hits: Hit[] = []
    let cx = x
    for (const seg of segs) {
      for (const ch of seg.text) putS(cx++, y, { ch, color: seg.color, bold: seg.bold, dim: seg.dim })
      if (seg.act) hits.push({ x1: cx - seg.text.length, x2: cx - 1, y, act: seg.act })
    }
    panels.push({ x, y, w: cx - x, ht: 1, hits })
  }

  // ---------- details panel (right) ----------
  const panelInner = RIGHT_W - 4
  /** A dim hint for the details panel, wrapped rather than cut. */
  const note = (text: string): Row[] => wrap(text, panelInner, 3).map(l => row(l, { dim: true }))
  /**
   * Buttons two to a row, each the same width, so their brackets line up down the
   * panel. Symbols that some fonts draw two cells wide (⧉ ☰) are kept out of labels.
   */
  const buttonGrid = (items: GridButton[]): Row[] => {
    const w = Math.floor((panelInner - 2) / 2)
    const cell = ([label, act, color]: GridButton): Seg => ({ text: `[ ${clip(label, w - 4).padEnd(w - 4)} ]`, act, color, bold: true })
    const out: Row[] = []
    for (let i = 0; i < items.length; i += 2) {
      out.push({ segs: [cell(items[i]!), ...(items[i + 1] ? [gap(2), cell(items[i + 1]!)] : [])] })
    }
    return out
  }
  /** The layout of the multi-line box being typed in, for up and down. */
  let activeLines: Line[] | undefined
  /**
   * A text box being typed in, as rows: scrolled to keep the cursor in view and
   * drawn with it; a click on a row puts the cursor there.
   */
  const boxRows = (c: Caret, width: number, lines: number, place: (pos: number) => void, color = 'yellow'): Row[] => {
    if (lines <= 1) {
      const w = Math.max(2, width - 1)
      const start = c.pos < w ? 0 : c.pos - w + 1
      const line = { start, text: c.text.slice(start, start + w) }
      const col = c.pos - start
      const shown = line.text.slice(0, col) + CARET + line.text.slice(col)
      return [{ segs: [{ text: start > 0 ? '…' + shown.slice(1) : shown, color, act: dx => place(posIn(line, dx, col)) }] }]
    }
    const all = layoutText(c.text, width - 1)
    activeLines = all
    const ci = lineAt(all, c.pos)
    const first = Math.max(0, ci - lines + 1)
    return all.slice(first, first + lines).map((line, j) => {
      const col = first + j === ci ? c.pos - line.start : null
      const shown = col === null ? line.text : line.text.slice(0, col) + CARET + line.text.slice(col)
      return { segs: [{ text: shown || ' ', color, act: dx => place(posIn(line, dx, col)) }] }
    })
  }
  /** A box's text when it isn't being typed in: click a spot to start typing there. */
  const valueRows = (value: string, width: number, lines: number, begin?: (pos: number) => void): Row[] => {
    if (lines <= 1) return [{ segs: [{ text: clip(value, width), act: begin && (dx => begin(Math.min(dx, value.length))) }] }]
    const all = layoutText(value, width)
    return all.slice(0, lines).map((line, j) => ({
      segs: [{ text: j === lines - 1 && all.length > lines ? clip(line.text + ' …', width) : line.text, act: begin && (dx => begin(posIn(line, dx, null))) }],
    }))
  }
  const field = (
    label: string, value: string, kind: Edit['kind'] | null, id: string, placeholder: string, lines = 1, cardField?: string,
  ): Row[] => {
    const typing = edit && edit.kind === kind && edit.id === id && edit.field === cardField ? edit : null
    const begin = kind ? (pos: number) => set({ edit: { kind, id, text: value, pos, ...(cardField ? { field: cardField } : {}) } }) : undefined
    const out: Row[] = [heading(label)]
    if (typing) {
      out.push(...boxRows(caretOf(typing), panelInner, lines, pos => set({ edit: { ...typing, pos } })))
      out.push(row(typing.text !== value ? 'Enter or click away to save' : '← → move · click to place · Cmd+V paste', { dim: true }))
    } else if (!value) {
      wrap(placeholder, panelInner, lines).forEach(l => out.push({ segs: [{ text: l, dim: true, act: begin && (() => begin(0)) }] }))
    } else out.push(...valueRows(value, panelInner, lines, begin))
    return out
  }

  let details: { title: string; body: Row[]; footer: Row[]; color?: string } | null = null
  if (props.connectFrom) {
    details = {
      title: 'Link',
      color: 'magenta',
      body: [
        blank(),
        row(`From  ${nameOf(props.connectFrom)}`, { bold: true }),
        blank(),
        row('Click the agent it should hand', { dim: true }),
        row('off to. Links are one-way; the', { dim: true }),
        row('other agent can reply.', { dim: true }),
      ],
      footer: [{ segs: [button('Cancel', () => send({ t: 'cancel' }), 'gray')] }],
    }
  } else if (selNode && selNode.kind !== 'agent') {
    const n = selNode
    const c = n.card
    const cardField = (label: string, key: string, value: string, placeholder: string, lines = 1) =>
      field(label, value, 'card', n.id, placeholder, lines, key)
    const linkOf = (port: string) => props.edges.filter(e => e.from === n.id && e.port === port)
    const outputs: Row[] = n.ports.length === 0 ? [] : [
      blank(),
      heading(n.ports.length > 1 ? 'OUTPUTS' : n.kind === 'model' ? 'SETS THE MODEL OF' : 'PASSES TO'),
      ...n.ports.flatMap(port => {
        const to = linkOf(port)
        return [{
          segs: [
            ...(n.ports.length > 1 ? [{ text: `${clip(portLabel(port), 10).padEnd(10)} `, bold: true, color: metaOf(n.kind).color }] : []),
            { text: to.length ? clip(to.map(e => nameOf(e.to)).join(', '), panelInner - 22) : 'nothing yet', dim: !to.length },
          ],
          right: { text: '→ Link', color: 'magenta', bold: true },
          act: () => send({ t: 'connect-start', id: n.id, port }),
        } as Row]
      }),
    ]
    const checkRows = (): Row[] => {
      const check = c.check ?? 'judge'
      return [
        heading('PASSES WHEN'),
        ...CHECKS.map(o => row(`${check === o.check ? '◉' : '○'} ${o.label}`, {
          color: check === o.check ? 'cyan' : undefined,
          bold: check === o.check,
          act: () => { send({ t: 'card', id: n.id, patch: { check: o.check } }); set({ edit: null }) },
        })),
        blank(),
        ...cardField(valueLabel(check), 'value', c.value ?? '', valueHint(check), 3),
      ]
    }
    /** Effort first, so the list of models below can run long without hiding it. */
    function modelRows(n: CanvasNode): Row[] {
      const pick = (patch: { model?: string; effort?: Effort | '' }) => {
        send({ t: 'card', id: n.id, patch })
        set({ edit: null })
      }
      const choice = (on: boolean, label: string, act: () => void): Seg =>
        ({ text: `${on ? '◉' : '○'} ${label}`, color: on ? 'cyan' : undefined, bold: on, act })
      const effortRow = (list: typeof EFFORTS): Row => ({
        segs: list.flatMap((o, i) => [...(i ? [gap(2)] : []), choice((c.effort ?? '') === o.effort, o.label, () => pick({ effort: o.effort }))]),
      })
      const models = props.models
      const ids = models?.ids ?? []
      // A model the list lacks (set by hand, or by an older list) stays shown and picked.
      const shown = c.model && !ids.includes(c.model) ? [c.model, ...ids] : ids
      return [
        heading('EFFORT'),
        effortRow(EFFORTS.slice(0, 3)),
        effortRow(EFFORTS.slice(3)),
        blank(),
        { ...heading('MODEL'), right: { text: '↻ Refresh', color: 'cyan', bold: true, act: () => send({ t: 'models', refresh: true }) } },
        ...(!models || (models.loading && ids.length === 0) ? [row("Loading…", { dim: true })] : []),
        ...(models?.note ? wrap(models.note, panelInner, 3).map(l => row(l, { color: 'yellow' })) : []),
        ...shown.map(id => ({ segs: [choice(c.model === id, shortModel(id), () => pick({ model: id }))] })),
      ]
    }
    const specific: Row[] =
      n.kind === 'start' ? [
        ...field('COMMAND', n.prompt, 'card', n.id, 'What the run begins with, e.g. "List all countries"', 4, 'prompt'),
        blank(),
        { segs: [button('▶ Run flow', () => runFlowNow(), 'green')] },
        ...note('Sends the command to what this links to.'),
      ]
      : n.kind === 'if' ? [...checkRows(), blank(), ...note('Yes or No: where the message goes next.')]
      : n.kind === 'loop' ? [
        ...checkRows(),
        blank(),
        heading('MAX TRIES'),
        {
          segs: [
            button('-', () => send({ t: 'card', id: n.id, patch: { maxTries: (c.maxTries ?? 3) - 1 } }), 'gray'),
            { text: ` ${c.maxTries ?? 3} `, bold: true },
            button('+', () => send({ t: 'card', id: n.id, patch: { maxTries: (c.maxTries ?? 3) + 1 } }), 'gray'),
            { text: '  then Done anyway', dim: true },
          ],
        },
        ...note('Again: link back to the agent to retry.'),
      ]
      : n.kind === 'switch' ? [
        ...field('BRANCHES (comma-separated)', (c.branches ?? []).join(', '), 'card', n.id, 'e.g. bug, feature, question', 2, 'branches'),
        ...note('Claude picks one; none fits → Other.'),
      ]
      : n.kind === 'prompt' ? [
        ...cardField('PROMPT', 'template', c.template ?? '', 'e.g. Summarise this for a designer', 5),
        ...note('What came in goes under your text, or where you write {{message}}. {{from}}: who sent it.'),
      ]
      : n.kind === 'all' ? [
        ...note('Waits until every card linking in has replied in this run, then passes their answers on together.'),
        blank(),
        heading('INPUTS'),
        ...[...new Set(props.edges.filter(e => e.to === n.id).map(e => e.from))].map(id => row(`← ${clip(nameOf(id), panelInner - 2)}`)),
        ...(n.waiting ? [blank(), row(`Waiting: ${n.waiting.got} of ${n.waiting.of} in`, { color: 'yellow' }), { segs: [button('Pass on now', () => send({ t: 'all-flush', id: n.id }), 'yellow')] }] : []),
      ]
      : n.kind === 'first' ? [
        ...note('Passes on the first reply to arrive in a run; later ones are dropped.'),
      ]
      : n.kind === 'end' ? [
        ...cardField('SAVE TO (optional)', 'saveTo', c.saveTo ?? '', 'e.g. results/countries.md', 1),
        row('A path in this project.', { dim: true }),
        blank(),
        heading('LATEST ANSWER'),
        ...(n.result ? wrap(n.result.text, panelInner, 8).map(l => row(l, { color: 'green' })) : [row('No run has finished here yet.', { dim: true })]),
      ]
      : n.kind === 'model' ? modelRows(n)
      : /* note */ [...cardField('NOTE', 'text', c.text ?? '', 'Explain this flow to your team', 8)]
    details = {
      title: `${metaOf(n.kind).icon} ${n.name}`,
      color: 'cyan',
      body: [
        ...(n.warning ? [row(`⚠ ${n.warning}`, { color: 'yellow' }), blank()] : []),
        ...field('NAME', n.name, 'name', n.id, ''),
        blank(),
        ...specific,
        ...outputs,
      ],
      footer: [{ segs: [button('✕ Delete', () => send({ t: 'delete' }), 'red')] }],
    }
  } else if (selNode) {
    const n = selNode
    const out = props.edges.filter(e => e.from === n.id)
    const inc = props.edges.filter(e => e.to === n.id && e.from !== n.id)
    const body: Row[] = [
      row(`${STATUS_ICON[n.status]} ${statusWord(n)}`, {
        ...pulse(n),
        right: { text: n.isOpen ? '⧉ open in a tab' : n.hasSession ? 'not open' : 'new', dim: !n.isOpen, color: n.isOpen ? 'green' : undefined },
      }),
      blank(),
      ...buttonGrid([
        ['▶ Test', () => testAgent(n), 'green'],
        ['View chat', () => send({ t: 'chat', id: n.id }), 'cyan'],
        ['Open in tab', () => send({ t: 'open', id: n.id }), 'cyan'],
        ['→ Link to…', () => send({ t: 'connect-start', id: n.id }), 'magenta'],
        ...(n.status === 'running' ? [['■ Stop', () => send({ t: 'stop', id: n.id }), 'yellow'] as GridButton] : []),
      ]),
      blank(),
      ...field('NAME', n.name, 'name', n.id, ''),
      blank(),
      ...field('INSTRUCTIONS', n.instructions, 'instructions', n.id, 'Its role, e.g. "You review lists. Reply APPROVED or list the problems."', 5),
      ...note('Sent ahead of every message it gets. A line like @CLAUDE.md adds that file.'),
      blank(),
      heading('PERMISSIONS'),
      {
        segs: MODES.flatMap((m, i) => [
          ...(i ? [gap(2)] : []),
          {
            text: `${n.mode === m.mode ? '◉' : '○'} ${m.label}`,
            color: n.mode === m.mode ? 'cyan' : undefined,
            bold: n.mode === m.mode,
            act: () => send({ t: 'node', id: n.id, patch: { mode: m.mode } }),
          },
        ]),
      },
      blank(),
      heading('MODEL'),
      row(n.model ? `◈ ${n.model}` : 'Your default model', { color: n.model ? 'blue' : undefined, dim: !n.model }),
      ...note(!n.model ? 'Link a Model card to its lower dot.' : n.isOpen ? 'Open in a tab: used from its next message.' : 'Used on its next run or open.'),
      blank(),
      heading('LINKS'),
      ...(out.length + inc.length === 0 ? [row('None yet', { dim: true })] : []),
      ...out.map(e => row(`→ ${clip(nameOf(e.to), panelInner - 2)}`, { act: () => send({ t: 'select', sel: { kind: 'edge', id: e.id } }) })),
      ...inc.map(e => row(`${e.isModel ? '◈' : '←'} ${clip(nameOf(e.from), panelInner - 2)}`, { dim: true, act: () => send({ t: 'select', sel: { kind: 'edge', id: e.id } }) })),
    ]
    details = {
      title: n.name,
      color: 'cyan',
      body,
      footer: [{ segs: [button('↺ Start fresh', () => send({ t: 'fresh', id: n.id }), 'yellow'), gap(), button('✕ Delete', () => send({ t: 'delete' }), 'red')] }],
    }
  } else if (selEdge) {
    const e = selEdge
    const body: Row[] = e.isModel ? [
      row(`${clip(e.fromName, 14)}  ◈  ${clip(e.toName, 14)}`, { bold: true }),
      blank(),
      row(`Sets the model ${clip(e.toName, 18)} runs with.`, { dim: true }),
      row('Carries no messages.', { dim: true }),
    ] : [
      row(`${clip(e.fromName, 14)}${e.port !== 'out' ? ` (${portLabel(e.port)})` : ''}  →  ${clip(e.toName, 14)}`, { bold: true }),
      blank(),
      ...note('Carries every message. To decide where messages go, put an If or Switch card on the link.'),
      blank(),
      heading('MAX PASSES'),
      {
        segs: [
          button('-', () => send({ t: 'edge', id: e.id, patch: { maxPasses: e.maxPasses - 1 } }), 'gray'),
          { text: ` ${e.maxPasses} `, bold: true },
          button('+', () => send({ t: 'edge', id: e.id, patch: { maxPasses: e.maxPasses + 1 } }), 'gray'),
          { text: '  hand-offs per run', dim: true },
        ],
      },
    ]
    details = {
      title: 'Link',
      color: 'cyan',
      body,
      footer: [{ segs: [button('✕ Delete link', () => send({ t: 'delete' }), 'red')] }],
    }
  } else if (rightW && openFlow) {
    const f = openFlow
    const confirming = local.confirmDelete === f.id
    details = {
      title: `Flow: ${f.name}`,
      body: [
        row(`${STATUS_ICON[f.status]} ${f.count} agent${f.count === 1 ? '' : 's'} · ${f.cards} card${f.cards === 1 ? '' : 's'}`, { color: STATUS_COLOR[f.status] }),
        blank(),
        ...field('FLOW NAME', f.name, 'flow-name', f.id, ''),
        blank(),
        { segs: [button('▶ Run flow', () => runFlowNow(), 'green'), gap(), button('■ Stop all', () => send({ t: 'flow-stop', id: f.id }), 'yellow')] },
        row('Sends the Start card\'s command on.', { dim: true }),
        blank(),
        heading('ON THE CANVAS'),
        row('• Click a card to edit it'),
        row('• Double-click an agent to chat'),
        row('• Drag ● out, or ○ in, to a card'),
        row('• Drag a ▶ arrowhead to re-wire'),
        row('• Click a link\'s ◆ to edit it'),
        blank(),
        heading('KEYS'),
        { segs: [{ text: 'n', bold: true, color: 'cyan' }, { text: ' add card   ' }, { text: 'a', bold: true, color: 'cyan' }, { text: ' add running' }] },
        { segs: [{ text: 'c', bold: true, color: 'cyan' }, { text: ' link       ' }, { text: 'r', bold: true, color: 'cyan' }, { text: ' run' }] },
        { segs: [{ text: 'o', bold: true, color: 'cyan' }, { text: ' open chat  ' }, { text: 'x', bold: true, color: 'cyan' }, { text: ' delete' }] },
        { segs: [{ text: 'v', bold: true, color: 'cyan' }, { text: ' view chat' }] },
        { segs: [{ text: '+ -', bold: true, color: 'cyan' }, { text: ' zoom     ' }, { text: '0', bold: true, color: 'cyan' }, { text: ' 100%' }] },
      ],
      footer: [
        ...(confirming ? [row('Deletes the flow file. Chats stay.', { color: 'red' })] : []),
        {
          segs: confirming
            ? [button('✕ Yes, delete flow', () => { send({ t: 'flow-delete', id: f.id }); set({ confirmDelete: null }) }, 'red'), gap(), button('Keep', () => set({ confirmDelete: null }), 'gray')]
            : [button('✕ Delete flow', () => set({ confirmDelete: f.id }), 'red')],
        },
      ],
    }
  } else if (rightW) {
    details = {
      title: 'Agent Flows',
      body: [
        blank(),
        heading('WHAT IS A FLOW'),
        row('A flow is a team of Claude agents'),
        row('and logic cards: a loop, a'),
        row('pipeline, a reviewer pair.'),
        row('A project can hold many flows,'),
        row('each running on its own.'),
        blank(),
        heading('GET STARTED'),
        row('• Click [ + New flow ] on the left'),
        row('• Press n: add a Start and agents'),
        row('• Steer with If, Switch, And, Loop'),
        row('• End shows the answer; Run flow'),
        blank(),
        row(`Saved in ${props.project}/.claude/flows/`, { dim: true }),
      ],
      footer: [],
    }
  }
  if (details) {
    const w = rightW || Math.min(RIGHT_W, cols)
    detailRange = drawPanel(cols - w, 0, w, details.title, details.body, {
      ht: rows, color: details.color, footer: details.footer,
      scroll: { top: detailTop, to: top => set({ detailTop: top, detailFor: selId }) },
    })
  }

  // ---------- flows list (left) ----------
  if (leftW) {
    const listInner = LEFT_W - 4
    const list: Row[] = [{ segs: [button('+ New flow', () => send({ t: 'flow-new' }))] }, blank()]
    for (const f of props.flows) {
      const isOpen = f.id === props.openFlowId
      list.push({
        segs: [
          { text: (isOpen ? '▾ ' : '▸ '), dim: !isOpen },
          { text: clip(f.name, listInner - 8), bold: isOpen, color: isOpen ? 'cyan' : undefined },
        ],
        right: { text: `${STATUS_ICON[f.status]} ${f.count}`, color: STATUS_COLOR[f.status], dim: !STATUS_COLOR[f.status] },
        act: () => send({ t: 'flow-open', id: f.id }),
      })
      if (!isOpen) continue
      for (const n of nodes) {
        list.push({
          segs: [
            n.kind === 'agent'
              ? { text: '  ' + (n.status === 'running' ? '●' : STATUS_ICON[n.status]) + ' ', ...pulse(n) }
              : { text: '  ' + metaOf(n.kind).icon + ' ', color: metaOf(n.kind).color },
            { text: clipMid(n.name, listInner - 14), bold: selNode?.id === n.id, color: selNode?.id === n.id ? 'cyan' : undefined },
            { text: n.isOpen ? ' ⧉' : '', color: 'green' },
          ],
          right: { text: n.kind === 'agent' ? statusShort(n) : n.warning ? '⚠' : '', dim: !n.warning, color: n.warning ? 'yellow' : undefined },
          act: () => {
            send({ t: 'select', sel: { kind: 'node', id: n.id } })
            focusOn(n)
          },
        })
      }
      list.push(
        { segs: [gap(2), { text: '+ Add card', color: 'cyan', act: () => set({ menu: true, edit: null }) }] },
        { segs: [gap(2), { text: '+ Add running chat', color: 'cyan', act: () => { set({ browse: null }); send({ t: 'picker', open: true }) } }] },
        blank(),
      )
    }
    for (const b of props.broken) list.push(row(`⚠ Can't read ${clip(b, listInner - 13)}`, { color: 'red' }))
    if (props.flows.length === 0 && !props.broken.length) list.push(row('No flows yet', { dim: true }))
    if (list.length > rows - 2) list.splice(rows - 3, list.length, row(`…${list.length - rows + 4} more`, { dim: true }))
    drawPanel(0, 0, LEFT_W, `Flows · ${props.project}`, list, { ht: rows })
  }

  // ---------- running-chat browser ----------
  // Folders and the chats running in them; the browser's rows, and how many show at once.
  const picker = props.picker
  const browse: Browse | null = picker
    ? local.browse && local.browse.dir === picker.dir ? local.browse : { dir: picker.dir, q: local.browse?.q ?? '', hi: 0, top: 0, folder: null }
    : null
  type Item = { kind: 'folder'; name: string; path: string; chats: number } | { kind: 'chat'; chat: AvailableSession }
  const items: Item[] = picker && browse
    ? [
        ...picker.folders.filter(f => !browse.q.trim() || f.name.toLowerCase().includes(browse.q.trim().toLowerCase())).map(f => ({ kind: 'folder' as const, ...f })),
        ...picker.chats.filter(c => matchChat(c, browse.q, picker.dir)).map(chat => ({ kind: 'chat' as const, chat })),
      ]
    : []
  const shownRows = Math.max(3, rows - 14)
  /** Moves the highlight, scrolling so it stays in view. */
  const moveTo = (hi: number) => {
    if (!browse) return
    const ht = Math.max(0, Math.min(items.length - 1, hi))
    const top = ht < browse.top ? ht : ht >= browse.top + shownRows ? ht - shownRows + 1 : browse.top
    set({ browse: { ...browse, hi: ht, top } })
  }
  const scroll = (by: number) => {
    if (!browse) return
    const top = Math.max(0, Math.min(Math.max(0, items.length - shownRows), browse.top + by))
    set({ browse: { ...browse, top, hi: Math.max(top, Math.min(top + shownRows - 1, browse.hi)) } })
  }
  const choose = (it: Item | undefined) => {
    if (!it) return
    if (it.kind === 'folder') send({ t: 'picker-dir', dir: it.path })
    else send({ t: 'adopt', sessionId: it.chat.sessionId, name: it.chat.name, cwd: it.chat.cwd, ...centre() })
  }
  if (picker && browse) {
    const w = Math.min(78, cols - 4)
    const inner = w - 4
    const editing = browse.folder !== null
    const visible = items.slice(browse.top, browse.top + shownRows)
    const listRows: Row[] = visible.map((it, i) => {
      const isHi = browse.top + i === browse.hi
      const mark: Seg = { text: isHi ? '› ' : '  ', color: 'cyan', bold: true }
      if (it.kind === 'folder') {
        const has = it.chats > 0
        return {
          segs: [mark, { text: '▸ ', color: has ? CHAT_ORANGE : undefined, dim: !has }, { text: clip(`${it.name}/`, inner - 18), bold: has || isHi, color: has ? CHAT_ORANGE : isHi ? 'cyan' : undefined, dim: !has && !isHi }],
          right: has ? { text: `● ${it.chats} chat${it.chats === 1 ? '' : 's'}`, color: CHAT_ORANGE, bold: true } : undefined,
          act: () => choose(it),
        }
      }
      const c = it.chat
      // Where it runs, from the folder being browsed.
      const where = c.cwd === picker.dir ? 'here' : c.cwd.startsWith(picker.dir + '/') ? c.cwd.slice(picker.dir.length + 1) : showPath(c.cwd, picker.home)
      return {
        segs: [mark, { text: '+ ', color: 'green', bold: true }, { text: clip(c.name, 28).padEnd(29), bold: true, color: isHi ? 'cyan' : undefined }, { text: clipStart(where, Math.max(4, inner - 45)), dim: true }],
        right: { text: ago(c.startedAt), dim: true },
        act: () => choose(it),
      }
    })
    const q = browse.q
    const body: Row[] = [
      {
        segs: [
          { text: 'Search  ', dim: true, act: () => set({ browse: { ...browse, folder: null } }) },
          ...(editing
            ? [{ text: clip(q, inner - 10), color: 'yellow', act: (dx: number) => set({ browse: { ...browse, folder: null, qPos: Math.min(dx, q.length) } }) }]
            : boxRows(caretOf({ text: q, pos: browse.qPos }), inner - 10, 1, pos => set({ browse: { ...browse, qPos: pos } }))[0]!.segs),
          ...(q || editing ? [] : [{ text: 'type to filter by name or folder', dim: true }]),
        ],
      },
      editing
        ? {
            segs: [
              { text: 'Folder  ', dim: true },
              ...boxRows(caretOf({ text: browse.folder ?? '', pos: browse.fPos }), inner - 10, 1, pos => set({ browse: { ...browse, fPos: pos } }))[0]!.segs,
            ],
          }
        : {
            segs: (() => {
              // The label starts typing at the end; the path itself, where it's clicked.
              const path = showPath(picker.dir, picker.home)
              const shown = clipStart(path, inner - 18)
              const editFolder = (pos = path.length) => set({ browse: { ...browse, folder: path, fPos: pos } })
              return [
                { text: 'Folder  ', dim: true, act: () => editFolder() },
                { text: shown, bold: true, act: (dx: number) => editFolder(shown === path ? Math.min(dx, path.length) : path.length) },
              ]
            })(),
            right: { text: '[ ↑ Up ]', color: picker.dir === '/' ? 'gray' : 'cyan', bold: true, act: () => send({ t: 'picker-dir', dir: parentOf(picker.dir) }) },
          },
      row(editing ? 'Type or paste a path, then Enter to go there.' : 'Click the folder to type or paste a path.', { dim: true }),
      ...(picker.note ? [row(`⚠ ${picker.note}`, { color: 'yellow' })] : []),
      blank(),
      ...(listRows.length ? listRows : [row(q.trim() ? `Nothing here matches "${q.trim()}".` : `No running chats in ${showPath(picker.dir, picker.home)} or below.`, { dim: true })]),
    ]
    const range = items.length ? `${browse.top + 1}–${Math.min(browse.top + shownRows, items.length)} of ${items.length}` : '0 of 0'
    const footer: Row[] = [
      blank(),
      {
        segs: [
          button('▲', () => scroll(-shownRows), browse.top > 0 ? 'cyan' : 'gray'),
          { text: ` ${range} `, dim: true },
          button('▼', () => scroll(shownRows), browse.top + shownRows < items.length ? 'cyan' : 'gray'),
          gap(3),
          button('Cancel', () => send({ t: 'picker', open: false }), 'gray'),
        ],
        right: { text: '↑↓ move · Enter open', dim: true },
      },
    ]
    const ht = Math.min(rows, body.length + footer.length + 2 + Math.max(0, shownRows - listRows.length))
    drawPanel(Math.floor((cols - w) / 2), Math.max(0, Math.floor((rows - ht) / 2)), w, 'Add a running chat', body, { color: 'cyan', footer, ht })
  }

  // ---------- add card menu ----------
  if (local.menu) {
    const w = Math.min(52, cols - 4)
    const body: Row[] = KINDS.map(k => ({
      segs: [{ text: `${k.icon} `, color: k.color, bold: true }, { text: k.label.padEnd(12), bold: true }, { text: k.blurb, dim: true }],
      act: () => {
        send({ t: 'new', ...centre(), kind: k.kind })
        set({ menu: false })
      },
    }))
    const footer: Row[] = [blank(), { segs: [button('Cancel', () => set({ menu: false }), 'gray')] }]
    const ht = body.length + footer.length + 2
    drawPanel(Math.floor((cols - w) / 2), Math.max(0, Math.floor((rows - ht) / 2)), w, 'Add a card', body, { color: 'cyan', footer })
  }

  // ---------- run flow (the command) or test one agent (a message), pre-filled to edit ----------
  if (edit?.kind === 'run' || edit?.kind === 'test') {
    const w = Math.min(64, cols - 4)
    const isTest = edit.kind === 'test'
    const who = nameOf(edit.id)
    const body: Row[] = [
      row(isTest ? `A one-off message for ${who}, outside the flow.` : `${openFlow?.name ?? 'Flow'}: the command this run starts with.`, { dim: true }),
      ...(isTest ? [row('Its instructions go with it.', { dim: true })] : []),
      blank(),
      ...boxRows(caretOf(edit), w - 4, 5, pos => set({ edit: { ...edit, pos } })),
      blank(),
      row('Enter to run · ← → move · Cmd+V paste · click away to cancel', { dim: true }),
    ]
    const footer: Row[] = [{ segs: [button('▶ Run', () => submitRun(), 'green'), gap(), button('Cancel', () => set({ edit: null }), 'gray')] }]
    const ht = body.length + footer.length + 2
    drawPanel(Math.floor((cols - w) / 2), Math.max(0, Math.floor((rows - ht) / 2)), w, isTest ? `Test ${who}` : 'Run flow', body, { color: 'green', footer })
  }

  // ---------- the read-only chat view, over the canvas ----------
  const chat = props.chat
  /** Where the chat view is drawn: a click outside it closes it. */
  let chatBox: { x: number; y: number; w: number; ht: number } | null = null
  const chatRows: Row[] = []
  const chatPage = Math.max(4, rows - 6)
  let chatScroll = (_to: number) => {}
  let chatFirstShown = 0
  const closeChat = () => {
    set({ chatFirst: undefined, chatFor: undefined })
    send({ t: 'chat', id: null })
  }
  if (chat) {
    const w = Math.min(100, cols - 6)
    const inner = w - 4
    for (const m of chat.lines) {
      const who = m.who === 'you' ? 'You' : m.who === 'peer' ? `From ${m.from || 'another chat'}` : chat.name
      const color = m.who === 'you' ? 'cyan' : m.who === 'peer' ? 'magenta' : 'green'
      chatRows.push(row(who, { bold: true, color }))
      for (const l of wrapText(plain(m.text), inner, 400)) {
        chatRows.push(row(l, l.startsWith('⚙') ? { color: 'blue', dim: true } : m.who === 'peer' ? { dim: true } : {}))
      }
      chatRows.push(blank())
    }
    if (!chatRows.length) chatRows.push(row(chat.note ?? 'Nothing in this chat yet.', { dim: true }))
    const newest = Math.max(0, chatRows.length - chatPage)
    // Scrolled back, the view holds its place as new messages arrive below.
    const held = local.chatFor === chat.id ? local.chatFirst : undefined
    const first = held === undefined ? newest : Math.min(held, newest)
    const back = newest - first
    chatScroll = (to: number) => set({ chatFirst: to >= newest ? undefined : Math.max(0, to), chatFor: chat.id })
    const scrollBy = (n: number) => chatScroll(first - n)
    const body = chatRows.slice(first, first + chatPage)
    chatFirstShown = first
    const footer: Row[] = [{
      segs: [
        { text: '▲ Older', bold: true, color: first > 0 ? 'cyan' : undefined, dim: first === 0, act: () => scrollBy(chatPage - 2) },
        gap(2),
        { text: '▼ Newer', bold: true, color: back > 0 ? 'cyan' : undefined, dim: back === 0, act: () => scrollBy(-(chatPage - 2)) },
        gap(2),
        button('✕ Close', () => closeChat(), 'gray'),
        { text: back > 0 ? '  ↑ ↓ PgUp PgDn · End: newest' : '  following along · q closes', dim: true },
      ],
    }]
    const ht = rows
    const x = Math.floor((cols - w) / 2)
    const live = chat.status === 'running' ? ' · ● working' : ''
    drawPanel(x, 0, w, `${chat.name} · read-only${live}`, body, { color: 'green', footer, ht })
    chatBox = { x, y: 0, w, ht }
  }

  // ---------- input ----------
  const panelAt = (x: number, y: number) => [...panels].reverse().find(p => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.ht)
  const toView = (e: ClientPointerEvent) => ({ x: e.x + local.pan.x, y: e.y + local.pan.y })
  const nodeAt = (x: number, y: number) => [...nodes].reverse().find(n => x >= n.x && x < n.x + W && y >= n.y && y < n.y + n.ht)
  /** The output dot under a point on a card with named outputs. */
  /** The arrowhead under a point; where several meet at one input, the selected link's, else the newest. */
  const arrowAt = (x: number, y: number) => {
    const here = edges.filter(e => e.arrow[1] === y && e.arrow[0] === x)
    return here.find(e => e.id === selEdge?.id) ?? here[here.length - 1]
  }
  const edgeAt = (x: number, y: number) => edges.find(e => y === e.ly && x >= e.lx - 1 && x <= e.lx + e.label.length)

  // A click that takes the cursor out of a text box keeps what was typed there: the
  // next box (Run flow's command, say) opens with it, and nothing typed is lost.
  surface.onPointer(e => {
    const before = local.edit
    onPointer(e)
    const after = changes.edit !== undefined ? changes.edit : local.edit
    const sameBox = after && before && after.kind === before.kind && after.id === before.id && after.field === before.field
    if (before && !sameBox) saveEdit(before)
  })
  function onPointer(e: ClientPointerEvent) {
    const w = toView(e)
    if (e.type === 'down' && e.button === 'left') {
      if (chatBox && !(e.x >= chatBox.x && e.x < chatBox.x + chatBox.w && e.y >= chatBox.y && e.y < chatBox.y + chatBox.ht)) return closeChat()
      const panel = panelAt(e.x, e.y)
      // The drawer is the card's: its last line opens the chat view; the rest selects nothing new.
      if (!panel && drawer && w.x >= drawer.x && w.x < drawer.x + drawer.w && w.y > drawer.y && w.y < drawer.y + drawer.ht) {
        if (w.y === drawer.chatRow && selNode) send({ t: 'chat', id: selNode.id })
        return
      }
      if (panel) {
        // A click inside a panel is the panel's; clicking anything but the field being typed in ends typing.
        const hit = [...panel.hits].reverse().find(ht => ht.y === e.y && e.x >= ht.x1 && e.x <= ht.x2)
        if (local.edit && !hit) set({ edit: null })
        hit?.act(e.x - hit.x1)
        return
      }
      if (props.picker) {
        send({ t: 'picker', open: false })
        return
      }
      if (local.menu || edit?.kind === 'run') {
        set({ menu: false, edit: null })
        return
      }
      if (local.notice) set({ notice: null })
      // A link's arrowhead: drag it onto another card to re-wire the link.
      const head = !props.connectFrom ? arrowAt(w.x, w.y) : undefined
      const headEdge = head && props.edges.find(x => x.id === head.id)
      if (head && headEdge) {
        send({ t: 'select', sel: { kind: 'edge', id: head.id } })
        set({ edit: null, drag: { kind: 'rewire', edgeId: head.id, from: headEdge.from, to: headEdge.to, sx: head.arrow[0], sy: head.arrow[1], x: w.x, y: w.y, moved: false } })
        return
      }
      const hit = nodeAt(w.x, w.y)
      if (hit) {
        if (props.connectFrom) {
          send({ t: 'connect', from: props.connectFrom, to: hit.id })
          set({ drag: null, edit: null })
          return
        }
        // An agent card's See response / Watch live: selects it and opens its chat view.
        const cta = hit.kind === 'agent' && !g.isCompact ? agentCta(hit) : null
        if (cta?.opens && w.y === hit.y + hit.ht - 2 && w.x >= hit.x + 2 && w.x < hit.x + 2 + cta.text.length) {
          send({ t: 'select', sel: { kind: 'node', id: hit.id } })
          send({ t: 'chat', id: hit.id })
          set({ drag: null, edit: null })
          return
        }
        // An output dot: drag out a link (or click, then click the target, as before).
        const port = portAt(hit, w.x, w.y)
        if (port && canLinkFrom(hit)) {
          send({ t: 'select', sel: { kind: 'node', id: hit.id } })
          const sy = hit.y + rowAt(hit, port)
          set({ edit: null, notice: null, drag: { kind: 'link', dir: 'out', from: hit.id, port, sx: hit.x + W, sy, x: w.x, y: w.y, moved: false } })
          return
        }
        // The model dot: drag back onto the Model card this agent should run with.
        if (isModelInputAt(hit, w.x, w.y)) {
          send({ t: 'select', sel: { kind: 'node', id: hit.id } })
          set({ edit: null, notice: null, drag: { kind: 'link', dir: 'in', from: hit.id, port: '', sx: hit.x - 1, sy: hit.y + M_ROW, x: w.x, y: w.y, moved: false, toModel: true } })
          return
        }
        // An input dot: drag back onto the card this one should hear from.
        if (isInputAt(hit, w.x, w.y)) {
          send({ t: 'select', sel: { kind: 'node', id: hit.id } })
          set({ edit: null, notice: null, drag: { kind: 'link', dir: 'in', from: hit.id, port: '', sx: hit.x - 1, sy: hit.y + inRowAt(hit, g), x: w.x, y: w.y, moved: false } })
          return
        }
        const now = Date.now()
        // Double-click opens an agent's chat; logic cards have none.
        const isDouble = hit.kind === 'agent' && local.lastDown?.id === hit.id && now - local.lastDown.at < DOUBLE_CLICK_MS
        send(isDouble ? { t: 'open', id: hit.id } : { t: 'select', sel: { kind: 'node', id: hit.id } })
        set({
          lastDown: isDouble ? null : { id: hit.id, at: now },
          drag: { kind: 'node', id: hit.id, dx: w.x - hit.x, dy: w.y - hit.y, moved: false },
          edit: null,
        })
        return
      }
      const edge = edgeAt(w.x, w.y)
      if (edge) {
        send({ t: 'select', sel: { kind: 'edge', id: edge.id } })
        set({ drag: null, edit: null })
        return
      }
      send(props.connectFrom ? { t: 'cancel' } : { t: 'select', sel: { kind: 'none' } })
      set({ edit: null, drag: { kind: 'pan', sx: e.x, sy: e.y, px: local.pan.x, py: local.pan.y } })
      return
    }
    if (e.type === 'move' && e.button === 'left' && local.drag) {
      const drag = local.drag
      if (drag.kind === 'node') {
        held[drag.id] = { x: Math.round((w.x - drag.dx) / zoom), y: Math.round((w.y - drag.dy) / zoom) }
        set({ drag: { ...drag, moved: true } })
      } else if (drag.kind === 'link' || drag.kind === 'rewire') {
        set({ drag: { ...drag, x: w.x, y: w.y, moved: true } })
      } else {
        set({ pan: { x: drag.px - (e.x - drag.sx), y: drag.py - (e.y - drag.sy) } })
      }
      return
    }
    if (e.type === 'up' && local.drag) {
      const drag = local.drag
      if (drag.kind === 'node' && drag.moved && held[drag.id]) {
        const p = held[drag.id]!
        send({ t: 'move', id: drag.id, x: p.x, y: p.y })
      }
      let notice: string | null = null
      if (drag.kind === 'link' && !drag.moved) {
        // A click on an output dot with no drag: pick the target next, as before.
        if (drag.dir === 'out') send({ t: 'connect-start', id: drag.from, port: drag.port })
      } else if (drag.kind === 'link' || drag.kind === 'rewire') {
        const d = judgeDrop(drag, w.x, w.y)
        notice = d.why ?? null
        if (d.target && drag.kind === 'rewire') send({ t: 'relink', id: drag.edgeId, to: d.target.id })
        else if (d.target && drag.kind === 'link' && drag.dir === 'out') send({ t: 'connect', from: drag.from, to: d.target.id, port: drag.port })
        else if (d.target && drag.kind === 'link') send({ t: 'connect', from: d.target.id, to: drag.from, port: d.port ?? 'out' })
      }
      set({ drag: null, notice })
    }
  }

  surface.onKey((k: ClientKeyEvent) => {
    const sel = props.selected
    // The host names a space `space`, as it does `return` or `tab`.
    const key = k.key === 'space' ? ' ' : k.key
    if (local.menu) {
      if (key === 'escape') set({ menu: false })
      return
    }
    // The chat view takes the keys while open: scroll it, or q to close.
    if (chat) {
      const at = chatFirstShown
      if (key === 'up') chatScroll(at - 1)
      else if (key === 'down') chatScroll(at + 1)
      else if (key === 'pageup') chatScroll(at - chatPage + 2)
      else if (key === 'pagedown') chatScroll(at + chatPage - 2)
      else if (key === 'home') chatScroll(0)
      else if (key === 'end') chatScroll(Infinity)
      else if (key === 'q' || key === 'escape') closeChat()
      return
    }
    // The browser takes every key while open: its folder box, else its search and list.
    if (picker && browse) {
      if (isPasteKey(k)) return askPaste()
      if (browse.folder !== null) {
        if (key === 'escape') set({ browse: { ...browse, folder: null } })
        else if (key === 'return') {
          send({ t: 'picker-dir', dir: browse.folder })
          set({ browse: { ...browse, folder: null } })
        } else {
          const next = keyInto(caretOf({ text: browse.folder, pos: browse.fPos }), k)
          if (next) set({ browse: { ...browse, folder: next.text, fPos: next.pos } })
        }
        return
      }
      if (key === 'escape') send({ t: 'picker', open: false })
      else if (key === 'up') moveTo(browse.hi - 1)
      else if (key === 'down') moveTo(browse.hi + 1)
      else if (key === 'pageup') moveTo(browse.hi - shownRows)
      else if (key === 'pagedown') moveTo(browse.hi + shownRows)
      else if (key === 'return') choose(items[browse.hi])
      else {
        const next = keyInto(caretOf({ text: browse.q, pos: browse.qPos }), k)
        if (next) set({ browse: { ...browse, q: next.text, qPos: next.pos, ...(next.text !== browse.q ? { hi: 0, top: 0 } : {}) } })
      }
      return
    }
    if (edit) {
      if (key === 'escape') return set({ edit: null })
      if (key === 'return') {
        if (edit.kind === 'run' || edit.kind === 'test') return submitRun()
        saveEdit(edit)
        set({ edit: null })
      } else if (isPasteKey(k)) askPaste()
      else {
        const next = keyInto(caretOf(edit), k, activeLines)
        if (next) set({ edit: { ...edit, text: next.text, pos: next.pos } })
      }
      return
    }
    if (key === 'pagedown') return pageDetails(1)
    if (key === 'pageup') return pageDetails(-1)
    if (key === '+' || key === '=') zoomStep(1)
    else if (key === '-' || key === '_') zoomStep(-1)
    else if (key === '0') zoomTo(1)
    else if (key === 'n') set({ menu: true })
    else if (key === 'a') {
      set({ browse: null })
      send({ t: 'picker', open: true })
    }
    else if (key === 'c' && sel.kind === 'node') send({ t: 'connect-start', id: sel.id })
    else if ((key === 'x' || key === 'delete' || key === 'backspace') && sel.kind !== 'none') send({ t: 'delete' })
    else if (key === 'r' && sel.kind === 'node') {
      // No prompt yet: start writing one rather than refuse.
      const n = nodes.find(one => one.id === sel.id)
      if (n?.kind === 'start') runFlowNow()
      else if (n && n.kind !== 'agent') return
      else if (n) testAgent(n)
    }
    else if ((key === 'o' || key === 'return') && sel.kind === 'node' && nodes.find(n => n.id === sel.id)?.kind === 'agent') send({ t: 'open', id: sel.id })
    else if (key === 'v' && sel.kind === 'node' && nodes.find(n => n.id === sel.id)?.kind === 'agent') send({ t: 'chat', id: sel.id })
    else if (['up', 'down', 'left', 'right'].includes(key) && sel.kind === 'node') {
      const n = worldNodes.find(one => one.id === sel.id)
      if (!n) return
      const dx = key === 'left' ? -2 : key === 'right' ? 2 : 0
      const dy = key === 'up' ? -1 : key === 'down' ? 1 : 0
      held[n.id] = { x: n.x + dx, y: n.y + dy }
      send({ t: 'move', id: n.id, x: n.x + dx, y: n.y + dy })
      set({})
    }
  })

  if (props.desktop) {
    const style = (cell: Cell) => ({ color: DESKTOP_COLOR[cell.color ?? ''] ?? cell.color, bold: cell.bold, dimColor: cell.dim })
    return (
      <Box position="relative" width={cols} height={rows}>
        {desktopPieces(grid).map(run =>
          run.height ? (
            <Box position="absolute" left={run.x} top={run.y} width={1} flexDirection="column" alignItems="center">
              {Array.from({ length: run.height }, () => <Text {...style(run.cell)}>{run.text}</Text>)}
            </Box>
          ) : run.width && run.width > 1 ? (
            // Wider inside than the cells it shows, so its last glyph is cut, not wrapped away.
            <Box position="absolute" left={run.x} top={run.y} width={run.width} height={1} overflow="hidden">
              <Box width={run.width + 2} flexShrink={0}>
                <Text {...style(run.cell)}>{run.text + run.text[0]}</Text>
              </Box>
            </Box>
          ) : (
            <Box position="absolute" left={run.x} top={run.y} {...(run.width ? GLYPH_BOX : { height: 1 })}>
              <Text {...style(run.cell)}>{run.text}</Text>
            </Box>
          ),
        )}
      </Box>
    )
  }
  // Collapse each row into runs of one style.
  return (
    <Box flexDirection="column">
      {grid.map(line => {
        const runs: { cell: Cell; text: string }[] = []
        for (const cell of line) {
          const last = runs[runs.length - 1]
          if (last && same(last.cell, cell)) last.text += cell.ch
          else runs.push({ cell, text: cell.ch })
        }
        return (
          <Box flexDirection="row">
            {runs.map(run => (
              <Text color={run.cell.color} bold={run.cell.bold} dimColor={run.cell.dim} wrap="truncate">
                {run.text}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export default Canvas
