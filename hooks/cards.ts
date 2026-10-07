import type { CardConfig, CardKind, CheckKind, Effort, FlowEdge, FlowNode, Graph } from '../types'

/**
 * The cards a flow is built from: agents (Claude chats) and the logic cards that
 * steer messages between them. Pure: what a card's outputs are, how it checks a
 * message, how it reads, and the upgrade of version-1 link rules into If cards.
 */

export const KINDS: { kind: CardKind; icon: string; label: string; blurb: string }[] = [
  { kind: 'agent', icon: '●', label: 'Agent', blurb: 'A Claude chat' },
  { kind: 'start', icon: '▶', label: 'Start', blurb: 'The command a run begins with' },
  { kind: 'if', icon: '◇', label: 'If / Else', blurb: 'Yes or no on a condition' },
  { kind: 'switch', icon: '⑂', label: 'Switch', blurb: 'Pick one named branch' },
  { kind: 'all', icon: '⧓', label: 'And (all)', blurb: 'Wait for every input' },
  { kind: 'first', icon: '⧗', label: 'Or (first)', blurb: 'Pass on the first reply' },
  { kind: 'prompt', icon: '✎', label: 'Prompt', blurb: 'Rewrite the message' },
  { kind: 'loop', icon: '↻', label: 'Loop until', blurb: 'Again until a condition holds' },
  { kind: 'model', icon: '◈', label: 'Model', blurb: "Set agents' model and effort" },
  { kind: 'end', icon: '■', label: 'End', blurb: 'Show and save the final answer' },
  { kind: 'note', icon: '✐', label: 'Note', blurb: 'A note for the team' },
]
export const meta = (k: CardKind) => KINDS.find(x => x.kind === k)!

export const kindOf = (n: Pick<FlowNode, 'kind'>): CardKind => n.kind ?? 'agent'
export const isAgent = (n: Pick<FlowNode, 'kind'>) => kindOf(n) === 'agent'

/** A card's outputs, top to bottom. */
export function portsOf(n: Pick<FlowNode, 'kind' | 'card'>): string[] {
  switch (kindOf(n)) {
    case 'if': return ['yes', 'no']
    case 'switch': return [...(n.card?.branches ?? []), 'other']
    case 'loop': return ['done', 'again']
    case 'end':
    case 'note': return []
    default: return ['out']
  }
}

export const portLabel = (port: string) =>
  ({ out: 'Out', yes: 'Yes', no: 'No', other: 'Other', done: 'Done', again: 'Again' })[port] ?? port

/** Rows a card takes on the canvas: name, summary, then one row per named output. */
export function cardHeight(n: Pick<FlowNode, 'kind' | 'card'>): number {
  const ports = portsOf(n)
  return ports.length > 1 ? 3 + ports.length + 1 : 6
}

/** The row, from the card's top, a link from `port` leaves at. */
export function portRow(n: Pick<FlowNode, 'kind' | 'card'>, port: string): number {
  const ports = portsOf(n)
  if (ports.length <= 1) return 2
  const i = ports.indexOf(port)
  return 3 + (i < 0 ? 0 : i)
}

/**
 * A new agent's name: `<prefix>-agent<N>`, N one past the highest such number in
 * any flow of the project, so chat names never collide (and the engine never adds
 * its random words) and a deleted agent's number is never handed out again.
 */
export function nextAgentName(flows: Pick<FlowNode, 'name'>[][], prefix: string): string {
  const numbers = flows.flat().map(n => /-agent(\d+)$/.exec(n.name)?.[1]).filter(Boolean).map(Number)
  return `${prefix}-agent${Math.max(0, ...numbers) + 1}`
}

export function newCard(kind: CardKind, id: string, x: number, y: number, agentName = 'agent'): FlowNode {
  const base = { id, x, y, prompt: '', mode: 'default' as const }
  switch (kind) {
    case 'agent': return { ...base, name: agentName }
    case 'start': return { ...base, kind, name: 'Start' }
    case 'if': return { ...base, kind, name: 'If', card: { check: 'judge', value: '' } }
    case 'switch': return { ...base, kind, name: 'Switch', card: { branches: ['A', 'B'] } }
    case 'all': return { ...base, kind, name: 'And' }
    case 'first': return { ...base, kind, name: 'Or' }
    case 'prompt': return { ...base, kind, name: 'Prompt', card: { template: '{{message}}' } }
    case 'loop': return { ...base, kind, name: 'Loop until', card: { check: 'judge', value: '', maxTries: 3 } }
    case 'end': return { ...base, kind, name: 'End', card: { saveTo: '' } }
    case 'note': return { ...base, kind, name: 'Note', card: { text: '' } }
    case 'model': return { ...base, kind, name: 'Model', card: {} }
  }
}

export type Ask = (prompt: string) => Promise<string>

/**
 * Checks a message against a card's condition: true or false, or null when
 * Claude's answer can't be read (the card then takes no / other / a failed try).
 */
export async function check(cfg: CardConfig, text: string, ask: Ask): Promise<boolean | null> {
  const value = (cfg.value ?? '').trim()
  const kind: CheckKind = cfg.check ?? 'judge'
  switch (kind) {
    case 'contains': return value !== '' && text.toLowerCase().includes(value.toLowerCase())
    case 'not-contains': return value === '' || !text.toLowerCase().includes(value.toLowerCase())
    case 'regex':
      try {
        return new RegExp(value, 'i').test(text)
      } catch {
        return false
      }
    case 'judge': {
      if (!value) return null
      const reply = await ask(
        `You are routing work between AI agents. Read the message below and decide whether this statement is true:\n\n` +
          `STATEMENT: ${value}\n\nMESSAGE:\n${text.slice(-12000)}\n\nAnswer with exactly one word: YES or NO.`,
      ).catch(() => '')
      if (/^\W*yes\b/i.test(reply)) return true
      if (/^\W*no\b/i.test(reply)) return false
      return null
    }
  }
}

/** The branch a Switch takes: one of its names, or `other` when none fits or the answer can't be read. */
export async function pickBranch(branches: string[], text: string, ask: Ask): Promise<string> {
  if (branches.length === 0) return 'other'
  const reply = await ask(
    `You are routing work between AI agents. Pick the one category the message below belongs to.\n\n` +
      `CATEGORIES:\n${branches.map(b => `- ${b}`).join('\n')}\n- other (none of these)\n\n` +
      `MESSAGE:\n${text.slice(-12000)}\n\nAnswer with the category's name exactly, nothing else.`,
  ).catch(() => '')
  const said = reply.trim().replace(/^[-*\s"']+|["'.\s]+$/g, '').toLowerCase()
  return branches.find(b => b.toLowerCase() === said) ?? branches.find(b => said.startsWith(b.toLowerCase())) ?? 'other'
}

export const fillPrompt = (template: string, vars: { message: string; from: string }) =>
  template.replaceAll('{{message}}', vars.message).replaceAll('{{from}}', vars.from)

/** And's combined message: each input's answer under its agent's name. */
export const combine = (entries: { from: string; text: string }[]) =>
  entries.map(e => `## From ${e.from}\n${e.text.trim()}`).join('\n\n')

/** A short line about what a card is set to, for the canvas. */
export function summaryOf(n: FlowNode, inputs: number): string {
  const c = n.card ?? {}
  const checkText = () =>
    !c.value ? 'Set its condition'
      : c.check === 'contains' ? `has "${c.value}"`
        : c.check === 'not-contains' ? `no "${c.value}"`
          : c.check === 'regex' ? `/${c.value}/`
            : `${c.value}?`
  switch (kindOf(n)) {
    case 'start': return n.prompt.trim() ? `"${n.prompt.trim().split('\n')[0]}"` : 'Write the command'
    case 'if': return checkText()
    case 'switch': return `${(c.branches ?? []).length} branches`
    case 'all': return `waits for all ${inputs}`
    case 'first': return `first of ${inputs}`
    case 'prompt': return (c.template ?? '').split('\n')[0] || 'Write the prompt'
    case 'loop': return `${checkText()} · ${c.maxTries ?? 3} tries`
    case 'end': return c.saveTo ? `saves to ${c.saveTo}` : 'The final answer'
    case 'note': return (c.text ?? '').split('\n')[0] || 'Write a note'
    case 'model': return c.model ? modelLabel(c.model, c.effort) : 'Pick a model'
    default: return ''
  }
}

/** Wiring that would leave a run stuck or a card unused, said on the card. */
export function warningsOf(g: Graph): Record<string, string> {
  const out: Record<string, string> = {}
  const outs = (id: string, port?: string) => g.edges.filter(e => e.from === id && (port === undefined || (e.port ?? 'out') === port))
  const ins = (id: string) => g.edges.filter(e => e.to === id)
  const cycles = cardCycles(g)
  for (const n of g.nodes) {
    const k = kindOf(n)
    if (cycles.has(n.id)) out[n.id] = 'Circles with no agent'
    else if (k === 'start' && outs(n.id).length === 0) out[n.id] = 'Link it to an agent'
    else if (k === 'start' && !n.prompt.trim()) out[n.id] = 'Write the command'
    else if (k === 'if' && n.name !== 'Else check' && (outs(n.id, 'yes').length === 0 || outs(n.id, 'no').length === 0))
      out[n.id] = outs(n.id, 'yes').length === 0 ? 'Nothing on Yes' : 'Nothing on No'
    else if (k === 'loop' && outs(n.id, 'again').length === 0) out[n.id] = 'Nothing on Again'
    else if (k === 'end' && outs(n.id).length > 0) out[n.id] = 'End passes nothing on'
    else if (k === 'all' && new Set(ins(n.id).map(e => e.from)).size < 2) out[n.id] = 'Needs 2+ inputs'
    else if ((k === 'if' || k === 'loop') && !n.card?.value?.trim()) out[n.id] = 'Set its condition'
    else if (k === 'switch' && (n.card?.branches ?? []).length === 0) out[n.id] = 'Add branches'
    else if (k === 'model' && !n.card?.model) out[n.id] = 'Pick a model'
    else if (k === 'model' && outs(n.id).length === 0) out[n.id] = 'Link it to an agent'
    else if (k !== 'note' && k !== 'start' && k !== 'model' && ins(n.id).length === 0 && k !== 'agent') out[n.id] = 'Nothing links in'
  }
  return out
}

/** The kinds of check a version-1 link rule carried. */
const RULES: Record<string, CheckKind> = { contains: 'contains', 'not-contains': 'not-contains', regex: 'regex', judge: 'judge' }

/**
 * Turns version-1 link rules into If cards, keeping what fired when:
 * - every rule link becomes agent → If (Yes → its old target), straight off the
 *   agent, so several matching rules all still fire;
 * - `else` links fired only when no rule matched: they leave the No of a chain of
 *   checks, one per rule (the chain's Yes outputs go nowhere);
 * - an agent with an `always` link never fired its `else` links: they're dropped,
 *   and so are links from an agent to itself, which version 1 ignored.
 * Ids come from the old links, so reading the same file twice gives the same cards.
 */
export function migrateV1(g: Graph): Graph {
  const nodes = [...g.nodes]
  const edges: FlowEdge[] = []
  const plain = (e: FlowEdge, over: Partial<FlowEdge>): FlowEdge => ({ ...e, cond: 'always', value: '', ...over })
  const bySource = new Map<string, FlowEdge[]>()
  for (const e of g.edges) if (e.from !== e.to) bySource.set(e.from, [...(bySource.get(e.from) ?? []), e])
  for (const [from, list] of bySource) {
    const src = nodes.find(n => n.id === from)
    const ifCard = (id: string, rule: FlowEdge, i: number, name = 'If'): FlowNode => ({
      id, name, kind: 'if', card: { check: RULES[rule.cond], value: rule.value },
      x: (src?.x ?? 0) + 34, y: (src?.y ?? 0) + i * 8, prompt: '', mode: 'default',
    })
    const rules = list.filter(e => RULES[e.cond])
    const hasAlways = list.some(e => e.cond === 'always')
    const elses = hasAlways ? [] : list.filter(e => e.cond === 'else')
    edges.push(...list.filter(e => e.cond === 'always').map(e => plain(e, {})))
    if (rules.length === 0) {
      edges.push(...elses.map(e => plain(e, {}))) // an else with no rule beside it always fired
      continue
    }
    rules.forEach((r, i) => {
      const card = ifCard(`${r.id}-if`, r, i)
      nodes.push(card)
      edges.push(plain(r, { id: `${r.id}-in`, to: card.id, template: '{{output}}' }))
      edges.push(plain(r, { from: card.id, port: 'yes' }))
    })
    if (elses.length === 0) continue
    if (rules.length === 1) {
      // One rule: its own If's No is exactly "no rule matched".
      for (const e of elses) edges.push(plain(e, { from: `${rules[0]!.id}-if`, port: 'no' }))
      continue
    }
    // Several rules: check each in turn; only past the last No did none match.
    const chain = rules.map((r, i) => ifCard(`${r.id}-else`, r, rules.length + i, 'Else check'))
    nodes.push(...chain)
    chain.forEach((c, i) => {
      const into = i === 0 ? { from, port: undefined } : { from: chain[i - 1]!.id, port: 'no' }
      edges.push({ id: `${c.id}-in`, ...into, to: c.id, cond: 'always', value: '', maxPasses: rules[i]!.maxPasses, template: '{{output}}' })
    })
    for (const e of elses) edges.push(plain(e, { from: chain[chain.length - 1]!.id, port: 'no' }))
  }
  return { nodes, edges }
}

/** Logic cards linked in a circle with no agent between: a message would go round forever. */
export function cardCycles(g: Graph): Set<string> {
  const logic = new Set(g.nodes.filter(n => !isAgent(n)).map(n => n.id))
  const next = (id: string) => g.edges.filter(e => e.from === id && logic.has(e.to)).map(e => e.to)
  const inCycle = new Set<string>()
  for (const start of logic) {
    const stack = [...next(start)]
    const seen = new Set<string>()
    while (stack.length) {
      const at = stack.pop()!
      if (at === start) {
        inCycle.add(start)
        break
      }
      if (seen.has(at)) continue
      seen.add(at)
      stack.push(...next(at))
    }
  }
  return inCycle
}

/**
 * The agents a card reaches through logic cards alone (never through another
 * agent): `out` follows links forward, `in` backward. Who an agent may message,
 * and who may message it.
 */
export function reachableAgents(g: Graph, id: string, dir: 'out' | 'in'): FlowNode[] {
  const seen = new Set<string>([id])
  const found = new Map<string, FlowNode>()
  const stack = [id]
  while (stack.length) {
    const at = stack.pop()!
    const next = g.edges.filter(e => (dir === 'out' ? e.from === at : e.to === at)).map(e => (dir === 'out' ? e.to : e.from))
    for (const nid of next) {
      if (seen.has(nid)) continue
      seen.add(nid)
      const n = g.nodes.find(x => x.id === nid)
      if (!n) continue
      if (isAgent(n)) found.set(n.id, n)
      else stack.push(n.id)
    }
  }
  return [...found.values()]
}

export const EFFORTS: { effort: Effort; label: string }[] = [
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra high' },
  { effort: 'max', label: 'Max' },
]

/** A model's id without the `claude-` every one of them starts with, and its effort: `sonnet-5-5 · high`. */
export const modelLabel = (model: string, effort?: Effort) => model.replace(/^claude-/, '') + (effort ? ` · ${effort}` : '')

export type ModelChoice = { model: string; effort?: Effort }

/**
 * The model an agent runs with: the settings of the Model card linked into it, or
 * null for the person's default (none linked, or one with no model picked yet).
 * A link from a Model card is a model link; Model cards take no input, so no
 * message ever travels one.
 */
export function modelFor(g: Graph, agentId: string): ModelChoice | null {
  for (const e of g.edges) {
    if (e.to !== agentId) continue
    const from = g.nodes.find(n => n.id === e.from)
    if (from && kindOf(from) === 'model' && from.card?.model) {
      return { model: from.card.model, ...(from.card.effort ? { effort: from.card.effort } : {}) }
    }
  }
  return null
}

/** What `claude` is started with for a model choice. */
export const modelArgs = (c: ModelChoice | null): string[] =>
  c ? ['--model', c.model, ...(c.effort ? ['--effort', c.effort] : [])] : []

/**
 * A model id as the CLI or a gateway spells it (`opus`, `claude-opus-5-5`,
 * `us.anthropic.…[1m]`, `anthropic/claude-…`, `claude-…@20250514`), never a flag:
 * it goes to `claude --model`.
 */
export const isModelId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:@\[\]][\w.:@/\-\[\]]{0,99}$/.test(v)

/**
 * The models a Model card lists: the CLI's aliases, which any Claude account runs,
 * then the ids in the plugin's "Extra models" option (separated by commas or
 * spaces), for a gateway or a pinned version. `bad` holds the entries that are not
 * model ids and were left out.
 */
export function modelChoices(extra = ''): { ids: string[]; bad: string[] } {
  const typed = extra.split(/[\s,]+/).filter(Boolean)
  return { ids: [...new Set([...MODEL_ALIASES, ...typed.filter(isModelId)])], bad: typed.filter(t => !isModelId(t)) }
}

/** The CLI's own aliases: what any Claude account runs. */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku']
