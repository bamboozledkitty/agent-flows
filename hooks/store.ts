import { isModelId, migrateV1 } from './cards'
import type { FlowDoc, FlowEdge, FlowNode, Graph } from '../types'

/**
 * Where flows live: one file per flow in `<project>/.claude/flows/`, plus a small
 * machine-wide index from a chat's session id to its flow's file, so a chat that
 * runs outside the project still finds its flow. Pure functions over `Io`, which
 * the hooks module builds from `$.fs` and `$.process`, and tests fake.
 */
export type Io = {
  read(path: string): Promise<string>
  /** Creates parent folders as needed. */
  write(path: string, text: string): Promise<void>
  list(dir: string): Promise<{ name: string; kind: string; mtimeMs: number }[]>
  exists(path: string): Promise<boolean>
  move(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

export const flowsDir = (root: string) => `${root}/.claude/flows`
export const indexPath = (home: string) => `${home}/.claude/agent-flows/agents.json`

/** Version 2: agents and logic cards share `agents`; links carry the output (`port`) they leave. */
export const FILE_VERSION = 2
type FileShape = { version: 2; id: string; name: string; agents: FlowNode[]; links: FlowEdge[] }

export const toFile = (f: FlowDoc): string =>
  JSON.stringify({ version: 2, id: f.id, name: f.name, agents: f.nodes, links: f.edges } satisfies FileShape, null, 2) + '\n'

const MODES = ['default', 'acceptEdits', 'plan']
const KINDS = ['agent', 'start', 'if', 'switch', 'all', 'first', 'prompt', 'loop', 'end', 'note', 'model']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CHECKS = ['judge', 'contains', 'not-contains', 'regex']
const isCard = (c: any) =>
  c === undefined || (typeof c === 'object' && c !== null && !Array.isArray(c) &&
    (c.check === undefined || CHECKS.includes(c.check)) &&
    (c.effort === undefined || EFFORTS.includes(c.effort)) &&
    ['value', 'template', 'saveTo', 'text', 'model'].every(k => c[k] === undefined || typeof c[k] === 'string') &&
    (c.maxTries === undefined || (typeof c.maxTries === 'number' && Number.isFinite(c.maxTries))) &&
    (c.branches === undefined || (Array.isArray(c.branches) && c.branches.every((b: unknown) => typeof b === 'string'))))
const CONDS = ['always', 'contains', 'not-contains', 'regex', 'judge', 'else']
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Ids name run folders and files, and session ids go to `claude --resume`: no `/`, `..` or spaces. */
const isId = (v: unknown): v is string => isStr(v) && /^[\w-]{1,64}$/.test(v)
const isModel = (v: unknown) => v === undefined || isModelId(v)

const isAgent = (a: any): a is FlowNode =>
  isId(a?.id) && isStr(a.name) && isNum(a.x) && isNum(a.y) && isStr(a.prompt) && MODES.includes(a.mode) &&
  (a.sessionId === undefined || a.sessionId === '' || isId(a.sessionId)) && (a.cwd === undefined || (isStr(a.cwd) && a.cwd.startsWith('/'))) &&
  (a.instructions === undefined || isStr(a.instructions)) &&
  (a.kind === undefined || KINDS.includes(a.kind)) && isCard(a.card) && isModel(a.card?.model)

const isLink = (l: any): l is FlowEdge =>
  isId(l?.id) && isId(l.from) && isId(l.to) && CONDS.includes(l.cond) && isStr(l.value) && isNum(l.maxPasses) && isStr(l.template) &&
  (l.port === undefined || isStr(l.port))

/**
 * Parses a flow file; null when it is not one this version can read, down to each
 * agent and link. A version-1 file comes back upgraded: its link rules as If cards.
 */
export function parseFlow(text: string, file: string): FlowDoc | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if ((raw?.version !== 1 && raw?.version !== FILE_VERSION) || !isId(raw.id) || !isStr(raw.name)) return null
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.links)) return null
  if (!raw.agents.every(isAgent) || !raw.links.every(isLink)) return null
  const graph: Graph = raw.version === 1
    ? migrateV1({ nodes: raw.agents, edges: raw.links })
    : { nodes: raw.agents, edges: raw.links }
  return { id: raw.id, name: raw.name, ...graph, file }
}

export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'flow'

/** A file name for a new flow that no existing file has. */
export function fileFor(dir: string, name: string, id: string, taken: Set<string>): string {
  const base = slug(name)
  const pick = taken.has(`${dir}/${base}.json`) ? `${base}-${id.slice(0, 4)}` : base
  return `${dir}/${pick}.json`
}

export type Project = { flows: FlowDoc[]; broken: string[]; mtimes: Record<string, number> }

/**
 * Reads every flow in the project. Files that don't parse are listed in `broken`,
 * and so is a file repeating a flow id or an agent id another file already holds
 * (a copied file): ids must be unique, or edits could land in the wrong file.
 */
export async function loadProject(io: Io, root: string): Promise<Project> {
  const dir = flowsDir(root)
  const out: Project = { flows: [], broken: [], mtimes: {} }
  if (!(await io.exists(dir))) return out
  const entries = (await io.list(dir)).filter(e => e.kind === 'file' && e.name.endsWith('.json'))
  const flowIds = new Set<string>()
  const agentIds = new Set<string>()
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${dir}/${e.name}`
    out.mtimes[file] = e.mtimeMs
    const flow = await io.read(file).then(t => parseFlow(t, file), () => null)
    if (!flow || flowIds.has(flow.id) || flow.nodes.some(n => agentIds.has(n.id))) {
      out.broken.push(file)
      continue
    }
    flowIds.add(flow.id)
    flow.nodes.forEach(n => agentIds.add(n.id))
    out.flows.push(flow)
  }
  return out
}

/** Writes beside under a name of its own, then moves over: a reader never sees half a file. */
async function writeWhole(io: Io, path: string, text: string) {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`
  await io.write(tmp, text)
  await io.move(tmp, path)
}

export async function saveFlow(io: Io, flow: FlowDoc): Promise<void> {
  const dir = flow.file.slice(0, flow.file.lastIndexOf('/'))
  const ignore = `${dir}/.gitignore`
  if (!(await io.exists(ignore))) await io.write(ignore, '# Agent Flows: flows link to chats on this machine only.\n*\n')
  await writeWhole(io, flow.file, toFile(flow))
}

export type Index = Record<string, { flowFile: string }>

/**
 * Reads the index: empty when there is none yet. A file that exists and doesn't
 * parse throws, so nothing rewrites it from empty and erases other projects' entries.
 */
export async function readIndex(io: Io, path: string): Promise<Index> {
  if (!(await io.exists(path))) return {}
  const raw = JSON.parse(await io.read(path))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not an agent index`)
  return raw as Index
}

/**
 * Makes the index agree with one flow: its chats point at its file, and entries
 * for chats that left it are dropped. Writes only when something changed.
 * `flow` null removes every entry for `file` (the flow was deleted).
 */
export async function syncIndex(io: Io, path: string, file: string, flow: Graph | null): Promise<void> {
  const index = await readIndex(io, path)
  const ids = new Set((flow?.nodes ?? []).map(n => n.sessionId).filter((s): s is string => !!s))
  let changed = false
  for (const [sid, entry] of Object.entries(index)) {
    if (entry.flowFile === file && !ids.has(sid)) {
      delete index[sid]
      changed = true
    }
  }
  for (const sid of ids) {
    if (index[sid]?.flowFile !== file) {
      index[sid] = { flowFile: file }
      changed = true
    }
  }
  if (changed) await writeWhole(io, path, JSON.stringify(index, null, 2) + '\n')
}

export type SelfFound = { flow: FlowDoc; node: FlowNode }

/**
 * Finds the flow a chat belongs to: through the index first, then by scanning the
 * chat's own project folder, for when the index lost its entry. Null for an
 * ordinary chat that is in no flow.
 */
export async function findSelf(io: Io, index: Index, root: string, sessionId: string): Promise<SelfFound | null> {
  const viaIndex = index[sessionId]?.flowFile
  if (viaIndex) {
    const flow = await io.read(viaIndex).then(t => parseFlow(t, viaIndex), () => null)
    const node = flow?.nodes.find(n => n.sessionId === sessionId)
    if (flow && node) return { flow, node }
  }
  const project = await loadProject(io, root).catch(() => null)
  for (const flow of project?.flows ?? []) {
    const node = flow.nodes.find(n => n.sessionId === sessionId)
    if (node) return { flow, node }
  }
  return null
}
