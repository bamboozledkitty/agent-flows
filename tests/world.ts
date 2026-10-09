import { mock } from 'claude-code/testing'

/**
 * The engine beneath the mod, in memory, for tests that run flows: files, folders
 * (`mkdir` fails on one that exists, so locks behave), the running-chat registry,
 * the messages the mod sends, and Claude's answers to routing questions.
 */
export const ROOT = '/work/proj'
export const HOME = '/home/k'
export const FLOW = `${ROOT}/.claude/flows/f.json`

export type World = {
  files: Record<string, string>
  dirs: Set<string>
  sent: { to: string; text: string }[]
  toasts: string[]
  /** The chat the next events come from: change it to act as another agent. */
  self: { id: string }
  /** What Claude answers a routing question; the default says YES. */
  answer: { fn: (prompt: string) => string }
  /** What macOS's pbpaste hands back: the clipboard. */
  clipboard: { text: string }
  /** cmux: the tab tree it reports, and every command run with it. */
  cmux: { tree: string; ran: string[][] }
}

export const agent = (id: string, name: string, sessionId: string, x = 0, y = 0) =>
  ({ id, name, x, y, prompt: '', mode: 'default', sessionId })
export const card = (id: string, kind: string, name: string, cfg: Record<string, unknown> = {}, x = 0, y = 0) =>
  ({ id, name, x, y, prompt: '', mode: 'default', kind, card: cfg })
export const link = (id: string, from: string, to: string, port?: string, maxPasses = 3) =>
  ({ id, from, to, cond: 'always', value: '', maxPasses, template: 'From {{from}}:\n{{output}}', ...(port ? { port } : {}) })

/** Modified-times, unique across every world a test file makes, as a real disk's would be. */
let clock = 1

/** Chats running outside the flow, in their own folders: what the running-chat browser offers. */
export type Running = { sessionId: string; name: string; cwd: string }

export function world(on: any, graph: { agents: unknown[]; links: unknown[] }, self = 'sid-a', others: Running[] = [], env: Record<string, string> = {}): World {
  const sessions = [...(graph.agents as { sessionId?: string; name: string; cwd?: string }[]).filter(a => a.sessionId), ...others]
  const files: Record<string, string> = {
    [FLOW]: JSON.stringify({ version: 2, id: 'f1', name: 'Test flow', ...graph }),
    [`${HOME}/.claude/agent-flows/agents.json`]: JSON.stringify(Object.fromEntries(sessions.filter(a => !others.includes(a as Running)).map(a => [a.sessionId, { flowFile: FLOW }]))),
  }
  // Every agent's chat is open in a tab.
  sessions.forEach((a, i) => {
    files[`${HOME}/.claude/sessions/${100 + i}.json`] = JSON.stringify({ sessionId: a.sessionId, pid: 100 + i, kind: 'interactive', name: a.name, cwd: a.cwd ?? ROOT, startedAt: 1 })
  })
  const w: World = { files, dirs: new Set(), sent: [], toasts: [], self: { id: self }, answer: { fn: () => 'YES' }, clipboard: { text: '' }, cmux: { tree: '', ran: [] } }
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map(f => [f, clock++]))
  const mtimeOf = (p: string) => mtimes[p] ?? Math.max(0, ...Object.keys(mtimes).filter(f => f.startsWith(p + '/')).map(f => mtimes[f]!))
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const isDir = (p: string) => w.dirs.has(p) || Object.keys(files).some(f => f.startsWith(p + '/'))
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: 'exists', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.env(on, { HOME, ...env })
  mock.store(on)
  on('session.root', async () => ({ value: ROOT }))
  on('clock.now', async () => ({ value: Date.now() }))
  on('session.id', async () => ({ value: w.self.id }))
  on('fs.read', async (_$: unknown, e: any) => {
    if (!(e.path in files)) throw missing(e.path)
    return { value: files[e.path] }
  })
  on('fs.write', async (_$: unknown, e: any) => {
    files[e.path] = e.text
    mtimes[e.path] = clock++
    return { value: undefined }
  })
  on('fs.exists', async (_$: unknown, e: any) => ({ value: e.path in files || isDir(e.path) }))
  on('fs.stat', async (_$: unknown, e: any) => {
    if (!(e.path in files) && !isDir(e.path)) throw missing(e.path)
    return { value: { kind: e.path in files ? 'file' : 'dir', size: 0, mtimeMs: mtimeOf(e.path), isLink: false } }
  })
  on('fs.list', async (_$: unknown, e: any) => {
    const names = new Set<string>()
    for (const f of [...Object.keys(files), ...w.dirs]) if (dirOf(f) === e.path) names.add(f.slice(e.path.length + 1))
    return { value: [...names].map(name => ({ name, kind: `${e.path}/${name}` in files ? 'file' : 'dir', size: 0, mtimeMs: 1, isLink: false })) }
  })
  on('process.run', async (_$: unknown, e: any) => {
    const [cmd, ...rest] = e.argv as string[]
    // Chat i runs in terminal ttys10i.
    if (cmd === 'ps' && rest.includes('tty=')) return ok(`ttys${rest[rest.length - 1]}\n`)
    if (cmd === 'ps') return ok(sessions.map((_, i) => String(100 + i)).join('\n'))
    if (cmd === '/cmux') {
      w.cmux.ran.push(rest)
      if (rest[0] === 'tree') return ok(w.cmux.tree)
    }
    if (cmd === 'pbpaste') return ok(w.clipboard.text)
    // A chat's transcript: found by name anywhere in the files, read from its tail.
    if (cmd === 'find' && rest.includes('-name')) {
      const name = rest[rest.indexOf('-name') + 1]!
      return ok(Object.keys(files).filter(f => f.endsWith(`/${name}`)).join('\n'))
    }
    if (cmd === 'tail') return ok(files[rest[rest.length - 1]!] ?? '')
    if (cmd === 'mv') {
      files[rest[2]!] = files[rest[1]!]!
      mtimes[rest[2]!] = clock++
      delete files[rest[1]!]
      delete mtimes[rest[1]!]
    }
    if (cmd === 'mkdir') {
      const path = rest[rest.length - 1]!
      if (rest[0] === '-p') {
        w.dirs.add(path)
        return ok()
      }
      if (isDir(path)) return fail()
      w.dirs.add(path)
    }
    return ok()
  })
  on('session.send', async (_$: unknown, e: any) => {
    w.sent.push({ to: JSON.stringify(e.to), text: e.text })
    return { isDelivered: true }
  })
  on('model.complete', async (_$: unknown, e: any) => ({ value: { isAnswered: true, text: w.answer.fn(String(e.prompt)) } }))
  on('ui.toast', async (_$: unknown, e: any) => {
    w.toasts.push(String(e.text ?? e.message ?? ''))
    return { value: undefined }
  })
  on('prompt.submit', async (_$: unknown, e: any) => ({ text: e.text }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer }))
  return w
}

export const settle = () => new Promise(r => setTimeout(r, 40))
export const turn = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as any
/** A message's first line with the run id taken out: runs get fresh ids. */
export const head = (text: string) => text.split('\n')[0]!.replace(/run [\w-]+ · /, '')
export const sentTo = (w: World, sessionId: string) => w.sent.filter(m => m.to.includes(sessionId))
