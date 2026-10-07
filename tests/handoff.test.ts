import { describe, expect, mock, test } from 'claude-code/testing'

// Agent chats hand their replies to each other as their turns end, with no canvas
// open. The engine beneath is in memory: the flow file, the agent index, the
// running-chat registry, and the messages the mod sends.
const ROOT = '/work/proj'
const HOME = '/home/k'
const FLOW = `${ROOT}/.claude/flows/countries.json`

const agent = (id: string, name: string, sessionId: string) => ({ id, name, x: 0, y: 0, prompt: '', mode: 'default', sessionId })
const link = (id: string, from: string, to: string, maxPasses = 2) => ({
  id, from, to, cond: 'always', value: '', maxPasses, template: 'From {{from}}:\n{{output}}',
})

function world(on: any, opts: { self: string; links: unknown[] }) {
  const files: Record<string, string> = {
    [FLOW]: JSON.stringify({
      version: 1, id: 'f1', name: 'countryNames',
      agents: [agent('a', 'Lister', 'sid-a'), agent('b', 'Filter', 'sid-b')],
      links: opts.links,
    }),
    [`${HOME}/.claude/agent-flows/agents.json`]: JSON.stringify({ 'sid-a': { flowFile: FLOW }, 'sid-b': { flowFile: FLOW } }),
    // Both chats are open in a tab.
    [`${HOME}/.claude/sessions/101.json`]: JSON.stringify({ sessionId: 'sid-a', pid: 101, kind: 'interactive', name: 'Lister' }),
    [`${HOME}/.claude/sessions/102.json`]: JSON.stringify({ sessionId: 'sid-b', pid: 102, kind: 'interactive', name: 'Filter' }),
  }
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const sent: { to: unknown; text: string }[] = []
  mock.env(on, { HOME })
  mock.store(on)
  on('session.root', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: opts.self }))
  on('fs.read', async (_$: unknown, e: any) => {
    if (!(e.path in files)) throw missing(e.path)
    return { value: files[e.path] }
  })
  on('fs.write', async (_$: unknown, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', async (_$: unknown, e: any) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(e.path + '/')) }))
  on('fs.stat', async (_$: unknown, e: any) => {
    if (!(e.path in files) && !Object.keys(files).some(f => f.startsWith(e.path + '/'))) throw missing(e.path)
    return { value: { kind: 'file', size: 0, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', async (_$: unknown, e: any) => ({
    value: Object.keys(files).filter(f => dirOf(f) === e.path).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 1, isLink: false })),
  }))
  // `mkdir` fails on a folder that exists, so the mod's locks behave.
  const dirs = new Set<string>()
  on('process.run', async (_$: unknown, e: any) => {
    const [cmd, ...rest] = e.argv as string[]
    const isTaken = cmd === 'mkdir' && rest[0] !== '-p' && dirs.has(rest[rest.length - 1]!)
    if (cmd === 'mkdir') dirs.add(rest[rest.length - 1]!)
    return { value: { exitCode: isTaken ? 1 : 0, stdout: cmd === 'ps' ? '101\n102\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', async (_$: unknown, e: any) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', async (_$: unknown, e: any) => ({ text: e.text }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer }))
  return { sent, files }
}

const settle = () => new Promise(r => setTimeout(r, 30))
/** A message's first line with the run id taken out: runs get fresh ids. */
const head = (text: string) => text.split('\n')[0]!.replace(/run [\w-]+ · /, '')
const turn = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as any
const prompt = (text: string, kind: 'composer' | 'peer') => ({ text, wait: false, origin: { kind } }) as any

// How a peer's message really reaches a chat: wrapped by the engine.
const framed = (body: string) =>
  `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="Filter" from-plugin="agent-flows">\n${body}\n</cross-session-message>\n\nThis came from another Claude session.`

describe('hand-offs between agent chats', () => {
  test('a reply typed for in one chat goes to the chat it links to, tagged as hand-off 1', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b')] })
    await ($ as any).prompt.submit(prompt('Name all countries', 'composer'))
    await ($ as any).turn.complete(turn('France\nUnited Kingdom\nUnited States'))
    await settle()
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0]!.to)).toContain('sid-b')
    expect(head(sent[0]!.text)).toBe('[Agent Flows · hand-off 1]')
    expect(sent[0]!.text).toContain('\nFrom Lister:\nFrance')
  })

  test('linked both ways, the chats answer each other until the link\'s max passes in the run', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b', 2), link('l2', 'b', 'a', 2)] })
    // Lister answers each of Filter's messages in run r1; its link to Filter carries two.
    for (const hop of [1, 3, 5]) {
      await ($ as any).prompt.submit(prompt(`[Agent Flows · run r1 · hand-off ${hop}]\nFrom Filter:\nmore`, 'peer'))
      await ($ as any).turn.complete(turn(`reply ${hop}`))
      await settle()
    }
    expect(sent.map(m => m.text.split('\n')[0])).toEqual(['[Agent Flows · run r1 · hand-off 2]', '[Agent Flows · run r1 · hand-off 4]'])
  })

  test('an ordinary chat, an interrupted turn, or an empty answer hands nothing on', async ($, on) => {
    const { sent } = world(on, { self: 'sid-zzz', links: [link('l1', 'a', 'b')] })
    await ($ as any).turn.complete(turn('hello'))
    await settle()
    expect(sent).toHaveLength(0)
  })

  test('an agent with no outgoing link hands nothing on', async ($, on) => {
    const { sent } = world(on, { self: 'sid-b', links: [link('l1', 'a', 'b')] })
    await ($ as any).turn.complete(turn('Filtered list'))
    await ($ as any).turn.complete({ ...turn('partial'), isAborted: true, reason: 'aborted' })
    await settle()
    expect(sent).toHaveLength(0)
  })
})

describe('stopping chatter', () => {
  test('the run and count are read inside the engine\'s message envelope', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b', 2), link('l2', 'b', 'a', 2)] })
    await ($ as any).prompt.submit(prompt(framed('[Agent Flows · run r5 · hand-off 2]\nFrom Filter:\nok'), 'peer'))
    await ($ as any).turn.complete(turn('Done'))
    await settle()
    expect(sent.map(m => m.text.split('\n')[0])).toEqual(['[Agent Flows · run r5 · hand-off 3]'])
  })

  test('a message arriving is read even when no prompt event carries it', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b', 2)] })
    on('session.receive', async (_$: unknown, e: any) => ({ text: e.text }))
    await ($ as any).session.receive({ text: framed('[Agent Flows · run r4 · hand-off 2]\nFrom Filter:\nok'), origin: { kind: 'peer' } })
    await ($ as any).turn.complete(turn('Done'))
    await settle()
    expect(sent.map(m => m.text.split('\n')[0])).toEqual(['[Agent Flows · run r4 · hand-off 3]'])
  })

  test('typing in the chat starts the count again', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b', 2)] })
    await ($ as any).prompt.submit(prompt(framed('[Agent Flows · hand-off 2]\nFrom Filter:\nok'), 'peer'))
    await ($ as any).prompt.submit(prompt('New task: list three countries', 'composer'))
    await ($ as any).turn.complete(turn('Chad\nPeru\nFiji'))
    await settle()
    expect(sent.map(m => head(m.text))).toEqual(['[Agent Flows · hand-off 1]'])
  })

  test('a new chain reaching a chat counts from its own message, not an older chain', async ($, on) => {
    const { sent } = world(on, { self: 'sid-b', links: [link('l2', 'b', 'a', 2)] })
    // An earlier run used up this link's two passes here...
    for (const hop of [2, 4]) {
      await ($ as any).prompt.submit(prompt(framed(`[Agent Flows · run rA · hand-off ${hop}]\nFrom Lister:\nold`), 'peer'))
      await ($ as any).turn.complete(turn('old reply'))
      await settle()
    }
    // ...then the person starts a new task in the other chat: a new run, with passes of its own.
    await ($ as any).prompt.submit(prompt(framed('[Agent Flows · run rB · hand-off 1]\nFrom Lister:\nFrance\nUnited Kingdom'), 'peer'))
    await ($ as any).turn.complete(turn('France'))
    await settle()
    expect(sent.map(m => m.text.split('\n')[0]).at(-1)).toBe('[Agent Flows · run rB · hand-off 2]')
  })

  test('a reply of [no reply] is not handed on', async ($, on) => {
    const { sent } = world(on, { self: 'sid-a', links: [link('l1', 'a', 'b', 5)] })
    await ($ as any).turn.complete(turn('[no reply]'))
    await ($ as any).turn.complete(turn('  [No reply]\n'))
    await settle()
    expect(sent).toHaveLength(0)
  })
})
