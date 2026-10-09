import type { ChatLine, FlowEdge } from '../types'
import { resolveDir } from './picker'

export type StreamEvent =
  | { kind: 'preview'; lines: string[] }
  | { kind: 'result'; text: string; isError: boolean }
  /** Claude has loaded (its plugins and MCP servers) and begun the turn. */
  | { kind: 'started' }
  /** A piece of Claude's thinking, as it is written; '' where thinking is hidden. */
  | { kind: 'thinking'; text: string }
  /** A piece of the reply's text, as it is written (`--include-partial-messages`). */
  | { kind: 'delta'; text: string }

/** Reads one line of `claude -p --output-format stream-json` into what the canvas shows. */
export function parseStreamLine(line: string): StreamEvent | null {
  if (!line.trim()) return null
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const lines: string[] = []
    for (const block of msg.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        lines.push(...block.text.split('\n').map((l: string) => l.trim()).filter(Boolean))
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        lines.push(`⚙ ${block.name}`)
      }
    }
    return lines.length ? { kind: 'preview', lines } : null
  }
  if (msg?.type === 'system' && msg.subtype === 'init') return { kind: 'started' }
  if (msg?.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
    const d = msg.event.delta
    if (d?.type === 'text_delta' && typeof d.text === 'string') return { kind: 'delta', text: d.text }
    if (d?.type === 'thinking_delta') return { kind: 'thinking', text: typeof d.thinking === 'string' ? d.thinking : '' }
    return null
  }
  if (msg?.type === 'result') {
    return { kind: 'result', text: typeof msg.result === 'string' ? msg.result : '', isError: msg.is_error === true }
  }
  return null
}

/**
 * What a background run's card shows while it runs: the finished lines, then the
 * message being written, or what Claude is doing before any text comes.
 */
export type Live = { lines: string[]; draft: string; phase: 'starting' | 'waiting' | 'thinking' | 'writing'; thinking: string }

/** Lines of activity kept: the card shows the last few, the side panel's LIVE section all of them. */
export const PREVIEW_LINES = 8
/** The tail of the latest thinking kept, for the side panel. */
export const THINKING_CHARS = 1200

export const startLive = (first: string): Live => ({ lines: [first], draft: '', phase: 'starting', thinking: '' })

export function applyLive(live: Live, ev: StreamEvent): Live {
  switch (ev.kind) {
    case 'started': return { ...live, phase: 'waiting' }
    case 'thinking': {
      // A new stretch of thinking (after text was written) starts afresh.
      const thinking = (live.phase === 'thinking' ? live.thinking + ev.text : ev.text).slice(-THINKING_CHARS)
      return live.draft ? { ...live, thinking } : { ...live, phase: 'thinking', thinking }
    }
    case 'delta': return { ...live, draft: live.draft + ev.text, phase: 'writing' }
    // A finished message replaces its draft, so nothing shows twice.
    case 'preview': return { ...live, lines: [...live.lines, ...ev.lines].slice(-PREVIEW_LINES), draft: '', phase: 'waiting' }
    default: return live
  }
}

export function previewOf(live: Live): string[] {
  const draft = live.draft.split('\n').map(l => l.trim()).filter(Boolean)
  const status = live.phase === 'starting' ? ['… starting Claude'] : live.phase === 'thinking' ? ['… thinking'] : []
  return [...live.lines, ...draft, ...status].slice(-PREVIEW_LINES)
}

/**
 * Decides whether a connection fires for a session's final output.
 * `else` is handled by the router, not here.
 */
export async function evaluateEdge(
  edge: FlowEdge,
  output: string,
  ask: (prompt: string) => Promise<string>,
): Promise<boolean> {
  const value = edge.value.trim()
  switch (edge.cond) {
    case 'always':
      return true
    case 'else':
      return false
    case 'contains':
      return value !== '' && output.toLowerCase().includes(value.toLowerCase())
    case 'not-contains':
      return value === '' || !output.toLowerCase().includes(value.toLowerCase())
    case 'regex':
      try {
        return new RegExp(value, 'i').test(output)
      } catch {
        return false
      }
    case 'judge': {
      if (!value) return false
      const reply = await ask(
        `You are routing work between AI sessions. Read the session output below and decide whether this statement is true:\n\n` +
          `STATEMENT: ${value}\n\nOUTPUT:\n${output.slice(-12000)}\n\nAnswer with exactly one word: YES or NO.`,
      )
      return /^\W*yes\b/i.test(reply)
    }
  }
}

export const fillTemplate = (template: string, vars: { output: string; from: string }) =>
  template.replaceAll('{{output}}', vars.output).replaceAll('{{from}}', vars.from)

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

export type TranscriptView = { status: 'running' | 'done' | 'idle'; preview: string[]; lastOutput: string; thinking: string }

/**
 * Reads the tail of a session's transcript (.jsonl) into a canvas preview:
 * the latest prompt and reply lines, and whether a turn is still going.
 * `isStale` (file untouched for a while) turns an unfinished turn into idle:
 * the session was interrupted or closed mid-turn.
 */
export function parseTranscript(tail: string, isStale: boolean): TranscriptView | null {
  const messages: { role: 'user' | 'assistant'; content: any; stop?: string }[] = []
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue // the first line of a tail may be cut
    }
    if ((row?.type === 'user' || row?.type === 'assistant') && row.message && !row.isMeta) {
      messages.push({ role: row.type, content: row.message.content, stop: row.message.stop_reason ?? undefined })
    }
  }
  if (messages.length === 0) return null

  const textOf = (content: any): string[] =>
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b: any) =>
            b?.type === 'text' ? [b.text] : b?.type === 'tool_use' ? [`⚙ ${b.name}`] : [],
          )
        : []
  const isToolResult = (m: (typeof messages)[number]) =>
    Array.isArray(m.content) && m.content.length > 0 && m.content.every((b: any) => b?.type === 'tool_result')

  // The last real prompt, and every assistant line after it.
  let start = messages.length - 1
  while (start > 0 && !(messages[start]!.role === 'user' && !isToolResult(messages[start]!))) start--
  const prompt = messages[start]!.role === 'user' ? textOf(messages[start]!.content).join(' ') : ''
  const replies = messages.slice(start).filter(m => m.role === 'assistant')
  const replyText = replies.flatMap(m => textOf(m.content)).join('\n')
  const lines = replyText.split('\n').map(l => l.trim()).filter(Boolean)

  const last = messages[messages.length - 1]!
  const isTurnOver = last.role === 'assistant' && last.stop !== 'tool_use' && last.stop !== undefined
  const status = isTurnOver ? 'done' : isStale ? 'idle' : 'running'
  const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

  // The turn's latest thinking: the last thinking block written since the prompt.
  const thoughts = replies.flatMap(m =>
    Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b: any) => b.thinking as string) : [],
  )
  return {
    status,
    preview: [...(prompt ? ['▸ ' + clean(prompt)] : []), ...lines.slice(-(PREVIEW_LINES - 1))],
    thinking: (thoughts.at(-1) ?? '').slice(-THINKING_CHARS),
    lastOutput: replies
      .flatMap(m => (Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text) : []))
      .join('\n'),
  }
}

/** Labels a connection's condition in plain words, for a session to read. */
export function describeCondition(edge: FlowEdge): string {
  switch (edge.cond) {
    case 'always': return 'any message'
    case 'else': return 'any message'
    case 'contains': return `only messages containing "${edge.value}"`
    case 'not-contains': return `only messages not containing "${edge.value}"`
    case 'regex': return `only messages matching /${edge.value}/i`
    case 'judge': return `only messages where this holds: ${edge.value}`
  }
}

/**
 * Finds which canvas node a SendMessage recipient is: by session id, or by the
 * name ListAgents shows (the node's name, then the engine's "-word-word" suffix).
 * The longest matching name wins, so "Session 10" beats "Session 1".
 */
export function matchRecipient<N extends { name: string; sessionId?: string }>(nodes: N[], to: string): N | undefined {
  const t = to.trim().toLowerCase()
  const byId = nodes.find(n => n.sessionId && t.includes(n.sessionId.toLowerCase()))
  if (byId) return byId
  return nodes
    .filter(n => {
      const name = n.name.toLowerCase()
      return t === name || t.startsWith(name + '-') || t.startsWith(name + ' ')
    })
    .sort((a, b) => b.name.length - a.name.length)[0]
}

/** The system-prompt section that tells a node session who it may talk to. */
export function peerSection(
  self: { id: string; name: string },
  nodes: { id: string; name: string }[],
  edges: FlowEdge[],
): string {
  const nameOf = (id: string) => nodes.find(n => n.id === id)?.name ?? '?'
  const peers = new Map<string, { out?: FlowEdge; in?: FlowEdge }>()
  for (const e of edges) {
    if (e.from === self.id && e.to !== self.id) peers.set(e.to, { ...peers.get(e.to), out: e })
    if (e.to === self.id && e.from !== self.id) peers.set(e.from, { ...peers.get(e.from), in: e })
  }
  const lines = [...peers].map(([id, p]) => {
    const name = nameOf(id)
    const send = p.out ? `you may send it ${describeCondition(p.out)} (at most ${p.out.maxPasses} per message from your person)` : `you may reply to it (at most ${p.in!.maxPasses} per message from your person)`
    return `- "${name}": ${send}.${p.in ? ' It can message you.' : ''}`
  })
  return [
    `# Agent Flows`,
    `You are the agent "${self.name}" in an Agent Flows flow: Claude chats on this machine linked so they hand work to each other.`,
    lines.length
      ? [
          `You are linked to:\n${lines.join('\n')}`,
          `When your turn ends, your reply is handed on automatically, through any If / Switch / Loop cards on the way, to the agents you send to. So just answer; don't also send your reply with SendMessage.`,
          `Messages with "[Agent Flows · run … · hand-off N]" are hand-offs from the flow: do what they ask and reply normally. Your reply goes on along the links. Messages with "[Agent Flows · notice]" are for your information only.`,
          `If a hand-off needs no response (a thank-you, a status note, "we're done"), reply with exactly "[no reply]" and nothing is passed on. Don't send acknowledgements back and forth.`,
          `Use SendMessage only for something extra (a question mid-task). A linked agent's address is the name ListAgents shows, which starts with its name (e.g. "${nameOf([...peers.keys()][0]!)}-…"). Messages to agents you aren't linked to are refused.`,
        ].join('\n\n')
      : `You are not linked to any other agent right now. If the person asks you to work with another agent, tell them to link the two on the canvas first.`,
  ].join('\n')
}

// Card size in cells; keep in step with NODE_W / NODE_H in canvas.tsx.
export const CARD = { w: 28, ht: 10 }

/**
 * An agent's instructions: a standing brief sent ahead of every message it gets in
 * a flow. A line that is only `@path` adds that file in its place, so an agent can
 * be grounded on a CLAUDE.md or AGENTS.md.
 */
export const instructionRefs = (text: string): string[] =>
  [...new Set(text.split('\n').map(l => /^\s*@(\S+)\s*$/.exec(l)?.[1]).filter((r): r is string => !!r))]

const FILE_CAP = 40000
const TOTAL_CAP = 100000

/**
 * Where an `@path` points, or null when it may not be read: only files inside the
 * project or the agent's own folder, or `.md` files under `~/.claude`. A flow can
 * come from someone else, so its instructions can't reach a key or a token.
 */
export function resolveRef(ref: string, home: string, root: string, cwd: string): string | null {
  const path = resolveDir(ref, home, cwd)
  const under = (dir: string) => path.startsWith(dir.endsWith('/') ? dir : dir + '/')
  if (under(root) || under(cwd)) return path
  if (under(`${home}/.claude`) && path.toLowerCase().endsWith('.md')) return path
  return null
}

export type RefFile = { path: string; content: string } | { error: string }

/** The block sent ahead of a message: the instructions, each `@path` line replaced by its file. */
export function composeInstructions(name: string, text: string, files: Record<string, RefFile>): { text: string; problems: string[] } {
  const problems: string[] = []
  let room = TOTAL_CAP
  const body = text.split('\n').map(line => {
    const ref = /^\s*@(\S+)\s*$/.exec(line)?.[1]
    const f = ref ? files[ref] : undefined
    if (!ref || !f) return line
    if ('error' in f) {
      const why = `@${ref} wasn't added: ${f.error}`
      problems.push(why)
      return `(${why})`
    }
    const cap = Math.max(0, Math.min(FILE_CAP, room))
    const isCut = f.content.length > cap
    room -= Math.min(f.content.length, cap)
    return `<file path="${f.path}">\n${f.content.slice(0, cap).replace(/\n$/, '')}${isCut ? `\n(cut at ${cap} characters)` : ''}\n</file>`
  })
  return { text: [`[Agent Flows · your instructions as ${name}]`, ...body, '[End of instructions. The message follows.]'].join('\n'), problems }
}

/**
 * The cmux tab (its surface id) showing terminal `tty`, read from `cmux tree --all
 * --id-format both`; null when no tab shows it (the chat runs in another app).
 */
export function surfaceForTty(tree: string, tty: string): string | null {
  const name = tty.trim().replace(/^\/dev\//, '')
  if (!/^tty/.test(name)) return null
  for (const line of tree.split('\n')) {
    if (!new RegExp(`\\btty=${name}(\\s|$)`).test(line)) continue
    const id = /surface:\d+\s+([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i.exec(line)?.[1]
    if (id) return id
  }
  return null
}


/** Messages a chat view keeps, newest last, and the characters across them. */
const CHAT_MESSAGES = 60
const CHAT_CHARS = 40000

/**
 * A transcript's tail as a chat to read: what was typed, what agents and runs
 * sent it (named), and its replies, tool calls as `⚙ name`. Commands, their
 * output and tool results are left out.
 */
export function parseChat(tail: string): ChatLine[] {
  const out: ChatLine[] = []
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if ((row?.type !== 'user' && row?.type !== 'assistant') || !row.message || row.isMeta) continue
    const content = row.message.content
    if (row.type === 'assistant') {
      const parts = Array.isArray(content)
        ? content.flatMap((b: any) => (b?.type === 'text' ? [b.text] : b?.type === 'tool_use' ? [`⚙ ${b.name}`] : []))
        : typeof content === 'string' ? [content] : []
      const text = parts.join('\n').trim()
      if (!text) continue
      // Tool calls in a row share one line: ⚙ Read · ⚙ Grep.
      const prev = out.at(-1)
      if (prev?.who === 'agent' && /^⚙ /.test(text) && /^⚙ [^\n]*$/.test(prev.text.split('\n').at(-1) ?? '')) prev.text += ` · ${text}`
      else out.push({ who: 'agent', text })
      continue
    }
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : ''
    if (!text.trim() || /^<(local-command|command-name|command-message|system-reminder)/.test(text.trim())) continue
    const peer = /<cross-session-message[^>]*from-name="([^"]*)"[^>]*>([\s\S]*?)<\/cross-session-message>/.exec(text)
    if (peer) out.push({ who: 'peer', from: peer[1], text: peer[2]!.trim() })
    else out.push({ who: 'you', text: text.replace(/<[^>]+>/g, '').trim() })
  }
  // The newest messages, within the character budget.
  const kept: ChatLine[] = []
  let chars = 0
  for (const m of out.slice(-CHAT_MESSAGES).reverse()) {
    const text = m.text.length > CHAT_CHARS / 4 ? `${m.text.slice(0, CHAT_CHARS / 4)}\n… (cut here; the rest is in the chat)` : m.text
    if (chars + text.length > CHAT_CHARS) break
    chars += text.length
    kept.unshift({ ...m, text })
  }
  return kept
}
