import { describe, expect, mock, test } from 'claude-code/testing'

import { applyLive, composeInstructions, parseChat, evaluateEdge, fillTemplate, instructionRefs, matchRecipient, parseStreamLine, parseTranscript, peerSection, previewOf, resolveRef, startLive, surfaceForTty } from '../hooks/flow'
import type { FlowEdge } from '../types'

const PANE = {
  plugin: 'agent-flows',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'agent-flows',
  // The hooks read only the viewport; the rest of the Pane's props are the engine's.
  props: { title: 'Agent Flows', isFocused: true, bodyColumns: 140, placement: 'inline' } as any,
  viewport: { columns: 140, rows: 40 },
} as const

const edge = (cond: FlowEdge['cond'], value = ''): FlowEdge => ({
  id: 'e', from: 'a', to: 'b', cond, value, maxPasses: 3, template: '{{from}}: {{output}}',
})
const never = async () => ''

describe('conditions', () => {
  test('text conditions match case-insensitively', async () => {
    expect(await evaluateEdge(edge('contains', 'pass'), 'All tests PASS', never)).toBe(true)
    expect(await evaluateEdge(edge('contains', 'pass'), 'FAIL', never)).toBe(false)
    expect(await evaluateEdge(edge('not-contains', 'fail'), 'All good', never)).toBe(true)
    expect(await evaluateEdge(edge('regex', '^score: [89]\\d'), 'Score: 92', never)).toBe(true)
    expect(await evaluateEdge(edge('regex', '(['), 'anything', never)).toBe(false)
    expect(await evaluateEdge(edge('always'), '', never)).toBe(true)
    expect(await evaluateEdge(edge('else'), '', never)).toBe(false)
  })

  test('judge asks the model and reads YES/NO', async () => {
    expect(await evaluateEdge(edge('judge', 'it approved'), 'LGTM', async () => 'YES')).toBe(true)
    expect(await evaluateEdge(edge('judge', 'it approved'), 'nope', async () => 'No.')).toBe(false)
  })

  test('template fills output and sender', () => {
    expect(fillTemplate('{{from}} says {{output}}', { from: 'Writer', output: 'hi' })).toBe('Writer says hi')
  })
})

describe('stream parsing', () => {
  test('previews text and tools, then the final result', () => {
    const a = parseStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Reading files\n\nnow' }, { type: 'tool_use', name: 'Read' }] },
    }))
    expect(a).toEqual({ kind: 'preview', lines: ['Reading files', 'now', '⚙ Read'] })
    expect(parseStreamLine(JSON.stringify({ type: 'result', result: 'Done', is_error: false })))
      .toEqual({ kind: 'result', text: 'Done', isError: false })
    expect(parseStreamLine('not json')).toBe(null)
  })

  test('a run shows what it is doing as it happens: starting, thinking, then its text as it is written', () => {
    const ev = (o: unknown) => parseStreamLine(JSON.stringify(o))!
    const delta = (d: unknown) => ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: d } })
    let live = startLive('▸ List countries')
    expect(previewOf(live)).toEqual(['▸ List countries', '… starting Claude'])
    live = applyLive(live, ev({ type: 'system', subtype: 'init' }))
    live = applyLive(live, delta({ type: 'thinking_delta', thinking: 'hmm' }))
    expect(previewOf(live)).toEqual(['▸ List countries', '… thinking'])
    live = applyLive(live, delta({ type: 'text_delta', text: 'Here are\nAfgh' }))
    live = applyLive(live, delta({ type: 'text_delta', text: 'anistan' }))
    expect(previewOf(live)).toEqual(['▸ List countries', 'Here are', 'Afghanistan'])
    // The finished message replaces the text written so far: nothing shows twice.
    live = applyLive(live, ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here are\nAfghanistan\nAlbania' }] } }))
    expect(previewOf(live)).toEqual(['▸ List countries', 'Here are', 'Afghanistan', 'Albania'])
    // A new message begins after a tool: back to waiting on Claude.
    live = applyLive(live, ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }))
    live = applyLive(live, delta({ type: 'text_delta', text: 'Saved' }))
    expect(previewOf(live).slice(-2)).toEqual(['⚙ Write', 'Saved'])
    expect(previewOf(live).length).toBeLessThanOrEqual(6)
  })
})

describe('interactive sessions', () => {
  const row = (type: string, content: unknown, stop?: string) =>
    JSON.stringify({ type, message: { role: type, content, ...(stop ? { stop_reason: stop } : {}) } })

  test('a finished turn shows the prompt and reply', () => {
    const tail = ['{"type":"attachment"}', row('user', 'Draft the intro'), row('assistant', [{ type: 'text', text: 'Here is the intro.' }], 'end_turn')].join('\n')
    expect(parseTranscript(tail, false)).toEqual({ status: 'done', preview: ['▸ Draft the intro', 'Here is the intro.'], lastOutput: 'Here is the intro.', thinking: '' })
  })

  test('a turn mid tool call is running, or idle once stale', () => {
    const tail = [row('user', 'Fix it'), row('assistant', [{ type: 'tool_use', name: 'Edit' }], 'tool_use'), row('user', [{ type: 'tool_result' }])].join('\n')
    expect(parseTranscript(tail, false)?.status).toBe('running')
    expect(parseTranscript(tail, false)?.preview).toEqual(['▸ Fix it', '⚙ Edit'])
    expect(parseTranscript(tail, true)?.status).toBe('idle')
  })
})

describe('connections', () => {
  const nodes = [
    { id: 'a', name: 'Session 1', sessionId: '11111111-aaaa' },
    { id: 'b', name: 'Session 10', sessionId: '22222222-bbbb' },
  ]

  test('a SendMessage address finds its canvas node', () => {
    expect(matchRecipient(nodes, 'Session 1-floofy-reef')?.id).toBe('a')
    expect(matchRecipient(nodes, 'session 10-quiet-owl')?.id).toBe('b')
    expect(matchRecipient(nodes, '22222222-bbbb')?.id).toBe('b')
    expect(matchRecipient(nodes, 'kdelta-5e')).toBeUndefined()
  })

  test('each session is told who it may talk to, and how', () => {
    const edges = [{ ...edge('contains', 'PASS'), from: 'a', to: 'b' }]
    expect(peerSection(nodes[0]!, nodes, edges)).toContain('"Session 10": you may send it only messages containing "PASS"')
    expect(peerSection(nodes[1]!, nodes, edges)).toContain('"Session 1": you may reply to it')
    expect(peerSection(nodes[0]!, nodes, [])).toContain('not linked to any other agent')
  })
})

describe('canvas', () => {
  test('two flows, agents in each, a link within one: all on the canvas, saved in the project', async ($, on) => {
    // The engine beneath the mod, in memory: a project folder, a home folder and the
    // few commands the mod runs (mv to save, rm to delete, find/ps for chats).
    const root = '/work/proj'
    const files: Record<string, { text: string; mtimeMs: number }> = {}
    let tick = 1
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
    const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    on('session.root', async () => ({ value: root }) as any)
    on('session.id', async () => ({ value: 'canvas-chat' }) as any)
    mock.env(on, { HOME: '/home/k' })
    mock.store(on)
    on('fs.read', async (_$, e) => {
      if (!files[e.path]) throw missing(e.path)
      return { value: files[e.path]!.text } as any
    })
    on('fs.write', async (_$, e) => {
      files[e.path] = { text: e.text, mtimeMs: tick++ }
      return { value: undefined } as any
    })
    on('fs.exists', async (_$, e) => ({ value: !!files[e.path] || Object.keys(files).some(f => f.startsWith(e.path + '/')) }) as any)
    on('fs.stat', async (_$, e) => {
      if (!files[e.path]) throw missing(e.path)
      return { value: { kind: 'file' as const, size: files[e.path]!.text.length, mtimeMs: files[e.path]!.mtimeMs, isLink: false } } as any
    })
    on('fs.list', async (_$, e) => ({
      value: Object.keys(files).filter(f => dirOf(f) === e.path).map(f => ({
        name: f.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: files[f]!.mtimeMs, isLink: false,
      })),
    }) as any)
    on('process.run', async (_$, e) => {
      const [cmd, ...rest] = e.argv
      if (cmd === 'mv') files[rest[2]!] = files[rest[1]!]!, delete files[rest[1]!]
      if (cmd === 'rm') delete files[rest[1]!]
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as any
    })
    const toasts: string[] = []
    on('ui.toast', async (_$, e: any) => {
      toasts.push(String(e.text ?? e.message ?? ''))
      return { value: undefined } as any
    })
    const savedFlows = async () =>
      Object.keys(files)
        .filter(f => dirOf(f) === `${root}/.claude/flows` && f.endsWith('.json'))
        .sort()
        .map(f => JSON.parse(files[f]!.text))

    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 136, rows: 30, in: 'canvas' })

    const click = async (x: number, y: number) => {
      await ui.pointer({ type: 'down', x, y, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', x, y, button: 'left', in: 'canvas' })
    }
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    // `minX` keeps the search to one panel; the details panel starts at column 98 here.
    const at = async (text: string, minX = 0) => {
      const all = await lines()
      const y = all.findIndex(r => r.indexOf(text, minX) >= 0)
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const typeInto = async (text: string, clear = 0) => {
      await ui.key({ key: 'end', in: 'canvas' }) // a click puts the cursor where it lands
      for (let i = 0; i < clear; i++) await ui.key({ key: 'backspace', in: 'canvas' })
      for (const key of text) await ui.key({ key, in: 'canvas' })
      await ui.key({ key: 'return', in: 'canvas' })
    }

    // An empty project: the list offers a new flow.
    expect(await ui.find({ in: 'canvas', text: /Flows · proj/ })).toBeDefined()
    const newFlow = await at('[ + New flow ]')
    await click(newFlow.x + 2, newFlow.y)
    expect(await savedFlows()).toHaveLength(1)

    // Rename it in the flow settings panel.
    const nameField = await at('FLOW NAME', 98)
    await click(nameField.x, nameField.y + 1)
    await typeInto('Writers', 'Flow 1'.length)
    expect((await savedFlows())[0]).toMatchObject({ version: 2, name: 'Writers' })

    // Two agents, from the list's Add card menu; then link the first to the second.
    const addAgent = async () => {
      await click((await at('+ Add card')).x, (await at('+ Add card')).y)
      const item = await at('A Claude chat')
      await click(item.x, item.y)
    }
    await addAgent()
    await click(90, 4) // empty canvas: clears the selection
    await addAgent()
    let [writers] = await savedFlows()
    expect(writers.agents.map((a: any) => a.name)).toEqual(['writers-agent1', 'writers-agent2'])
    const listed = await at('writers-agent1')
    await click(listed.x, listed.y)
    const link = await at('→ Link to…', 98)
    await click(link.x + 1, link.y)
    const target = await at('writers-agent2', 27)
    await click(target.x, target.y)
    ;[writers] = await savedFlows()
    expect(writers.links).toHaveLength(1)

    // A link carries every message; its panel sets max passes.
    const plus = await at('[ + ]', 98)
    await click(plus.x + 2, plus.y)
    ;[writers] = await savedFlows()
    expect(writers.links[0]).toMatchObject({ cond: 'always', maxPasses: 4 })

    // A second flow: the canvas switches to it, empty; the first is still listed.
    await click(90, 4)
    const another = await at('[ + New flow ]')
    await click(another.x + 2, another.y)
    expect(await savedFlows()).toHaveLength(2)
    expect((await lines()).join('\n')).toContain('This flow is empty')
    await at('Writers')

    // Back to the first: its agents and link are there.
    const back = await at('Writers')
    await click(back.x, back.y)
    expect((await lines()).some(r => r.includes('◆'))).toBe(true)

    // Run flow with no Start card adds one and says what to do.
    await click(90, 4)
    const run = await at('▶ Run flow', 98)
    await click(run.x + 2, run.y)
    expect(toasts.join('\n')).toContain('Added a Start card')
    ;[writers] = await savedFlows()
    expect(writers.agents.some((a: any) => a.kind === 'start')).toBe(true)
    expect(files[`${root}/.claude/flows/.gitignore`]?.text).toContain('*')
    expect(Object.keys(JSON.parse(files['/home/k/.claude/agent-flows/agents.json']?.text ?? '{}'))).toEqual([])

    // Another window adds an agent to Writers; an edit here keeps it.
    const writersFile = Object.keys(files).find(f => files[f]!.text.includes('"name": "Writers"'))!
    const other = JSON.parse(files[writersFile]!.text)
    other.agents.push({ id: 'ext00001', name: 'From elsewhere', x: 400, y: 400, prompt: '', mode: 'default' })
    files[writersFile] = { text: JSON.stringify(other), mtimeMs: tick++ }
    await click(90, 4) // Run flow selected the new Start card; back to the flow's settings
    const settings = await at('FLOW NAME', 98)
    await click(settings.x, settings.y + 1)
    await typeInto(' v2')
    const merged = JSON.parse(files[writersFile]!.text)
    expect(merged.name).toBe('Writers v2')
    expect(merged.agents.map((a: any) => a.name)).toContain('From elsewhere')

    await ui.unmount()
  })
})

describe('agent instructions', () => {
  const HOME = '/Users/k'
  const ROOT = '/Users/k/proj'
  test('a line that is just @path names a file to add', () => {
    expect(instructionRefs('You review.\n@CLAUDE.md\n  @~/.claude/agents.md  \nEmail me @ noon\n@CLAUDE.md')).toEqual(['CLAUDE.md', '~/.claude/agents.md'])
  })

  test('files in the project or the agent\'s folder, or .md files in ~/.claude; nothing else', () => {
    expect(resolveRef('CLAUDE.md', HOME, ROOT, ROOT)).toBe(`${ROOT}/CLAUDE.md`)
    expect(resolveRef('./docs/../AGENTS.md', HOME, ROOT, ROOT)).toBe(`${ROOT}/AGENTS.md`)
    expect(resolveRef('brief.md', HOME, ROOT, `${HOME}/other`)).toBe(`${HOME}/other/brief.md`) // the agent's own folder
    expect(resolveRef('~/.claude/CLAUDE.md', HOME, ROOT, ROOT)).toBe(`${HOME}/.claude/CLAUDE.md`)
    expect(resolveRef('~/.claude/settings.json', HOME, ROOT, ROOT)).toBeNull() // not markdown
    expect(resolveRef('~/.ssh/id_rsa', HOME, ROOT, ROOT)).toBeNull()
    expect(resolveRef('../secrets.md', HOME, ROOT, ROOT)).toBeNull()
    expect(resolveRef('/etc/passwd', HOME, ROOT, ROOT)).toBeNull()
  })

  test('the instructions come first, each file in place of its line; a file that can\'t be read says why', () => {
    const { text, problems } = composeInstructions('Checker', 'You check lists.\n@brief.md\n@~/.ssh/id_rsa', {
      'brief.md': { path: `${ROOT}/brief.md`, content: 'Only countries.' },
      '~/.ssh/id_rsa': { error: 'only files in the project, or .md files in ~/.claude' },
    })
    expect(text).toContain('[Agent Flows · your instructions as Checker]')
    expect(text).toContain('You check lists.')
    expect(text).toContain(`<file path="${ROOT}/brief.md">\nOnly countries.\n</file>`)
    expect(text).toContain("(@~/.ssh/id_rsa wasn't added: only files in the project, or .md files in ~/.claude)")
    expect(text.trimEnd().endsWith('[End of instructions. The message follows.]')).toBe(true)
    expect(problems).toEqual(["@~/.ssh/id_rsa wasn't added: only files in the project, or .md files in ~/.claude"])
  })

  test('a long file is cut, and says so', () => {
    const { text } = composeInstructions('A', '@big.md', { 'big.md': { path: '/p/big.md', content: 'x'.repeat(50000) } })
    expect(text).toContain('(cut at 40000 characters)')
    expect(text.length).toBeLessThan(41000)
  })
})

describe('finding an open chat\'s cmux tab', () => {
  const TREE = [
    'window window:1 [current] ◀ active',
    '├── workspace workspace:24 9F0E… "Agent Flows v0.8" [selected] ◀ active',
    '│   ├── pane pane:41 1A2B… [focused] ◀ active',
    '│   │   ├── surface surface:49 0F4AE8C2-1D3B-4C55-9A10-2B3C4D5E6F70 [terminal] "Agent Flows v0.8" [selected] ◀ active ◀ here tty=ttys022',
    '│   │   ├── surface surface:69 C7899D9A-9003-4163-AD54-9D29B70CAD1F [terminal] "✳ help-design-system-flow-agent1" tty=ttys021',
    '│   │   └── surface surface:70 D0000000-0000-4000-8000-000000000000 [terminal] "other" tty=ttys0210',
  ].join('\n')
  test('the tab whose terminal is the chat\'s', () => {
    expect(surfaceForTty(TREE, 'ttys021')).toBe('C7899D9A-9003-4163-AD54-9D29B70CAD1F')
    expect(surfaceForTty(TREE, '/dev/ttys022')).toBe('0F4AE8C2-1D3B-4C55-9A10-2B3C4D5E6F70')
  })
  test('none for a terminal no tab shows, or no terminal at all', () => {
    expect(surfaceForTty(TREE, 'ttys099')).toBeNull()
    expect(surfaceForTty(TREE, '??')).toBeNull()
    expect(surfaceForTty(TREE, '')).toBeNull()
  })
})

describe('watching an agent work', () => {
  const j = (o: unknown) => JSON.stringify(o)
  const delta = (d: unknown) => j({ type: 'stream_event', event: { type: 'content_block_delta', delta: d } })

  test("a background run keeps its thinking as it streams, and starts afresh after it writes", () => {
    let live = startLive('▸ Find questions')
    for (const line of [delta({ type: 'thinking_delta', thinking: 'Looking at the ' }), delta({ type: 'thinking_delta', thinking: 'channel' })]) {
      live = applyLive(live, parseStreamLine(line)!)
    }
    expect(live.thinking).toBe('Looking at the channel')
    expect(previewOf(live).at(-1)).toBe('… thinking')
    live = applyLive(live, parseStreamLine(delta({ type: 'text_delta', text: 'Found 3.' }))!)
    live = applyLive(live, parseStreamLine(delta({ type: 'thinking_delta', thinking: 'Now the links' }))!)
    expect(live.thinking).toBe('Now the links')
  })

  test("an open chat's transcript gives its latest thinking, and up to eight lines", () => {
    const rows = [
      j({ type: 'user', message: { content: 'Count them' } }),
      j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'First, the channel.' }, { type: 'tool_use', name: 'Grep' }], stop_reason: 'tool_use' } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') }] } }),
    ].join('\n')
    const view = parseTranscript(rows, false)!
    expect(view.thinking).toBe('First, the channel.')
    expect(view.preview).toHaveLength(8)
    expect(view.preview[0]).toBe('▸ Count them')
    expect(view.preview.at(-1)).toBe('line 10')
  })

  test('the chat view: typed messages, hand-offs named by sender, replies with tool calls on one line; commands left out', () => {
    const rows = [
      j({ type: 'user', message: { content: '<command-name>/mcp</command-name>' } }),
      j({ type: 'user', message: { content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/x" from-name="Lister">[Agent Flows · run r1 · hand-off 1]\nFrance, Japan</cross-session-message>\nThis came from another Claude session.' } }),
      j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }] } }),
      j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'secret file text' }] } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Kept: France' }] } }),
      j({ type: 'user', message: { content: 'Thanks, now Japan too' } }),
      j({ type: 'user', isMeta: true, message: { content: 'hidden' } }),
    ].join('\n')
    expect(parseChat(rows)).toEqual([
      { who: 'peer', from: 'Lister', text: '[Agent Flows · run r1 · hand-off 1]\nFrance, Japan' },
      { who: 'agent', text: '⚙ Read · ⚙ Grep' },
      { who: 'agent', text: 'Kept: France' },
      { who: 'you', text: 'Thanks, now Japan too' },
    ])
  })

  test('a very long chat keeps its newest messages, a huge one cut', () => {
    const rows = Array.from({ length: 100 }, (_, i) => j({ type: 'user', message: { content: `message ${i}` } }))
    rows.push(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(50000) }] } }))
    const chat = parseChat(rows.join('\n'))
    expect(chat.length).toBeLessThanOrEqual(60)
    expect(chat.at(-1)!.text).toContain('(cut here; the rest is in the chat)')
    expect(chat.at(-2)!.text).toBe('message 99')
  })
})
