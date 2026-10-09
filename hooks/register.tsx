import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  cardHeight,
  check,
  combine,
  EFFORTS,
  fillPrompt,
  isAgent,
  isModelId,
  kindOf,
  MODEL_ALIASES,
  modelArgs,
  modelChoices,
  modelFor,
  modelLabel,
  newCard,
  nextAgentName,
  pickBranch,
  portsOf,
  reachableAgents,
  summaryOf,
  warningsOf,
} from './cards'
import {
  applyLive,
  CARD,
  composeInstructions,
  fillTemplate,
  instructionRefs,
  matchRecipient,
  parseChat,
  parseStreamLine,
  parseTranscript,
  peerSection,
  previewOf,
  resolveRef,
  shellQuote,
  startLive,
  surfaceForTty,
} from './flow'
import {
  fileFor,
  findSelf,
  flowsDir,
  indexPath,
  loadProject,
  parseFlow,
  readIndex,
  saveFlow,
  slug,
  syncIndex,
} from './store'
import { chatsUnder, folderRows, parentOf, resolveDir, showPath } from './picker'
import type { RefFile } from './flow'
import type { Io } from './store'
import type {
  AvailableSession,
  CanvasBatch,
  CanvasMessage,
  ChatView,
  CanvasProps,
  CardConfig,
  CardKind,
  CardPatch,
  FlowDoc,
  FlowEdge,
  FlowNode,
  FlowSummary,
  Graph,
  ModelList,
  NodeRun,
  PickerView,
  RunStatus,
  Selection,
} from '../types'

const PANE = 'agent-flows'
const DEFAULT_TEMPLATE = 'Message from agent "{{from}}":\n\n{{output}}'

const flowsA = atom({ plugin: 'agent-flows', key: 'flows' } as const, {} as Record<string, FlowDoc>)
const openA = atom({ plugin: 'agent-flows', key: 'openFlow' } as const, null as string | null)
const brokenA = atom({ plugin: 'agent-flows', key: 'broken' } as const, [] as string[])
const selA = atom({ plugin: 'agent-flows', key: 'sel' } as const, { kind: 'none' } as Selection)
const runsA = atom({ plugin: 'agent-flows', key: 'runs' } as const, {} as Record<string, NodeRun>)
const connectA = atom({ plugin: 'agent-flows', key: 'connectFrom' } as const, null as string | null)
const logA = atom({ plugin: 'agent-flows', key: 'log' } as const, [] as string[])
const pickerA = atom({ plugin: 'agent-flows', key: 'picker' } as const, null as PickerView | null)
const liveA = atom({ plugin: 'agent-flows', key: 'liveIds' } as const, [] as string[])
const portA = atom({ plugin: 'agent-flows', key: 'connectPort' } as const, 'out')
const resultsA = atom({ plugin: 'agent-flows', key: 'results' } as const, {} as Record<string, { text: string; at: number }>)
const waitingA = atom({ plugin: 'agent-flows', key: 'waiting' } as const, {} as Record<string, { got: number; of: number }>)
const modelsA = atom({ plugin: 'agent-flows', key: 'models' } as const, null as ModelList | null)
const pasteA = atom({ plugin: 'agent-flows', key: 'paste' } as const, null as { seq: number; text: string } | null)
const chatA = atom({ plugin: 'agent-flows', key: 'chat' } as const, null as ChatView | null)

/** The last message taken in, per canvas: `sender` is the canvas's, fresh each time it loads. */
const lastSeq = new Map<string, number>()

/**
 * The canvas's messages in a post not yet taken in. A post the canvas makes in the
 * same frame as another replaces it, so each post carries the last few, numbered.
 */
function unseen(data: unknown): CanvasMessage[] {
  const b = data as CanvasBatch | null
  if (b?.t !== 'batch' || typeof b.sender !== 'string' || !Array.isArray(b.items)) return []
  const after = lastSeq.get(b.sender) ?? 0
  const fresh = b.items.filter(i => typeof i?.seq === 'number' && i.seq > after).sort((x, y) => x.seq - y.seq)
  if (fresh.length) lastSeq.set(b.sender, fresh[fresh.length - 1]!.seq)
  return fresh.map(i => i.m)
}

const IDLE: NodeRun = { status: 'idle', preview: [], lastOutput: '' }

const CHECKS = ['judge', 'contains', 'not-contains', 'regex'] as const
/** A link's handle on the canvas: click it to edit or delete the link. */
const LINK_HANDLE = '◆'

const shortId = () => crypto.randomUUID().slice(0, 8)

// Run bookkeeping: lives as long as this load of the code.
const live = new Map<string, AsyncIterator<unknown>>()
const queue = new Map<string, { prompt: string; hop: number; run: string }[]>()
/**
 * Every hand-off message starts with this tag: the run it belongs to, and the
 * hand-offs made in it so far. Each chat reads it off the message that started its
 * turn, so a loop stops at a link's max passes in any process, canvas open or not,
 * and And / Or / Loop cards keep their memory per run.
 */
const TAG_RE = /\[Agent Flows · (?:run ([\w-]+) · )?hand-off (\d+)\]/g
const hopTag = (run: string, n: number) => `[Agent Flows · run ${run} · hand-off ${n}]`
/** The tag with the highest count anywhere in a message: the engine wraps a peer's text in an envelope. */
function tagOf(text: string): { run: string | null; hop: number } {
  let best: { run: string | null; hop: number } = { run: null, hop: 0 }
  for (const m of text.matchAll(TAG_RE)) if (Number(m[2]) >= best.hop) best = { run: m[1] ?? null, hop: Number(m[2]) }
  return best
}
const hopOf = (text: string) => tagOf(text).hop
const newRunId = () => crypto.randomUUID().slice(0, 6)
/** What an agent answers when a hand-off needs no response: nothing is handed on. */
const NO_REPLY_RE = /^\s*\[no reply\]\s*$/i
/** Hand-offs one chat makes between two of its person's messages, whatever the links say. */
const MAX_HANDOFFS_PER_CHAT = 20
/** Hand-offs in one run, whatever its links say: the runaway backstop. */
const MAX_HOPS = 50
/** Each flow file's modified-time as this window last wrote or read it. */
const known = new Map<string, number>()
/** Flow files made in this window and not yet saved (or whose save failed): the watcher keeps them. */
const unsaved = new Set<string>()
/** The tail of each flow file's save queue: one change at a time per file. */
const saving = new Map<string, Promise<void>>()

/** Runs `job` after every earlier job on `file`. */
function serial(file: string, job: () => Promise<void>): Promise<void> {
  const run = (saving.get(file) ?? Promise.resolve()).then(job)
  const tail = run.catch(() => {})
  saving.set(file, tail)
  void tail.then(() => {
    if (saving.get(file) === tail) saving.delete(file)
  })
  return run
}

function io($: EngineInterface): Io {
  const done = (r: { exitCode: number; stderr: string }, what: string) => {
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `${what} exited ${r.exitCode}`)
  }
  return {
    read: p => $.fs.read(p),
    write: (p, t) => $.fs.write(p, t),
    list: async dir => (await $.fs.list(dir)).map(e => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs })),
    exists: p => $.fs.exists(p),
    move: async (from, to) => done(await $.process.run(['mv', '-f', from, to]), 'mv'),
    remove: async p => done(await $.process.run(['rm', '-f', p]), 'rm'),
  }
}

const home = async ($: EngineInterface) => (await $.env.get('HOME')) ?? ''

const log = ($: EngineInterface, line: string) =>
  update($, logA, l => [...l, `${new Date().toLocaleTimeString()}  ${line}`].slice(-50))

const setRun = ($: EngineInterface, id: string, fn: (r: NodeRun) => NodeRun) =>
  update($, runsA, all => ({ ...all, [id]: fn(all[id] ?? IDLE) }))

// ---------- flows ----------

/** The flow that holds an agent, and the agent. */
async function locate($: EngineInterface, nodeId: string) {
  for (const flow of Object.values(await read($, flowsA))) {
    const node = flow.nodes.find(n => n.id === nodeId)
    if (node) return { flow, node }
  }
  return null
}

const openFlow = async ($: EngineInterface) => {
  const id = await read($, openA)
  return id ? (await read($, flowsA))[id] ?? null : null
}

const mtimeOf = ($: EngineInterface, path: string) => $.fs.stat(path).then(s => s.mtimeMs, () => null)

/** Saves one flow and its index entries; a failure is said, and the edit stays in memory. Call inside `serial`. */
async function persist($: EngineInterface, flow: FlowDoc) {
  const fs = io($)
  try {
    await saveFlow(fs, flow)
    known.set(flow.file, (await mtimeOf($, flow.file)) ?? 0)
    unsaved.delete(flow.file)
  } catch (err) {
    unsaved.add(flow.file)
    $.ui.toast(`Couldn't save "${flow.name}": ${String(err)}`)
    return
  }
  await syncIndex(fs, indexPath(await home($)), flow.file, flow).catch(err =>
    log($, `⚠ couldn't update the agent index: ${String(err)}`),
  )
}

/**
 * Another window (or a run whose pane closed) may have saved this flow since this
 * window read it: take the file's version first, so the edit lands on top of it.
 */
async function refreshFromDisk($: EngineInterface, flowId: string) {
  const flow = (await read($, flowsA))[flowId]
  if (!flow) return
  const mtime = await mtimeOf($, flow.file)
  if (mtime === null || mtime === known.get(flow.file)) return
  const disk = await io($).read(flow.file).then(t => parseFlow(t, flow.file), () => null)
  known.set(flow.file, mtime)
  if (disk && disk.id === flowId) await update($, flowsA, all => ({ ...all, [flowId]: disk }))
}

async function mutateFlow($: EngineInterface, flowId: string, fn: (f: FlowDoc) => FlowDoc) {
  const first = (await read($, flowsA))[flowId]
  if (!first) return
  await serial(first.file, async () => {
    await refreshFromDisk($, flowId)
    await update($, flowsA, all => (all[flowId] ? { ...all, [flowId]: fn(all[flowId]!) } : all))
    const flow = (await read($, flowsA))[flowId]
    if (flow) await persist($, flow)
  })
}

/** Applies `fn` to the flow holding `nodeId`. */
async function mutateNodeFlow($: EngineInterface, nodeId: string, fn: (f: FlowDoc) => FlowDoc) {
  const found = await locate($, nodeId)
  if (found) await mutateFlow($, found.flow.id, fn)
}

async function newFlow($: EngineInterface, name?: string, graph?: Graph) {
  const root = await $.session.root()
  const all = await read($, flowsA)
  const id = shortId()
  const title = name ?? `Flow ${Object.keys(all).length + 1}`
  // A name another window saved a moment ago is taken too, not only the ones in memory.
  const taken = new Set([...Object.values(all).map(f => f.file), ...(await read($, brokenA))])
  let file = fileFor(flowsDir(root), title, id, taken)
  while (await io($).exists(file)) {
    taken.add(file)
    file = fileFor(flowsDir(root), `${title} ${shortId()}`, id, taken)
  }
  const flow: FlowDoc = { id, name: title, nodes: graph?.nodes ?? [], edges: graph?.edges ?? [], file }
  unsaved.add(file)
  await update($, flowsA, a => ({ ...a, [id]: flow }))
  await update($, openA, () => id)
  await update($, selA, () => ({ kind: 'none' }))
  await serial(file, () => persist($, flow))
  return flow
}

async function deleteFlow($: EngineInterface, flowId: string) {
  const flow = (await read($, flowsA))[flowId]
  if (!flow) return
  for (const n of flow.nodes) await stop($, n.id)
  let isDeleted = false
  // After any save in flight, so a late save can't bring the file back.
  await serial(flow.file, async () => {
    try {
      await io($).remove(flow.file)
      isDeleted = true
    } catch (err) {
      $.ui.toast(`Couldn't delete "${flow.name}": ${String(err)}`)
    }
  })
  if (!isDeleted) return
  known.delete(flow.file)
  unsaved.delete(flow.file)
  await syncIndex(io($), indexPath(await home($)), flow.file, null).catch(() => {})
  await $.process.run(['find', runsDir(flow), '-maxdepth', '1', '-name', `${flow.id}-*`, '-exec', 'rm', '-rf', '{}', '+']).catch(() => {})
  await update($, flowsA, a => {
    const { [flowId]: _gone, ...rest } = a
    return rest
  })
  const left = Object.values(await read($, flowsA))
  await update($, openA, () => left[0]?.id ?? null)
  await update($, selA, () => ({ kind: 'none' }))
  await log($, `✕ deleted flow ${flow.name}`)
}

/**
 * Reads the project's flows from disk. With `onlyChanged` (the watcher), a flow whose
 * file is as this window last saw it keeps its in-memory copy, so nothing redraws.
 */
async function loadFlows($: EngineInterface, onlyChanged = false) {
  const root = await $.session.root()
  const project = await loadProject(io($), root).catch(() => ({ flows: [], broken: [], mtimes: {} as Record<string, number> }))
  const current = await read($, flowsA)
  const byFile = new Map(Object.values(current).map(f => [f.file, f]))
  const next: Record<string, FlowDoc> = {}
  let changed = !onlyChanged
  for (const flow of project.flows) {
    const mine = byFile.get(flow.file)
    // A save in flight owns the file; the queue reads it fresh before its next change.
    const isMineCurrent = mine && (saving.has(flow.file) || known.get(flow.file) === project.mtimes[flow.file])
    if (onlyChanged && isMineCurrent) next[mine.id] = mine
    else {
      next[flow.id] = flow
      changed = true
      known.set(flow.file, project.mtimes[flow.file] ?? 0)
    }
  }
  // Flows not on disk yet (just made, or a failed save) stay; the rest left the folder.
  for (const f of Object.values(current)) {
    if (!next[f.id] && (unsaved.has(f.file) || saving.has(f.file))) next[f.id] = f
  }
  if (Object.keys(next).length !== Object.keys(current).length) changed = true
  if (changed) await update($, flowsA, () => next)
  const broken = project.broken.sort()
  if (broken.join() !== (await read($, brokenA)).join()) await update($, brokenA, () => broken)
  const open = await read($, openA)
  if (!open || !next[open]) await update($, openA, () => Object.keys(next)[0] ?? null)
}

// ---------- running agents ----------

/** Gives an agent a chat id the first time it needs one; returns it with whether it is new. */
async function ensureSession($: EngineInterface, id: string) {
  const found = await locate($, id)
  if (!found) return null
  if (found.node.sessionId) return { sessionId: found.node.sessionId, isNew: false }
  const sessionId = crypto.randomUUID()
  await mutateFlow($, found.flow.id, f => ({ ...f, nodes: f.nodes.map(n => (n.id === id ? { ...n, sessionId } : n)) }))
  return { sessionId, isNew: true }
}

/**
 * Gives an agent a message: into its chat when that is open (the chat hands its
 * reply on itself when the turn ends), else as a background run whose reply this
 * window hands on. `hop` is the hand-off count the message carries.
 */
async function runNode($: EngineInterface, id: string, prompt: string, hop = 0, run = newRunId()): Promise<void> {
  const found = await locate($, id)
  if (!found || !isAgent(found.node)) return
  const { node } = found
  if (live.has(id)) {
    queue.set(id, [...(queue.get(id) ?? []), { prompt, hop, run }])
    await setRun($, id, r => ({ ...r, status: 'queued' }))
    return
  }
  const session = await ensureSession($, id)
  if (!session) return
  // Open in a tab: hand it the message there, so the person sees it and it answers in
  // place. Only when it is running: a closed chat would keep the message unread.
  const isOpen = !session.isNew && (await runningSessions($)).some(r => r.sessionId === session.sessionId)
  if (isOpen) {
    const sent = await $.session.send({ to: { sessionId: session.sessionId }, text: prompt })
    if (sent.isDelivered) {
      await setRun($, id, r => ({ ...r, status: 'running', preview: [...r.preview, '▸ ' + prompt.split('\n')[0]].slice(-6) }))
      await log($, `✉ ${node.name} (open chat)`)
      return
    }
  }
  const exists = !session.isNew && !!(await findTranscript($, session.sessionId))
  // The mod is installed for the user, so the child loads it (and its links) itself.
  const argv = [
    'claude', '-p',
    ...(exists ? ['--resume', session.sessionId] : ['--session-id', session.sessionId]),
    // Partial messages: the card shows the reply as it is written, not once it is done.
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', node.mode,
    ...modelArgs(modelFor(found.flow, id)),
  ]
  let liveView = startLive('▸ ' + prompt.split('\n')[0])
  await setRun($, id, () => ({ status: 'running', preview: previewOf(liveView), lastOutput: '' }))
  await log($, `▶ ${node.name}`)
  // Text arrives a few words at a time: the card is redrawn at most every PREVIEW_MS.
  let shownAt = 0
  const show = async (now: boolean) => {
    const at = Date.now()
    if (!now && at - shownAt < PREVIEW_MS) return
    shownAt = at
    await setRun($, id, r => ({ ...r, preview: previewOf(liveView), thinking: liveView.thinking }))
  }

  // AGENT_FLOWS_CHILD: the child leaves handing its reply on to this window.
  const child = $.process.spawn({ argv, cwd: node.cwd ?? (await $.session.root()), input: prompt, env: { AGENT_FLOWS_CHILD: '1' } })
  live.set(id, child[Symbol.asyncIterator]())
  let buffer = ''
  let output = ''
  let isError = false
  let ended: { code: number | null; signal: string | null } | undefined
  try {
    while (true) {
      const step = await child.next()
      if (step.done) { ended = step.value; break }
      if (step.value.stream === 'stderr') continue
      buffer += step.value.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseStreamLine(line)
        if (!parsed) continue
        if (parsed.kind === 'result') {
          output = parsed.text
          isError = parsed.isError
          continue
        }
        const before = liveView.phase
        liveView = applyLive(liveView, parsed)
        // A change of what it's doing shows at once; text as it streams, throttled.
        await show(liveView.phase !== before || parsed.kind === 'preview')
      }
    }
  } catch (err) {
    isError = true
    output = String(err)
  } finally {
    live.delete(id)
  }

  await show(true)
  const wasStopped = ended?.signal != null && !output
  const status = wasStopped ? 'stopped' : isError || (ended && ended.code !== 0 && !output) ? 'error' : 'done'
  await setRun($, id, r => ({ ...r, status, lastOutput: output }))
  await log($, `${status === 'done' ? '✓' : '✕'} ${node.name} ${status}`)

  if (status === 'done') {
    const now = await locate($, id)
    if (now) await handOff($, now.flow, now.node, output, hop, run)
  }

  const next = queue.get(id)?.shift()
  if (next !== undefined) void runNode($, id, next.prompt, next.hop, next.run).catch(err => log($, `⚠ ${node.name}: ${String(err)}`))
}

/** A message on its way through a flow's cards. `raw`: deliver `text` as is, not through the link's template. */
type Msg = { text: string; from: string; run: string; hop: number; raw?: boolean }

/** A relative path inside `root`, or null: no absolute paths, no `..`, no `~`. */
function insideProject(root: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.startsWith('~') || rel.includes('\\')) return null
  const parts = rel.split('/').filter(p => p && p !== '.')
  if (parts.length === 0 || parts.some(p => p === '..')) return null
  return `${root}/${parts.join('/')}`
}

const projectOf = (flow: FlowDoc) => flow.file.slice(0, flow.file.lastIndexOf('/.claude/flows/'))
const runsDir = (flow: FlowDoc) => `${flow.file.slice(0, flow.file.lastIndexOf('/'))}/.runs`
const runDir = (flow: FlowDoc, run: string) => `${runsDir(flow)}/${flow.id}-${run}`

/** Takes a lock shared by every process: `mkdir` succeeds for exactly one of them. */
async function takeLock($: EngineInterface, path: string) {
  await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
  return (await $.process.run(['mkdir', path])).exitCode === 0
}

/**
 * Passes an agent's finished reply on from its output, through the cards after
 * it. `[no reply]` and empty replies stop here.
 */
async function handOff($: EngineInterface, flow: FlowDoc, from: FlowNode, output: string, hop: number, run: string) {
  if (!output.trim() || NO_REPLY_RE.test(output)) return
  // This window runs the targets from the flow as just read from disk, so a card added
  // since its last hand-off is found; unless it holds edits of its own not saved yet.
  if (!(await read($, flowsA))[flow.id] || (!unsaved.has(flow.file) && !saving.has(flow.file))) {
    known.set(flow.file, (await mtimeOf($, flow.file)) ?? 0)
    await update($, flowsA, all => ({ ...all, [flow.id]: flow }))
  }
  await emit($, flow, from.id, 'out', { text: output, from: from.name, run, hop })
}

/**
 * Sends `msg` along every link leaving `fromId` by `port`. `seen`: the logic cards
 * this walk has passed; one met again is a circle with no agent, and stops there.
 */
async function emit($: EngineInterface, flow: FlowDoc, fromId: string, port: string, msg: Msg, seen: Set<string> = new Set()) {
  for (const edge of flow.edges.filter(e => e.from === fromId && (e.port ?? 'out') === port)) {
    await enter($, flow, edge, msg, seen).catch(err => log($, `⚠ ${flow.name}: ${String(err)}`))
  }
}

/** A message arriving at a card by `edge`: what the card does with it. */
async function enter($: EngineInterface, flow: FlowDoc, edge: FlowEdge, msg: Msg, seen: Set<string>) {
  const card = flow.nodes.find(n => n.id === edge.to)
  if (!card) return
  if (!isAgent(card)) {
    if (seen.has(card.id)) return log($, `⚠ ${flow.name}: ${card.name} is in a circle of cards with no agent; stopped there`)
    seen = new Set(seen).add(card.id)
  }
  const depth = seen
  const cfg: CardConfig = card.card ?? {}
  const ask = (q: string) => judge($, q)
  const dir = runDir(flow, msg.run)
  switch (kindOf(card)) {
    case 'agent': {
      // The link's own passes in this run, counted across processes: one lock folder each.
      let nth = 1
      while (nth <= edge.maxPasses && !(await takeLock($, `${dir}/link-${edge.id}-n${nth}`))) nth++
      if (nth > edge.maxPasses || msg.hop >= MAX_HOPS) {
        await log($, `⟲ → ${card.name} stopped: the link's max passes (${edge.maxPasses}) reached in this run`)
        return
      }
      const body = await withInstructions($, flow, card, msg.raw ? msg.text : fillTemplate(edge.template, { output: msg.text, from: msg.from }))
      await log($, `→ ${msg.from} → ${card.name}`)
      void runNode($, card.id, `${hopTag(msg.run, msg.hop + 1)}\n${body}`, msg.hop + 1, msg.run).catch(err =>
        log($, `⚠ couldn't hand off to ${card.name}: ${String(err)}`),
      )
      return
    }
    case 'if': {
      const ok = await check(cfg, msg.text, ask)
      if (ok === null) await log($, `⚠ ${card.name}: couldn't judge "${cfg.value ?? ''}"; took No`)
      await log($, `◇ ${card.name}: ${ok ? 'Yes' : 'No'}`)
      return emit($, flow, card.id, ok ? 'yes' : 'no', msg, depth)
    }
    case 'switch': {
      const branch = await pickBranch(cfg.branches ?? [], msg.text, ask)
      await log($, `⑂ ${card.name}: ${branch}`)
      return emit($, flow, card.id, branch, msg, depth)
    }
    case 'prompt':
      return emit($, flow, card.id, 'out', { ...msg, text: fillPrompt(cfg.template ?? '{{message}}', { message: msg.text, from: msg.from }), raw: true }, depth)
    case 'loop': {
      // Tries are counted across processes: one lock folder per try.
      let tries = 1
      while (tries < 100 && !(await takeLock($, `${dir}/loop-${card.id}-try-${tries}`))) tries++
      const ok = await check(cfg, msg.text, ask)
      if (ok === null) await log($, `⚠ ${card.name}: couldn't judge "${cfg.value ?? ''}"; counted as a failed try`)
      const isDone = ok === true || tries >= (cfg.maxTries ?? 3)
      await log($, `↻ ${card.name}: ${isDone ? (ok ? 'done' : `done after ${tries} tries`) : `again (try ${tries})`}`)
      return emit($, flow, card.id, isDone ? 'done' : 'again', msg, depth)
    }
    case 'all': {
      const inputs = [...new Set(flow.edges.filter(e => e.to === card.id).map(e => e.from))]
      const { round, got } = await arrive($, `${dir}/all-${card.id}`, edge.from, msg)
      await update($, waitingA, w => ({ ...w, [card.id]: { got: inputs.filter(i => got.includes(i)).length, of: inputs.length } }))
      if (!inputs.every(i => got.includes(i))) return
      if (!(await takeLock($, `${dir}/all-${card.id}/r${round}.fired`))) return
      return passAll($, flow, card, msg.run, round, depth)
    }
    case 'first': {
      // The first arrival of each round passes; the round's later ones are dropped.
      const { round } = await arrive($, `${dir}/first-${card.id}`, edge.from, msg)
      if (!(await takeLock($, `${dir}/first-${card.id}/r${round}.fired`))) return
      return emit($, flow, card.id, 'out', msg, depth)
    }
    case 'end': {
      const at = Date.now() // wall-clock time, shared by every process reading the result
      await $.fs.write(`${dir}/end-${card.id}.json`, JSON.stringify({ text: msg.text, from: msg.from, at }))
      const save = (cfg.saveTo ?? '').trim()
      const path = save ? insideProject(projectOf(flow), save) : null
      if (save && !path) await log($, `⚠ ${card.name}: "${save}" isn't a path inside the project; not saved`)
      if (path) await $.fs.write(path, msg.text.endsWith('\n') ? msg.text : msg.text + '\n').catch(err => log($, `⚠ ${card.name}: couldn't save ${save}: ${String(err)}`))
      await update($, resultsA, r => ({ ...r, [card.id]: { text: msg.text, at } }))
      await log($, `■ ${flow.name}: finished at ${card.name}${path ? ` · saved ${save}` : ''}`)
      $.ui.toast(`Run finished: ${flow.name}${path ? ` (saved to ${save})` : ''}`)
      return
    }
    default:
      return // start and note take no input
  }
}

/**
 * Files an arrival at And or Or under its round: the first round this input hasn't
 * reached yet. A loop that comes back round fills the next round, so the card works
 * again each time round. Returns the round and the inputs in it so far.
 */
async function arrive($: EngineInterface, base: string, from: string, msg: Msg) {
  let round = 1
  while (round < 100 && (await $.fs.exists(`${base}/r${round}/${from}.json`))) round++
  await $.fs.write(`${base}/r${round}/${from}.json`, JSON.stringify({ from: msg.from, text: msg.text, hop: msg.hop }))
  const got = (await $.fs.list(`${base}/r${round}`).catch(() => [])).filter(f => f.name.endsWith('.json')).map(f => f.name.replace(/\.json$/, ''))
  return { round, got }
}

/** And passes on what each input sent in a round of `run`, under each agent's name. */
async function passAll($: EngineInterface, flow: FlowDoc, card: FlowNode, run: string, round: number, depth: Set<string> = new Set()) {
  const folder = `${runDir(flow, run)}/all-${card.id}/r${round}`
  const entries: { from: string; text: string; hop: number }[] = []
  for (const f of (await $.fs.list(folder).catch(() => [])).filter(f => f.name.endsWith('.json'))) {
    const e = await $.fs.read(`${folder}/${f.name}`).then(t => JSON.parse(t), () => null)
    if (e && typeof e.text === 'string') entries.push({ from: String(e.from ?? '?'), text: e.text, hop: Number(e.hop ?? 0) })
  }
  if (entries.length === 0) return
  await log($, `⧓ ${card.name}: passing on ${entries.length} answers`)
  const hop = Math.max(...entries.map(e => e.hop))
  await emit($, flow, card.id, 'out', { text: combine(entries), from: card.name, run, hop, raw: true }, depth)
}

/** The newest run folders of a flow, newest first. */
async function latestRuns($: EngineInterface, flow: FlowDoc) {
  const all = await $.fs.list(runsDir(flow)).catch(() => [])
  const mine = all.filter(e => e.name.startsWith(`${flow.id}-`))
  const stamped = await Promise.all(mine.map(async e => ({ run: e.name.slice(flow.id.length + 1), at: (await mtimeOf($, `${runsDir(flow)}/${e.name}`)) ?? 0 })))
  return stamped.sort((a, b) => b.at - a.at).map(r => r.run)
}

/** And's Pass on now: what has arrived in the latest run that hasn't fired. */
async function flushAll($: EngineInterface, cardId: string) {
  const found = await locate($, cardId)
  if (!found) return
  for (const run of await latestRuns($, found.flow)) {
    const base = `${runDir(found.flow, run)}/all-${cardId}`
    if (!(await $.fs.exists(base))) continue
    // The round still waiting: the first that hasn't fired.
    let round = 1
    while (round < 100 && (await $.fs.exists(`${base}/r${round}.fired`))) round++
    if (!(await $.fs.exists(`${base}/r${round}`))) return void $.ui.toast(`${found.node.name} has nothing waiting.`)
    if (!(await takeLock($, `${base}/r${round}.fired`))) return void $.ui.toast(`${found.node.name} already passed this on.`)
    return passAll($, found.flow, found.node, run, round)
  }
  $.ui.toast(`${found.node.name} has nothing waiting.`)
}

async function judge($: EngineInterface, prompt: string) {
  const r = await $.model.complete({ model: 'haiku', prompt, effort: 'low', timeoutMs: 30000 })
  return r.isAnswered ? r.text : ''
}

// Chats opened in a tab write only their transcript, so the canvas follows them by
// reading its tail. Runs the canvas started stream instead.
const WATCH_MS = 2000
/** How often a running chat's transcript (and an open chat view's) is checked for news. */
const ACTIVE_MS = 500
/** How often a background run's card is redrawn while its reply streams in. */
const PREVIEW_MS = 250
const STALE_MS = 120000
const transcriptPath = new Map<string, string>()
const lastSeen = new Map<string, string>()
/** When a chat's transcript was last looked for and not found; `find` waits before trying again. */
const missedAt = new Map<string, number>()
const MISS_RETRY_MS = 30000
let watcher: { cancel(): void } | null = null
let quickWatcher: { cancel(): void } | null = null
let isWatching = false
/** A full tick found a quick one going: the next quick tick steps aside for it. */
let fullPending = false

async function findTranscript($: EngineInterface, sessionId: string) {
  const cached = transcriptPath.get(sessionId)
  if (cached) return cached
  const now = await $.clock.now()
  if (now - (missedAt.get(sessionId) ?? -Infinity) < MISS_RETRY_MS) return null
  const r = await $.process.run(['find', `${await home($)}/.claude/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`])
  const path = r.stdout.trim().split('\n')[0]
  if (path) transcriptPath.set(sessionId, path)
  else missedAt.set(sessionId, now)
  return path || null
}

/** One watcher tick: flow files changed elsewhere, open chats, and every agent's latest turn. */
async function watch($: EngineInterface) {
  // The last tick is still going: a quick one yields to this one next time.
  if (isWatching) return void (fullPending = true)
  fullPending = false
  isWatching = true
  try {
    await watchOnce($)
  } finally {
    isWatching = false
  }
}

async function watchOnce($: EngineInterface) {
  await loadFlows($, true)
  await refreshLive($)
  await watchRuns($)
  for (const flow of Object.values(await read($, flowsA))) {
    for (const node of flow.nodes) {
      if (!node.sessionId || live.has(node.id)) continue
      const path = await findTranscript($, node.sessionId)
      if (!path) continue
      const stat = await $.fs.stat(path)
      const sig = `${stat.mtimeMs}:${stat.size}`
      const wasRunning = (await read($, runsA))[node.id]?.status === 'running'
      if (lastSeen.get(node.id) === sig && !wasRunning) continue
      lastSeen.set(node.id, sig)
      const tail = await $.process.run(['tail', '-n', '300', path])
      const view = parseTranscript(tail.stdout, (await $.clock.now()) - stat.mtimeMs > STALE_MS)
      if (view) await setRun($, node.id, r => ({ ...r, ...view }))
    }
  }
}

/**
 * The quick tick, between full ones: a chat with a turn going, and the chat being
 * read on the canvas, are re-read as soon as their transcript changes.
 */
async function watchActive($: EngineInterface) {
  if (isWatching || fullPending) return
  isWatching = true
  try {
    const runs = await read($, runsA)
    for (const flow of Object.values(await read($, flowsA))) {
      for (const node of flow.nodes) {
        if (!node.sessionId || live.has(node.id) || runs[node.id]?.status !== 'running') continue
        const path = await findTranscript($, node.sessionId)
        if (!path) continue
        const stat = await $.fs.stat(path)
        const sig = `${stat.mtimeMs}:${stat.size}`
        if (lastSeen.get(node.id) === sig) continue
        lastSeen.set(node.id, sig)
        const tail = await $.process.run(['tail', '-n', '300', path])
        const view = parseTranscript(tail.stdout, false)
        if (view) await setRun($, node.id, r => ({ ...r, ...view }))
      }
    }
    const chat = await read($, chatA)
    if (chat) await loadChat($, chat.id, true)
  } finally {
    isWatching = false
  }
}

/** The chat view's transcript, as last read: re-read only once it changes. */
let chatSeen = ''

/** Reads an agent's chat into the chat view; `ifChanged` skips an unchanged transcript. */
async function loadChat($: EngineInterface, id: string, ifChanged = false) {
  const found = await locate($, id)
  if (!found || !isAgent(found.node)) return void (await update($, chatA, () => null))
  const { node } = found
  const status = (await read($, runsA))[id]?.status ?? 'idle'
  // A re-read for the open view (`ifChanged`) never brings back one closed, or
  // replaced by another agent's, while it read.
  const put = async (view: ChatView) => update($, chatA, cur => (ifChanged && cur?.id !== id ? cur : view))
  const path = node.sessionId ? await findTranscript($, node.sessionId) : null
  const stat = path ? await $.fs.stat(path) : null
  const sig = `${id}:${stat ? `${stat.mtimeMs}:${stat.size}` : node.sessionId ? 'none' : 'new'}:${status}`
  if (ifChanged && sig === chatSeen) return
  chatSeen = sig
  if (!node.sessionId) return void (await put({ id, name: node.name, lines: [], status, note: 'No chat yet: it starts on its first run.' }))
  if (!path) return void (await put({ id, name: node.name, lines: [], status, note: "This chat hasn't said anything yet." }))
  const tail = await $.process.run(['tail', '-n', '1500', path])
  await put({ id, name: node.name, lines: parseChat(tail.stdout), status })
}

/** For the open flow: each End card's latest answer (raising Run finished once), and And's progress. */
async function watchRuns($: EngineInterface) {
  const flow = await openFlow($)
  if (!flow) return
  const ends = flow.nodes.filter(n => kindOf(n) === 'end')
  const ands = flow.nodes.filter(n => kindOf(n) === 'all')
  if (!ends.length && !ands.length) return
  const runs = (await latestRuns($, flow)).slice(0, 5)
  const results = await read($, resultsA)
  for (const end of ends) {
    for (const run of runs) {
      const r = await $.fs.read(`${runDir(flow, run)}/end-${end.id}.json`).then(t => JSON.parse(t), () => null)
      if (!r || typeof r.text !== 'string') continue
      if ((results[end.id]?.at ?? 0) < r.at) {
        await update($, resultsA, all => ({ ...all, [end.id]: { text: r.text, at: r.at } }))
        if (results[end.id]) $.ui.toast(`Run finished: ${flow.name}`)
      }
      break
    }
  }
  const waiting = await read($, waitingA)
  for (const and of ands) {
    const inputs = [...new Set(flow.edges.filter(e => e.to === and.id).map(e => e.from))]
    const run = runs[0]
    const base = run ? `${runDir(flow, run)}/all-${and.id}` : ''
    let round = 1
    while (run && round < 100 && (await $.fs.exists(`${base}/r${round}.fired`))) round++
    const got = run ? (await $.fs.list(`${base}/r${round}`).catch(() => [])).filter(f => f.name.endsWith('.json')).map(f => f.name.replace(/\.json$/, '')) : []
    const now = !got.length ? undefined : { got: inputs.filter(i => got.includes(i)).length, of: inputs.length }
    if (JSON.stringify(now) !== JSON.stringify(waiting[and.id])) {
      await update($, waitingA, w => {
        const { [and.id]: _old, ...rest } = w
        return now ? { ...rest, [and.id]: now } : rest
      })
    }
  }
}

/**
 * Claude chats running on this machine, from the registry each one keeps at
 * ~/.claude/sessions/<pid>.json; entries whose process has ended are left out.
 */
async function runningSessions($: EngineInterface): Promise<(AvailableSession & { pid: number })[]> {
  const dir = `${await home($)}/.claude/sessions`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && /^\d+\.json$/.test(f.name))
  const found: (AvailableSession & { pid: number })[] = []
  for (const f of files) {
    try {
      const r = JSON.parse(await $.fs.read(`${dir}/${f.name}`))
      if (typeof r.sessionId === 'string' && typeof r.pid === 'number' && r.kind === 'interactive') {
        found.push({ pid: r.pid, sessionId: r.sessionId, name: String(r.name ?? r.sessionId.slice(0, 8)), cwd: String(r.cwd ?? ''), startedAt: Number(r.startedAt ?? 0) })
      }
    } catch {
      continue // a file mid-write; it is read again next time
    }
  }
  if (found.length === 0) return []
  const ps = await $.process.run(['ps', '-o', 'pid=', '-p', found.map(s => s.pid).join(',')])
  const alive = new Set(ps.stdout.split('\n').map(l => Number(l.trim())).filter(Boolean))
  return found
    .filter(s => alive.has(s.pid))
    .sort((a, b) => b.startedAt - a.startedAt)
}

async function refreshLive($: EngineInterface) {
  const ids = (await runningSessions($)).map(s => s.sessionId).sort()
  const before = await read($, liveA)
  if (ids.join() !== before.join()) await update($, liveA, () => ids)
}

async function openPicker($: EngineInterface) {
  const own = await $.session.id()
  // A chat already in any flow, this project's or another's, can't join a second one.
  const fs = io($)
  const index = await readIndex(fs, indexPath(await home($))).catch(() => ({}) as Record<string, { flowFile: string }>)
  const inFlows = new Set(Object.values(await read($, flowsA)).flatMap(f => f.nodes.map(n => n.sessionId)).filter(Boolean))
  const choices: AvailableSession[] = []
  for (const s of await runningSessions($)) {
    if (s.sessionId === own || inFlows.has(s.sessionId)) continue
    // An entry whose flow file was removed outside the canvas no longer holds the chat.
    const entry = index[s.sessionId]
    if (entry && (await fs.exists(entry.flowFile))) continue
    const { pid: _pid, ...chat } = s
    choices.push(chat)
  }
  pickerChoices = choices
  await browseTo($, await $.session.root())
}

/** The chats the open browser offers, read once when it opens. */
let pickerChoices: AvailableSession[] = []
const MAX_FOLDERS = 300

/** Shows the browser at `raw`: a folder clicked, or a path typed (a file opens its folder). */
async function browseTo($: EngineInterface, raw: string) {
  const now = await read($, pickerA)
  const homeDir = await home($)
  const current = now?.dir ?? (await $.session.root())
  let dir = resolveDir(raw, homeDir, current)
  const stat = await $.fs.stat(dir).catch(() => null)
  if (!stat) {
    if (now) return void (await update($, pickerA, p => p && { ...p, note: `No folder at ${showPath(dir, homeDir)}` }))
    dir = homeDir
  } else if (stat.kind !== 'dir') dir = parentOf(dir)
  const entries = await $.fs.list(dir).catch(() => [])
  const view: PickerView = {
    dir,
    home: homeDir,
    folders: folderRows(entries, pickerChoices, dir).slice(0, MAX_FOLDERS),
    chats: chatsUnder(pickerChoices, dir),
  }
  await update($, pickerA, () => view)
}

/** The first spot at or below (x, y) where a card overlaps none; steps down, so it stays between the side panels. */
function freeSpot(nodes: FlowNode[], x: number, y: number) {
  const hits = (px: number, py: number) => nodes.some(n => Math.abs(n.x - px) < CARD.w + 4 && py < n.y + cardHeight(n) + 2 && n.y < py + CARD.ht + 2)
  for (let i = 0; i < 40; i++) {
    const p = { x: Math.round(x), y: Math.round(y) + i * (CARD.ht + 3) }
    if (!hits(p.x, p.y)) return p
  }
  return { x: Math.round(x), y: Math.round(y) }
}

/** The open flow, made first when the project has none. */
const targetFlow = async ($: EngineInterface) => (await openFlow($)) ?? (await newFlow($))

/** Puts a chat that is already running into the open flow as an agent, its history kept. */
async function adopt($: EngineInterface, sessionId: string, name: string, cwd: string, x: number, y: number) {
  const flow = await targetFlow($)
  if (flow.nodes.some(n => n.sessionId === sessionId)) return
  const node: FlowNode = {
    id: shortId(),
    name: name.replace(/-[a-z]+-[a-z]+$/, '') || name, // the engine's "-word-word" suffix is not part of the name
    ...freeSpot(flow.nodes, x, y),
    prompt: '',
    mode: 'default',
    sessionId,
    ...(cwd && cwd !== (await $.session.root()) ? { cwd } : {}),
  }
  await mutateFlow($, flow.id, f => ({ ...f, nodes: [...f.nodes, node] }))
  await update($, pickerA, () => null)
  await update($, selA, () => ({ kind: 'node', id: node.id }))
  await log($, `+ added ${node.name} (already running)`)
}

async function addNode($: EngineInterface, x: number, y: number, kind: CardKind = 'agent') {
  const flow = await targetFlow($)
  const at = freeSpot(flow.nodes, x, y)
  const all = Object.values(await read($, flowsA)).map(f => f.nodes.filter(isAgent))
  const node = newCard(kind, shortId(), at.x, at.y, nextAgentName(all, slug(flow.name)))
  await mutateFlow($, flow.id, f => ({ ...f, nodes: [...f.nodes, node] }))
  await update($, selA, () => ({ kind: 'node', id: node.id }))
}

async function stop($: EngineInterface, id: string) {
  queue.delete(id)
  const it = live.get(id)
  if (it?.return) await it.return()
}

/** Switches cmux to the tab running process `pid`; false outside cmux, or when no tab shows it. */
async function focusTab($: EngineInterface, pid: number) {
  const cmux = await $.env.get('CMUX_BUNDLED_CLI_PATH')
  if (!cmux) return false
  const tty = await $.process.run(['ps', '-o', 'tty=', '-p', String(pid)]).catch(() => null)
  const tree = await $.process.run([cmux, 'tree', '--all', '--id-format', 'both']).catch(() => null)
  const surface = tty && tree?.exitCode === 0 ? surfaceForTty(tree.stdout, tty.stdout) : null
  if (!surface) return false
  const r = await $.process.run([cmux, 'surface', 'open', `local/terminal/${surface}`, '--focus', 'true']).catch(() => null)
  return r?.exitCode === 0
}

/** Opens the agent's real chat, interactive, in a new terminal tab. */
async function openSession($: EngineInterface, id: string) {
  const found = await locate($, id)
  if (!found || !isAgent(found.node)) return
  const session = await ensureSession($, id)
  if (!session) return
  const { node } = found
  const open = (await runningSessions($)).find(s => s.sessionId === session.sessionId)
  if (open) {
    // Already running in a tab: bring that tab forward rather than start a second copy.
    if (await focusTab($, open.pid)) return void (await log($, `⧉ switched to ${node.name}`))
    $.ui.toast(`"${node.name}" is already open in another tab or window. Switch to it to use it.`)
    return
  }
  if (live.has(id)) $.ui.toast(`${node.name} is running; wait for it to finish before typing in it.`)
  // A chat resumes from the folder it ran in.
  const root = node.cwd ?? (await $.session.root())
  const exists = !session.isNew && !!(await findTranscript($, session.sessionId))
  const claudeArgs = [
    ...(exists ? ['--resume', session.sessionId] : ['--session-id', session.sessionId, '--name', node.name]),
    ...modelArgs(modelFor(found.flow, id)),
  ]
  const command = `cd ${shellQuote(root)} && claude ${claudeArgs.map(shellQuote).join(' ')}`

  const cmux = await $.env.get('CMUX_BUNDLED_CLI_PATH')
  const term = await $.env.get('TERM_PROGRAM')
  // A new tab in the terminal this chat runs in, where the plugin knows how to ask
  // for one; each program is named at its call.
  const here = cmux
    ? await $.process.run([cmux, 'new-surface', '--type', 'terminal', '--command', command, '--focus', 'true']).catch(() => null)
    : term === 'ghostty'
      ? await $.process.run(['open', '-na', 'Ghostty', '--args', `--working-directory=${root}`, '-e', 'claude', ...claudeArgs]).catch(() => null)
      : term === 'iTerm.app'
        ? await $.process.run(['osascript', `${$.plugin.root}/scripts/open-iterm.applescript`, command]).catch(() => null)
        : null
  // Any other terminal, the desktop app, or a tab that wouldn't open: a new window
  // of the Mac's own Terminal, which every Mac has.
  const r = here?.exitCode === 0
    ? here
    : await $.process.run(['osascript', `${$.plugin.root}/scripts/open-terminal.applescript`, command]).catch(() => null)
  if (!r || r.exitCode !== 0) {
    await $.ui.copy({ text: command })
    $.ui.toast(`Couldn't open a terminal here. Copied the command; paste it in a new terminal.`)
    return
  }
  await log($, `⧉ opened ${node.name}`)
}

/** Tells both ends of a link, when open, that it changed; a closed chat reads it next time. */
async function announce($: EngineInterface, flow: FlowDoc, edge: FlowEdge, isConnected: boolean) {
  const a = flow.nodes.find(n => n.id === edge.from)
  const b = flow.nodes.find(n => n.id === edge.to)
  // Only chats talk to chats: a Model card's or a logic card's link is wiring, not a contact.
  if (!a || !b || a.id === b.id || !isAgent(a) || !isAgent(b)) return
  const tell = async (self: FlowNode, other: FlowNode, canSend: boolean) => {
    if (!self.sessionId) return
    const text = isConnected
      ? `${NOTICE_TAG} You are now linked to the agent "${other.name}" in the flow "${flow.name}". ${canSend ? 'When your turn ends, your reply is handed to it.' : 'Its replies are handed to you.'} No reply needed now.`
      : `${NOTICE_TAG} You are no longer linked to the agent "${other.name}". Don't message it. No reply needed.`
    await $.session.send({ to: { sessionId: self.sessionId }, text })
  }
  await Promise.all([tell(a, b, true), tell(b, a, false)])
}

/** Text pasted for the canvas's open text box, which holds one line. */
async function handPaste($: EngineInterface, text: string) {
  await update($, pasteA, p => ({ seq: (p?.seq ?? 0) + 1, text: text.replace(/[\r\n\t]+/g, ' ').slice(0, 20000) }))
}

/** The plugin's "Extra models" option, set when the module loads. */
let extraModels = ''

/** The models a Model card offers: Opus, Sonnet and Haiku, then the person's extra ids. Reads nothing, calls nothing. */
async function loadModels($: EngineInterface) {
  const { ids, bad } = modelChoices(extraModels)
  const note = bad.length ? `Left out of "Extra models", not a model id: ${bad.join(', ').slice(0, 80)}` : undefined
  await update($, modelsA, () => ({ ids, ...(note ? { note } : {}) }))
}

/**
 * The model id a request names for a Model card's choice. A request takes no alias
 * (`--model` resolves those; a request is sent as named), so `opus`, `sonnet` and
 * `haiku` become that family's
 * first id among the "Extra models" option; null when it names none.
 */
async function requestModel($: EngineInterface, model: string): Promise<string | null> {
  if (!MODEL_ALIASES.includes(model)) return model
  if (!(await read($, modelsA))) await loadModels($) // once per chat
  return (await read($, modelsA))?.ids.find(id => id.includes(`-${model}`)) ?? null
}

const isModelCard = (g: Graph, id: string) => g.nodes.some(n => n.id === id && kindOf(n) === 'model')

async function connect($: EngineInterface, from: string, to: string, port: string) {
  const found = await locate($, from)
  const target = found?.flow.nodes.find(n => n.id === to)
  await update($, connectA, () => null)
  await update($, portA, () => 'out')
  // Links never cross flows: both ends must be in the same one.
  if (!found || !target) return
  const fromKind = kindOf(found.node)
  const toKind = kindOf(target)
  if (fromKind === 'end' || fromKind === 'note') return void $.ui.toast(`${found.node.name} passes nothing on.`)
  if (toKind === 'start' || toKind === 'note' || toKind === 'model') return void $.ui.toast(`Nothing links into ${target.name}.`)
  if (fromKind === 'model' && toKind !== 'agent') return void $.ui.toast('Only agents take a model.')
  const out = portsOf(found.node).includes(port) ? port : (portsOf(found.node)[0] ?? 'out')
  if (found.flow.edges.some(e => e.from === from && e.to === to && (e.port ?? 'out') === out)) return
  const edge: FlowEdge = {
    id: shortId(), from, to, cond: 'always', value: '', maxPasses: 3, template: DEFAULT_TEMPLATE,
    ...(out === 'out' ? {} : { port: out }),
  }
  // An agent takes one model: a new Model card's link replaces the old one.
  await mutateFlow($, found.flow.id, f => ({
    ...f,
    edges: [...f.edges.filter(e => !(fromKind === 'model' && e.to === to && isModelCard(f, e.from))), edge],
  }))
  if (isAgent(found.node) && isAgent(target)) {
    void announce($, found.flow, edge, true).catch(err => log($, `⚠ couldn't notify agents: ${String(err)}`))
  }
  await update($, selA, () => ({ kind: 'edge', id: edge.id }))
}

/** Points an existing link at another card in its flow: dragged by its arrowhead. */
async function relink($: EngineInterface, edgeId: string, to: string) {
  const flow = Object.values(await read($, flowsA)).find(f => f.edges.some(e => e.id === edgeId))
  const edge = flow?.edges.find(e => e.id === edgeId)
  const target = flow?.nodes.find(n => n.id === to)
  if (!flow || !edge || !target || edge.from === to) return
  const k = kindOf(target)
  if (k === 'start' || k === 'note' || k === 'model') return void $.ui.toast(`Nothing links into ${target.name}.`)
  const fromModel = isModelCard(flow, edge.from)
  if (fromModel && k !== 'agent') return void $.ui.toast('Only agents take a model.')
  if (flow.edges.some(e => e.id !== edgeId && e.from === edge.from && e.to === to && (e.port ?? 'out') === (edge.port ?? 'out'))) return
  await mutateFlow($, flow.id, f => ({
    ...f,
    edges: f.edges
      .filter(e => !(fromModel && e.id !== edgeId && e.to === to && isModelCard(f, e.from)))
      .map(e => (e.id === edgeId ? { ...e, to } : e)),
  }))
  await log($, `↪ link now goes to ${target.name}`)
}

async function deleteSelection($: EngineInterface) {
  const sel = await read($, selA)
  const flow = await openFlow($)
  if (!flow) return
  if (sel.kind === 'node') {
    await stop($, sel.id)
    await mutateFlow($, flow.id, f => ({
      ...f,
      nodes: f.nodes.filter(n => n.id !== sel.id),
      edges: f.edges.filter(e => e.from !== sel.id && e.to !== sel.id),
    }))
  } else if (sel.kind === 'edge') {
    const edge = flow.edges.find(e => e.id === sel.id)
    if (edge) await announce($, flow, edge, false).catch(err => log($, `⚠ couldn't notify agents: ${String(err)}`))
    await mutateFlow($, flow.id, f => ({ ...f, edges: f.edges.filter(e => e.id !== sel.id) }))
  }
  await update($, selA, () => ({ kind: 'none' }))
}

/** ▶ Run on one agent: its test message (`prompt`, kept for next time), with its instructions. */
async function startRun($: EngineInterface, id: string, prompt?: string) {
  const found = await locate($, id)
  if (!found) return
  const message = (prompt ?? found.node.prompt).trim()
  if (!message) {
    $.ui.toast(`Write a test message for "${found.node.name}" first.`)
    return
  }
  if (prompt !== undefined) await patchNode($, id, { prompt: prompt.slice(0, 20000) })
  const run = newRunId()
  const body = await withInstructions($, found.flow, found.node, message)
  void runNode($, id, `${hopTag(run, 0)}\n${body}`, 0, run).catch(err => log($, `⚠ ${found.node.name}: ${String(err)}`))
}

/** A message with the agent's instructions ahead of it, each `@path` read in; problems go to the log. */
async function withInstructions($: EngineInterface, flow: FlowDoc, node: FlowNode, body: string) {
  const text = (node.instructions ?? '').trim()
  if (!text) return body
  const root = projectOf(flow)
  const cwd = node.cwd ?? root
  const homeDir = await home($)
  const files: Record<string, RefFile> = {}
  for (const ref of instructionRefs(text)) {
    const path = resolveRef(ref, homeDir, root, cwd)
    files[ref] = !path
      ? { error: 'only files in the project, or .md files in ~/.claude' }
      : await $.fs.read(path).then(content => ({ path, content }), () => ({ error: 'no such file' }))
  }
  const composed = composeInstructions(node.name, text, files)
  for (const p of composed.problems) await log($, `⚠ ${node.name}: ${p}`)
  return `${composed.text}\n\n${body}`
}

/**
 * Runs a flow from its Start cards, each sending its command along its links as a
 * new run. With `command`, the one Start card `startId` runs that command (and keeps
 * it). A flow with no Start card gets one, selected, with what to do next.
 */
async function runFlow($: EngineInterface, flowId: string, command?: string, startId?: string) {
  const flow = (await read($, flowsA))[flowId]
  if (!flow) return
  let starts = flow.nodes.filter(n => kindOf(n) === 'start')
  if (starts.length === 0) {
    const left = flow.nodes.length ? Math.min(...flow.nodes.map(n => n.x)) - CARD.w - 8 : 0
    const top = flow.nodes.length ? Math.min(...flow.nodes.map(n => n.y)) : 0
    const card = newCard('start', shortId(), left, top)
    await mutateFlow($, flow.id, f => ({ ...f, nodes: [...f.nodes, card] }))
    await update($, selA, () => ({ kind: 'node', id: card.id }))
    $.ui.toast(`Added a Start card: write its command, link it to an agent, then Run flow.`)
    return
  }
  if (command !== undefined && startId) {
    const text = command.trim()
    if (!text) return
    starts = starts.filter(n => n.id === startId).map(n => ({ ...n, prompt: text }))
    if (starts.length === 0) return void $.ui.toast(`That Start card is gone (deleted in another window?).`)
    await patchNode($, startId, { prompt: text.slice(0, 20000) })
  }
  const ready = starts.filter(n => n.prompt.trim() && flow.edges.some(e => e.from === n.id))
  if (ready.length === 0) {
    await update($, selA, () => ({ kind: 'node', id: starts[0]!.id }))
    $.ui.toast(starts[0]!.prompt.trim() ? `Link ${starts[0]!.name} to an agent, then Run flow.` : `Write ${starts[0]!.name}'s command, then Run flow.`)
    return
  }
  const now = (await read($, flowsA))[flowId] ?? flow
  // One run for the click: an And joining several Start cards' branches sees them all.
  const run = newRunId()
  for (const n of ready) {
    await log($, `▶ ${flow.name} · run ${run}: "${n.prompt.trim().split('\n')[0]}"`)
    void emit($, now, n.id, 'out', { text: n.prompt.trim(), from: n.name, run, hop: 0, raw: true }).catch(err => log($, `⚠ ${String(err)}`))
  }
}

async function stopFlow($: EngineInterface, flowId: string) {
  const flow = (await read($, flowsA))[flowId]
  if (!flow) return
  for (const n of flow.nodes) await stop($, n.id)
  await log($, `■ stopped flow ${flow.name}`)
}

const patchNode = ($: EngineInterface, id: string, patch: Partial<FlowNode>) =>
  mutateNodeFlow($, id, f => ({ ...f, nodes: f.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)) }))

const KIND_SET = new Set<CardKind>(['agent', 'start', 'if', 'switch', 'all', 'first', 'prompt', 'loop', 'end', 'note', 'model'])

/** A card's settings from the panel, checked field by field. Removing a Switch branch drops its links. */
async function patchCard($: EngineInterface, id: string, p: CardPatch) {
  const card: CardConfig = {}
  if (typeof p.prompt === 'string') await patchNode($, id, { prompt: p.prompt.slice(0, 20000) })
  if (typeof p.check === 'string' && (CHECKS as readonly string[]).includes(p.check)) card.check = p.check
  if (typeof p.value === 'string') card.value = p.value.slice(0, 1000)
  if (typeof p.template === 'string') card.template = p.template.slice(0, 20000)
  if (typeof p.saveTo === 'string') card.saveTo = p.saveTo.trim().slice(0, 300)
  if (typeof p.text === 'string') card.text = p.text.slice(0, 5000)
  // A model id as the CLI or a gateway spells them (`opus`, `claude-opus-5-5`, `us.anthropic.…[1m]`); an empty effort clears it.
  if (isModelId(p.model)) card.model = p.model
  const effort = EFFORTS.find(x => x.effort === p.effort)?.effort
  if (effort) card.effort = effort
  const clearEffort = p.effort === ''
  if (typeof p.maxTries === 'number') card.maxTries = Math.max(1, Math.min(20, Math.round(p.maxTries)))
  if (Array.isArray(p.branches)) {
    card.branches = [...new Set(p.branches.filter((b): b is string => typeof b === 'string').map(b => b.trim().slice(0, 40)).filter(Boolean))]
      .filter(b => !['out', 'other', 'yes', 'no', 'done', 'again'].includes(b.toLowerCase()))
      .slice(0, 8)
  }
  if (Object.keys(card).length === 0 && !clearEffort) return
  await mutateNodeFlow($, id, f => {
    const merged = (c: CardConfig | undefined): CardConfig => {
      const next = { ...c, ...card }
      if (clearEffort) delete next.effort
      return next
    }
    const nodes = f.nodes.map(n => (n.id === id ? { ...n, card: merged(n.card) } : n))
    const node = nodes.find(n => n.id === id)!
    const ports = new Set(portsOf(node))
    return { ...f, nodes, edges: f.edges.filter(e => e.from !== id || ports.has(e.port ?? 'out')) }
  })
}

async function patchEdge($: EngineInterface, id: string, patch: Partial<FlowEdge>) {
  const flow = Object.values(await read($, flowsA)).find(f => f.edges.some(e => e.id === id))
  if (flow) await mutateFlow($, flow.id, f => ({ ...f, edges: f.edges.map(e => (e.id === id ? { ...e, ...patch } : e)) }))
}

// ---------- an agent's own view ----------

type Self = { self: FlowNode; flow: FlowDoc } | null
/** The last answer, valid while the index, the flows folder and the flow's own file are unchanged. */
let selfCache: { key: string; fileMtime: number | null; value: Self } | null = null

/**
 * In an agent chat: its flow and its own agent; null in an ordinary chat. Runs on
 * every prompt of every chat, so an unchanged answer costs two or three stats.
 */
async function selfNode($: EngineInterface): Promise<Self> {
  const fs = io($)
  const sid = await $.session.id()
  const root = await $.session.root()
  const idx = indexPath(await home($))
  const key = `${sid}|${await mtimeOf($, idx)}|${await mtimeOf($, flowsDir(root))}`
  if (selfCache?.key === key) {
    const file = selfCache.value?.flow.file
    if (!file || (await mtimeOf($, file)) === selfCache.fileMtime) return selfCache.value
  }
  const index = await readIndex(fs, idx).catch(() => ({}))
  // An ordinary chat, absent from the index, in a project without flows: nothing more to read.
  const found = !(index as Record<string, unknown>)[sid] && !(await fs.exists(flowsDir(root))) ? null : await findSelf(fs, index, root, sid)
  const value: Self = found ? { self: found.node, flow: found.flow } : null
  selfCache = { key, fileMtime: value ? await mtimeOf($, value.flow.file) : null, value }
  return value
}

/** Messages this chat sent per peer since its person last typed: the ping-pong guard. */
const sentSincePrompt = new Map<string, number>()
/**
 * The hand-off count of the latest message to reach this chat (0 once its person
 * types): the count its next reply carries on, plus one. Each chain only counts up,
 * so a ping-pong always reaches the links' max passes.
 */
let turnHop = 0
/** The run the latest message belongs to; null after the person types (their turn starts a new run). */
let turnRun: string | null = null
/** Hand-offs this chat made since its person last typed: the hard backstop. */
let handOffsSincePrompt = 0
/** The turn answers one of the mod's own notices: its reply is not handed on. */
let isNotice = false
const NOTICE_TAG = '[Agent Flows · notice]'
const NOTICE_RE = /\[Agent Flows · notice\]/

/** Takes the run and count from a message that reached this chat; one with no tag starts a fresh run. */
function noteTag(text: string) {
  isNotice = NOTICE_RE.test(text)
  const tag = tagOf(text)
  turnHop = tag.hop
  turnRun = tag.run
}

/**
 * The agents an agent hands to and hears from, through any logic cards, as plain
 * links for the note its chat reads. Cards between them are named in the note.
 */
function peerEdges(flow: FlowDoc, self: FlowNode): FlowEdge[] {
  const plain = (from: string, to: string): FlowEdge => ({ id: `${from}>${to}`, from, to, cond: 'always', value: '', maxPasses: 3, template: '' })
  return [
    ...reachableAgents(flow, self.id, 'out').map(n => plain(self.id, n.id)),
    ...reachableAgents(flow, self.id, 'in').map(n => plain(n.id, self.id)),
  ]
}

const STATUS_RANK: RunStatus[] = ['running', 'queued', 'error', 'done', 'stopped', 'idle']
const flowStatus = (nodes: FlowNode[], runs: Record<string, NodeRun>): RunStatus => {
  const ss = nodes.map(n => runs[n.id]?.status ?? 'idle')
  return STATUS_RANK.find(s => ss.includes(s)) ?? 'idle'
}

/** One message from the canvas. */
async function onCanvas($: EngineInterface, m: CanvasMessage) {
  switch (m?.t) {
    case 'select':
      await update($, selA, () => m.sel)
      if (m.sel.kind === 'node' && !(await read($, modelsA))) {
        const sel = m.sel
        const picked = Object.values(await read($, flowsA)).flatMap(f => f.nodes).find(n => n.id === sel.id)
        if (picked && kindOf(picked) === 'model') void loadModels($).catch(() => {})
      }
      break
    case 'models': void loadModels($).catch(() => {}); break
    case 'chat':
      chatSeen = ''
      if (typeof m.id === 'string') await loadChat($, m.id)
      else await update($, chatA, () => null)
      break
    case 'paste': {
      // Plugins can't read the clipboard; macOS's pbpaste can. Text boxes hold one line.
      const r = await $.process.run(['pbpaste'], { timeoutMs: 5000 }).catch(() => null)
      const text = r && r.exitCode === 0 ? r.stdout : ''
      if (!text) $.ui.toast(r ? 'The clipboard has no text to paste.' : "Couldn't read the clipboard.")
      await handPaste($, text)
      break
    }
    case 'move': await patchNode($, m.id, { x: Math.round(m.x), y: Math.round(m.y) }); break
    case 'open': await openSession($, m.id); break
    case 'connect': await connect($, m.from, m.to, typeof m.port === 'string' ? m.port : await read($, portA)); break
    case 'relink': await relink($, m.id, m.to); break
    case 'connect-start':
      await update($, portA, () => (typeof m.port === 'string' ? m.port : 'out'))
      await update($, connectA, () => m.id)
      break
    case 'cancel': await update($, connectA, () => null); break
    case 'new': await addNode($, m.x, m.y, KIND_SET.has(m.kind as CardKind) ? (m.kind as CardKind) : 'agent'); break
    case 'delete': await deleteSelection($); break
    case 'run': await startRun($, m.id, typeof m.prompt === 'string' ? m.prompt : undefined); break
    case 'node': {
      const p = m.patch
      const patch: Partial<FlowNode> = {}
      if (typeof p.name === 'string' && p.name.trim()) patch.name = p.name.trim().slice(0, 60)
      if (typeof p.prompt === 'string') patch.prompt = p.prompt.slice(0, 20000)
      if (typeof p.instructions === 'string') patch.instructions = p.instructions.slice(0, 20000)
      if (p.mode === 'default' || p.mode === 'acceptEdits' || p.mode === 'plan') patch.mode = p.mode
      await patchNode($, m.id, patch)
      break
    }
    case 'stop': await stop($, m.id); break
    case 'fresh':
      lastSeen.delete(m.id)
      await patchNode($, m.id, { sessionId: undefined })
      await setRun($, m.id, () => IDLE)
      break
    case 'picker':
      if (m.open) await openPicker($)
      else await update($, pickerA, () => null)
      break
    case 'picker-dir': if (typeof m.dir === 'string' && (await read($, pickerA))) await browseTo($, m.dir.slice(0, 1000)); break
    case 'adopt': await adopt($, m.sessionId, m.name, typeof m.cwd === 'string' ? m.cwd : '', m.x, m.y); break
    case 'edge': {
      const p = m.patch
      const patch: Partial<FlowEdge> = {}
      if (typeof p.maxPasses === 'number') patch.maxPasses = Math.max(1, Math.min(50, Math.round(p.maxPasses)))
      await patchEdge($, m.id, patch)
      break
    }
    case 'flow-new': await newFlow($); break
    case 'flow-open':
      await update($, openA, () => m.id)
      await update($, selA, () => ({ kind: 'none' }))
      await update($, connectA, () => null)
      break
    case 'flow-patch':
      if (typeof m.patch.name === 'string' && m.patch.name.trim()) {
        const name = m.patch.name.trim().slice(0, 60)
        await mutateFlow($, m.id, f => ({ ...f, name }))
      }
      break
    case 'flow-run': await runFlow($, m.id, typeof m.command === 'string' ? m.command : undefined, typeof m.startId === 'string' ? m.startId : undefined); break
    case 'card': await patchCard($, m.id, m.patch); break
    case 'all-flush': await flushAll($, m.id); break
    case 'flow-stop': await stopFlow($, m.id); break
    case 'flow-delete': await deleteFlow($, m.id); break
  }
}

export const register: Register = (on, options) => {
  extraModels = String(options.extraModels ?? '')
  // Installed for every chat, so starting up stays cheap: register /flow, nothing else.
  // Flows load and the watcher starts only when the canvas opens.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: 'Open Agent Flows: the flows of agents in this project' })
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      watcher?.cancel()
      watcher = null
      quickWatcher?.cancel()
      quickWatcher = null
      chatSeen = ''
      await update($, chatA, () => null)
    }
    return next(e)
  })

  // Each message an agent chat receives (typed, or from a peer) carries its current links beside it.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') sentSincePrompt.clear()
    if (e.origin.kind === 'composer') {
      turnHop = 0
      turnRun = null
      isNotice = false
      handOffsSincePrompt = 0
    } else noteTag(e.text)
    const found = await selfNode($).catch(() => null)
    if (!found) return next(e)
    const note = peerSection(found.self, found.flow.nodes, peerEdges(found.flow, found.self))
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // An agent's chat hands its reply to its linked agents as each turn ends, so linked
  // chats answer each other without the canvas. Background runs leave it to their spawner.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.isAborted || e.reason !== 'answer' || !e.answer.trim()) return result
    if ((await $.env.get('AGENT_FLOWS_CHILD')) === '1' || isNotice) return result
    const found = await selfNode($).catch(() => null)
    if (found && handOffsSincePrompt < MAX_HANDOFFS_PER_CHAT) {
      handOffsSincePrompt++
      turnRun ??= newRunId()
      void handOff($, found.flow, found.self, e.answer, turnHop, turnRun).catch(err => log($, `⚠ hand-off failed: ${String(err)}`))
    }
    return result
  })

  // An agent's Model card, in its chat however it runs: open in a tab, or in the
  // background. Each request names the card's model from then on, so a card linked
  // or changed while the chat is open takes effect on its next message, and the
  // person's saved default (what /model would change) is never touched.
  on('turn.step', async function* ($, e, next) {
    const found = e.agentId ? null : await selfNode($).catch(() => null)
    const choice = found ? modelFor(found.flow, found.self.id) : null
    const model = choice && (await requestModel($, choice.model))
    return yield* next(choice && model ? { ...e, model, ...(choice.effort ? { effort: choice.effort } : {}) } : e)
  })

  // A peer's message is counted as it arrives, whether or not a prompt event carries it.
  on('session.receive', async ($, e, next) => {
    noteTag(e.text)
    return next(e)
  })

  // The link itself: an agent's messages to other agents of its flow go only along links.
  on('session.send', async ($, e, next) => {
    if (e.origin.kind !== 'model') return next(e)
    const found = await selfNode($).catch(() => null)
    if (!found) return next(e)
    const { self, flow } = found
    const target = matchRecipient(flow.nodes, e.to)
    if (!target || target.id === self.id) return next(e) // not an agent of this flow: not the flow's call
    const isLinked = [...reachableAgents(flow, self.id, 'out'), ...reachableAgents(flow, self.id, 'in')].some(n => n.id === target.id)
    if (!isLinked) {
      return { isDelivered: false, reason: `Not linked to "${target.name}" in the flow "${flow.name}". Ask the person to link the two agents first.` }
    }
    const cap = 3
    const used = sentSincePrompt.get(target.id) ?? 0
    if (used >= cap) {
      return { isDelivered: false, reason: `Message limit reached: ${cap} messages to "${target.name}" since your person last wrote. Stop and report back to your person.` }
    }
    sentSincePrompt.set(target.id, used + 1)
    return next(e)
  })

  on('command.run', { command: 'flow' }, async $ => {
    await loadFlows($)
    // Run folders older than a week go.
    const runs = `${flowsDir(await $.session.root())}/.runs`
    void $.process.run(['find', runs, '-mindepth', '1', '-maxdepth', '1', '-mtime', '+7', '-exec', 'rm', '-rf', '{}', '+']).catch(() => {})
    watcher ??= $.clock.every(WATCH_MS, () => {
      void watch($).catch(() => {})
    })
    quickWatcher ??= $.clock.every(ACTIVE_MS, () => {
      void watchActive($).catch(() => {})
    })
    await $.ui.open({ id: PANE, title: 'Agent Flows', focus: true, rows: 40, columns: 160 })
    const n = Object.keys(await read($, flowsA)).length
    return { text: `Agent Flows open: ${n} flow${n === 1 ? '' : 's'} in ${await $.session.root()}.` }
  })

  // Cmd+V is the terminal's own: it pastes into the prompt box even while the canvas
  // has the keys. While the canvas has them, it goes there instead, into the text
  // box being typed in (none open, the canvas says so). The canvas posts nothing to
  // say a box is open: a post in the same frame as another replaces it.
  on('prompt.edit', async ($, e, next) => {
    if (e.key || !e.inputText) return next(e)
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (!pane?.isFocused) return next(e)
    await handPaste($, e.inputText)
    return { text: e.text, cursor: e.cursor }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'canvas') return next(e)
    for (const m of unseen(e.data)) await onCanvas($, m)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>Agent Flows needs the terminal or desktop app.</Text>
    }
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const flows = await read($, flowsA)
    const openId = await read($, openA)
    const flow = openId ? flows[openId] : undefined
    const sel = await read($, selA)
    const runs = await read($, runsA)
    const connectFrom = await read($, connectA)
    const lines = await read($, logA)
    const picker = await read($, pickerA)
    const liveIds = new Set(await read($, liveA))
    const broken = await read($, brokenA)
    const connectPort = await read($, portA)
    const results = await read($, resultsA)
    const waiting = await read($, waitingA)
    const models = await read($, modelsA)
    const paste = await read($, pasteA)
    const chat = await read($, chatA)
    const root = await $.session.root()
    const nodes = flow?.nodes ?? []
    const edges = flow?.edges ?? []
    const warnings = flow ? warningsOf(flow) : {}

    const summaries: FlowSummary[] = Object.values(flows)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ id: f.id, name: f.name, status: flowStatus(f.nodes, runs), count: f.nodes.filter(isAgent).length, cards: f.nodes.filter(n => !isAgent(n)).length }))

    const props: CanvasProps = {
      project: root.split('/').filter(Boolean).at(-1) ?? root,
      flows: summaries,
      openFlowId: flow?.id ?? null,
      broken: broken.map(b => b.split('/').at(-1) ?? b),
      nodes: nodes.map(n => ({
        id: n.id, name: n.name, x: n.x, y: n.y,
        kind: kindOf(n),
        card: n.card ?? {},
        ports: portsOf(n),
        ht: cardHeight(n),
        summary: summaryOf(n, new Set(edges.filter(e => e.to === n.id).map(e => e.from)).size),
        ...(warnings[n.id] ? { warning: warnings[n.id] } : {}),
        ...(waiting[n.id] ? { waiting: waiting[n.id] } : {}),
        ...(results[n.id] ? { result: results[n.id] } : {}),
        status: runs[n.id]?.status ?? 'idle',
        preview: runs[n.id]?.preview ?? [],
        prompt: n.prompt,
        instructions: n.instructions ?? '',
        mode: n.mode,
        isOpen: !!n.sessionId && liveIds.has(n.sessionId),
        // The selected agent's thinking and full answer, for the side panel; not every card's.
        ...(sel.kind === 'node' && sel.id === n.id && isAgent(n)
          ? { thinking: runs[n.id]?.thinking ?? '' }
          : {}),
        hasSession: !!n.sessionId,
        ...(() => {
          const c = isAgent(n) && flow ? modelFor(flow, n.id) : null
          return c ? { model: modelLabel(c.model, c.effort) } : {}
        })(),
      })),
      edges: edges.map(edge => ({
        id: edge.id, from: edge.from, to: edge.to, port: edge.port ?? 'out', label: LINK_HANDLE,
        cond: edge.cond, value: edge.value, maxPasses: edge.maxPasses,
        fromName: nodes.find(n => n.id === edge.from)?.name ?? '?',
        toName: nodes.find(n => n.id === edge.to)?.name ?? '?',
        isModel: !!flow && isModelCard(flow, edge.from),
      })),
      selected: sel,
      connectFrom,
      connectPort,
      picker,
      models,
      paste,
      chat,
    }
    // Fit the pane's own body, not the terminal. 4 rows: the hint, the log line and the border.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const canvasRows = Math.max(8, bodyRows - 4)

    const nameOf = (id: string) => nodes.find(n => n.id === id)?.name ?? '?'
    const node = sel.kind === 'node' ? nodes.find(n => n.id === sel.id) : undefined
    const edge = sel.kind === 'edge' ? edges.find(x => x.id === sel.id) : undefined
    const hint = connectFrom
      ? `Linking from "${nameOf(connectFrom)}"${connectPort !== 'out' ? ` (${connectPort})` : ''}: click the card it passes to. Click empty canvas to cancel.`
      : node
        ? `${node.name}: edit it in the panel on the right. Double-click the card to chat with it.`
        : edge
          ? `${nameOf(edge.from)} → ${nameOf(edge.to)}: set when it passes messages in the panel on the right.`
          : flow
            ? `${flow.name}: click a card or a link's ${LINK_HANDLE} to edit it · drag cards to move · drag empty space to pan · n add a card`
            : 'No flows in this project yet: click [ + New flow ] on the left.'

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">{hint}</Text>
        <Text dimColor wrap="truncate">{lines.at(-1) ?? ' '}</Text>
        <Box borderStyle="round" borderColor="gray">
          {els.Client({ module: './canvas.tsx', key: 'canvas', props, height: canvasRows, flexGrow: 1 })}
        </Box>
      </Box>
    )
  })
}
