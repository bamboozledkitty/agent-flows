import { describe, expect, test } from 'claude-code/testing'

import { FLOW, ROOT, agent, card, link, settle, world } from './world'

const PANE = {
  plugin: 'agent-flows', surface: 'terminal', component: 'Pane', requestId: 'agent-flows',
  props: { title: 'Agent Flows', isFocused: true, bodyColumns: 200, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } } as any,
  viewport: { columns: 200, rows: 44 },
} as const

describe('logic cards on the canvas', () => {
  test('cards show their outputs; link from an output dot; Run flow opens the command to edit, then runs it', async ($, on) => {
    const w = world(on, {
      agents: [
        card('s', 'start', 'Start', {}, 0, 0),
        agent('a', 'Lister', 'sid-a', 34, 0),
        card('i', 'if', 'Any United?', { check: 'contains', value: 'United' }, 68, 0),
        agent('b', 'Filter', 'sid-b', 68, 10),
        card('e', 'end', 'Done', { saveTo: 'countries.md' }, 34, 12),
        card('n', 'note', 'About', { text: 'Lists countries, drops the United ones' }, 0, 10),
      ].map(x => ({ ...x, ...(x.id === 's' ? { prompt: 'List five countries' } : {}) })),
      links: [link('1', 's', 'a'), link('2', 'a', 'i'), link('3', 'i', 'b', 'yes')],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 36, in: 'canvas' })

    const click = async (x: number, y: number) => {
      await ui.pointer({ type: 'down', x, y, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', x, y, button: 'left', in: 'canvas' })
    }
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0, maxX = 999) => {
      const all = await lines()
      const y = all.findIndex(r => { const i = r.indexOf(text, minX); return i >= 0 && i <= maxX })
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }

    const screen = (await lines()).join('\n')
    expect(screen).toContain('▶ Start')
    expect(screen).toContain('◇ Any United?')
    expect(screen).toContain('Yes ●')
    expect(screen).toContain('No ●')
    expect(screen).toContain('⚠ Nothing on No') // the If has nothing on No yet

    // Link If's No output to End: click the No dot, then the End card.
    const noDot = await at('No ●', 26, 160)
    await click(noDot.x + 3, noDot.y)
    const end = await at('■ Done', 26, 160)
    await click(end.x + 2, end.y)
    const saved = JSON.parse(w.files[FLOW]!)
    expect(saved.links.find((l: any) => l.from === 'i' && l.to === 'e')).toMatchObject({ port: 'no' })

    // Drag a link out of Lister's output dot onto End: a live line follows the pointer.
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...from, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'move', x: Math.round((from.x + to.x) / 2), y: from.y, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'move', ...to, button: 'left', in: 'canvas' })
      const mid = (await lines()).join('\n')
      await ui.pointer({ type: 'up', ...to, button: 'left', in: 'canvas' })
      return mid
    }
    const listerRow = (await lines()).findIndex(r => r.includes('Lister'))
    const dotY = listerRow + 3 // the dot sits in the sockets row, under the title band
    const dotX = (await lines())[dotY]!.indexOf('●', (await lines())[listerRow]!.indexOf('Lister'))
    const doneCard = await at('■ Done', 26, 160)
    const mid = await drag({ x: dotX, y: dotY }, { x: doneCard.x + 4, y: doneCard.y + 2 })
    expect(mid).toContain('◉') // the pointer end, over a card that can take the link
    const afterDrag = JSON.parse(w.files[FLOW]!)
    expect(afterDrag.links.some((l: any) => l.from === 'a' && l.to === 'e')).toBe(true)

    // Every link enters its target's input dot on the left: ▶◉.
    const filterName = await at('Filter', 26, 160)
    const inputRow = (await lines())[filterName.y + 3]!
    const filterInput = { x: inputRow.lastIndexOf('◉', filterName.x), y: filterName.y + 3 }
    expect(inputRow[filterInput.x - 1]).toBe('▶')

    // Two refused drops, each saying why on the canvas and making no link.
    const linksNow = () => JSON.parse(w.files[FLOW]!).links.length
    const count = linksNow()
    const yesDot = await at('Yes ●', 26, 160)
    let mid2 = await drag({ x: dotX, y: dotY }, { x: yesDot.x + 4, y: yesDot.y })
    expect(mid2).toContain('Outputs link to inputs')
    expect(linksNow()).toBe(count)
    const doneInput = { x: doneCard.x - 2, y: doneCard.y + 2 }
    expect((await lines())[doneInput.y]![doneInput.x]).toBe('◉')
    mid2 = await drag(doneInput, filterInput)
    expect(mid2).toContain('Inputs link to outputs')
    expect(linksNow()).toBe(count)
    expect((await lines()).join('\n')).toContain('⚠ Inputs link to outputs') // stays until the next click

    // Drag back from End's input onto Filter: a link Filter → End.
    await drag(doneInput, { x: filterName.x + 4, y: filterName.y + 2 })
    expect(JSON.parse(w.files[FLOW]!).links.some((l: any) => l.from === 'b' && l.to === 'e')).toBe(true)

    // Drag an arrowhead to re-wire: If's Yes → Filter now points at End.
    await drag({ x: filterInput.x - 1, y: filterInput.y }, { x: doneCard.x + 6, y: doneCard.y + 3 })
    const rewired = JSON.parse(w.files[FLOW]!)
    expect(rewired.links.find((l: any) => l.id === '3')).toMatchObject({ from: 'i', to: 'e', port: 'yes' })

    // Dropping on empty canvas makes no link.
    const before = JSON.parse(w.files[FLOW]!).links.length
    await drag({ x: dotX, y: dotY }, { x: 40, y: 30 })
    expect(JSON.parse(w.files[FLOW]!).links.length).toBe(before)

    // The If card's panel: its condition and both outputs.
    const iff = await at('◇ Any United?', 26, 160)
    await click(iff.x + 2, iff.y)
    expect((await lines()).join('\n')).toContain('PASSES WHEN')

    // Run flow: the Start card's command opens to edit; add to it and run.
    await click(120, 34)
    const run = await at('▶ Run flow', 160)
    await click(run.x + 2, run.y)
    expect((await lines()).join('\n')).toContain('List five countries')
    for (const ch of ' please') await ui.key({ key: ch === ' ' ? 'space' : ch, in: 'canvas' })
    await ui.key({ key: 'return', in: 'canvas' })
    await settle()
    // Lister's chat is open: the command arrives there, tagged as the run's first hand-off.
    const toLister = w.sent.filter(m => m.to.includes('sid-a'))
    expect(toLister).toHaveLength(1)
    expect(toLister[0]!.text).toContain('List five countries please')
    expect(JSON.parse(w.files[FLOW]!).agents.find((a: any) => a.id === 's').prompt).toBe('List five countries please')

    // Add card menu lists every kind.
    await ui.key({ key: 'n', in: 'canvas' })
    const menu = (await lines()).join('\n')
    for (const label of ['Agent', 'Start', 'If / Else', 'Switch', 'And (all)', 'Or (first)', 'Prompt', 'Loop until', 'Model', 'End', 'Note']) expect(menu).toContain(label)
    await ui.unmount()
  })
})

describe('the Model card', () => {
  test("links into an agent's model dot, refuses other wiring, and picks from the aliases and the extra models", { options: { extraModels: 'claude-sonnet-5-5, claude-haiku-4-5-20251001 --bad' } }, async ($, on) => {
    const w = world(on, {
      agents: [
        card('m', 'model', 'Fast', { model: 'claude-haiku-4-5-20251001' }, 0, 0),
        agent('a', 'Writer', 'sid-a', 40, 0),
        agent('b', 'Checker', 'sid-b', 40, 12),
        card('i', 'if', 'Done?', { check: 'contains', value: 'ok' }, 80, 0),
        card('m2', 'model', 'Deep', { model: 'claude-opus-5-5', effort: 'max' }, 0, 12),
      ],
      links: [],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })

    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0, maxX = 999) => {
      const all = await lines()
      const y = all.findIndex(r => { const i = r.indexOf(text, minX); return i >= 0 && i <= maxX })
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (x: number, y: number) => {
      await ui.pointer({ type: 'down', x, y, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', x, y, button: 'left', in: 'canvas' })
    }
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...from, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'move', ...to, button: 'left', in: 'canvas' })
      const mid = (await lines()).join('\n')
      await ui.pointer({ type: 'up', ...to, button: 'left', in: 'canvas' })
      return mid
    }
    const saved = () => JSON.parse(w.files[FLOW]!)
    // A Model card's output dot: on its right edge, in the sockets row two under its name. An agent's model dot: left edge, four under its name.
    const outDot = async (name: string) => { const p = await at(`◈ ${name}`, 26, 160); return { x: p.x + 25, y: p.y + 2 } }
    const modelDot = async (name: string) => { const p = await at(name, 26, 160); return { x: p.x - 2, y: p.y + 4 } }

    expect((await lines()).join('\n')).toContain('⚠ Link it to an agent')
    expect((await lines())[(await modelDot('Writer')).y]![(await modelDot('Writer')).x]).toBe('○')

    // Model → Writer: a model link; the card shows the model beside its filled model dot.
    const writer = await at('Writer', 26, 160)
    await drag(await outDot('Fast'), { x: writer.x + 4, y: writer.y + 1 })
    expect(saved().links).toMatchObject([{ from: 'm', to: 'a' }])
    expect((await lines()).join('\n')).toContain('model  haiku-4-5-2025')
    expect((await lines())[(await modelDot('Writer')).y]![(await modelDot('Writer')).x]).toBe('◉')

    // Refused: a Model card onto an If; another agent's output onto a model dot.
    const ifCard = await at('◇ Done?', 26, 160)
    expect(await drag(await outDot('Fast'), { x: ifCard.x + 4, y: ifCard.y + 1 })).toContain('Only agents take a model')
    const checker = await at('Checker', 26, 160)
    const checkerOut = { x: checker.x + 25, y: checker.y + 3 }
    expect(await drag(checkerOut, await modelDot('Writer'))).toContain('Only a Model card links here')
    expect(saved().links).toHaveLength(1)

    // A second Model card replaces the first: an agent runs with one model.
    await drag(await outDot('Deep'), { x: writer.x + 4, y: writer.y + 1 })
    expect(saved().links).toMatchObject([{ from: 'm2', to: 'a' }])
    expect((await lines()).join('\n')).toContain('model  opus-5-5 · max')

    // The panel lists Opus, Sonnet and Haiku, then the option's ids; an entry that is no model id is named.
    const fast = await at('◈ Fast', 26, 160)
    await click(fast.x + 2, fast.y)
    await settle()
    const panel = (await lines()).join('\n')
    expect(panel).toContain('◉ haiku-4-5-20251001')
    expect(panel).toContain('○ sonnet-5-5')
    for (const alias of ['○ opus', '○ sonnet', '○ haiku']) expect(panel).toContain(alias)
    expect(panel).toContain('--bad')
    const sonnet = await at('○ sonnet-5-5', 160)
    await click(sonnet.x + 2, sonnet.y)
    const high = await at('○ High', 160)
    await click(high.x + 2, high.y)
    expect(saved().agents.find((n: any) => n.id === 'm').card).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
    const auto = await at('○ Default', 160)
    await click(auto.x + 2, auto.y)
    expect(saved().agents.find((n: any) => n.id === 'm').card).toEqual({ model: 'claude-sonnet-5-5' })
    await ui.unmount()
  })

  test('with no options it offers opus, sonnet and haiku, and calls nothing', async ($, on) => {
    world(on, { agents: [card('m', 'model', 'Fast', {}, 0, 0)], links: [] }, 'canvas-chat')
    const called: string[] = []
    on('settings.read', async () => (called.push('settings.read'), { value: {} }))
    on('http.fetch', async () => (called.push('http.fetch'), { value: { status: 200, ok: true, headers: {}, text: '{}' } }))
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const y = (await lines()).findIndex(r => r.includes('◈ Fast'))
    const x = (await lines())[y]!.indexOf('◈ Fast')
    await ui.pointer({ type: 'down', x: x + 2, y, button: 'left', in: 'canvas' })
    await ui.pointer({ type: 'up', x: x + 2, y, button: 'left', in: 'canvas' })
    await settle()
    const panel = (await lines()).join('\n')
    for (const alias of ['○ opus', '○ sonnet', '○ haiku']) expect(panel).toContain(alias)
    expect(panel).not.toContain('Left out')
    expect(panel).toContain('⚠ Pick a model')
    expect(called).toEqual([])
    await ui.unmount()
  })

  test('a background run starts the agent with its Model card\'s model and effort', async ($, on) => {
    world(on, {
      agents: [
        card('m', 'model', 'Deep', { model: 'claude-opus-5-5', effort: 'max' }, 0, 0),
        { ...agent('a', 'Writer', '', 40, 0), prompt: 'Write a haiku' },
        { ...agent('b', 'Plain', '', 74, 0), prompt: 'Say hi' }, // beside Writer: Writer's drawer hangs below it
      ],
      links: [link('1', 'm', 'a')],
    }, 'canvas-chat')
    const spawned: string[][] = []
    on('process.spawn', async function* (_$: unknown, e: any) {
      spawned.push([...e.argv])
      return { value: { code: 0, signal: null } }
    } as any)
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0) => {
      const all = await lines()
      const y = all.findIndex(r => r.indexOf(text, minX) >= 0)
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
    }
    for (const name of ['Writer', 'Plain']) {
      const c = await at(name, 26)
      await click({ x: c.x + 2, y: c.y })
      const run = await at('[ ▶ Test', 160)
      await click({ x: run.x + 2, y: run.y }) // the test message box, last message filled in
      await ui.key({ key: 'return', in: 'canvas' })
      await settle()
    }
    expect(spawned).toHaveLength(2)
    expect(spawned[0]!.join(' ')).toContain('--model claude-opus-5-5 --effort max')
    expect(spawned[1]!.join(' ')).not.toContain('--model')
    await ui.unmount()
  })
})

describe('zoom', () => {
  test('zooms out to compact cards that still link and move, and back in', async ($, on) => {
    const w = world(on, {
      agents: [
        card('m', 'model', 'Fast', { model: 'claude-haiku-4-5-20251001' }, 0, 0),
        agent('a', 'Writer', 'sid-a', 40, 0),
        card('i', 'if', 'Done?', { check: 'contains', value: 'ok' }, 80, 0),
      ],
      links: [link('1', 'a', 'i')],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0, maxX = 999) => {
      const all = await lines()
      const y = all.findIndex(r => { const i = r.indexOf(text, minX); return i >= 0 && i <= maxX })
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
    }
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...from, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'move', ...to, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...to, button: 'left', in: 'canvas' })
    }
    const saved = () => JSON.parse(w.files[FLOW]!)

    // The controls sit at the bottom left of the canvas, right of the Flows list.
    const ctl = await at('[ − ]')
    expect(ctl.y).toBe((await lines()).length - 1)
    expect((await lines())[ctl.y]).toContain('100%')
    // Card left edges: an agent's name sits 2 cells in, a logic card's 4 (after its icon).
    const gapBetween = async () => ((await at('Done?', 26)).x - 4) - ((await at('Writer', 26)).x - 2)
    const fullGap = await gapBetween()

    await click({ x: ctl.x + 2, y: ctl.y })
    await click({ x: ctl.x + 2, y: ctl.y })
    expect((await lines())[ctl.y]).toContain('50%')
    // Half the distance between cards, and compact cards: name, then status or outputs.
    const writer = await at('Writer', 26)
    expect(await gapBetween()).toBe(fullGap / 2)
    expect((await lines())[writer.y + 1]).toContain('○ Idle')
    expect((await lines()).join('\n')).toContain('Yes ●')

    // Link the Model card into Writer's model dot, zoomed out.
    const fast = await at('◈ Fast', 26)
    await drag({ x: fast.x + 11, y: fast.y }, { x: writer.x - 2, y: writer.y + 1 })
    expect(saved().links.some((l: any) => l.from === 'm' && l.to === 'a')).toBe(true)

    // Moving a card 5 cells at 50% moves it 10 in the flow.
    const before = saved().agents.find((n: any) => n.id === 'a')
    await drag({ x: writer.x + 1, y: writer.y }, { x: writer.x + 6, y: writer.y })
    const after = saved().agents.find((n: any) => n.id === 'a')
    expect(after.x - before.x).toBe(10)

    // Keys: + zooms in a step, 0 back to 100%.
    await ui.key({ key: '+', in: 'canvas' })
    expect((await lines())[ctl.y]).toContain('75%')
    await ui.key({ key: '0', in: 'canvas' })
    expect((await lines())[ctl.y]).toContain('100%')
    expect((await lines()).join('\n')).toContain('model  haiku-4-5-2025') // full cards again
    await ui.unmount()
  })
})

describe('the running-chat browser', () => {
  test('starts in the project, marks folders holding chats, searches, browses, takes a pasted path, scrolls, and adds a chat', async ($, on) => {
    const others = [
      { sessionId: 's-review', name: 'Skill Review Chat', cwd: ROOT },
      { sessionId: 's-eval', name: 'Eval runner', cwd: `${ROOT}/packages/eval-lab` },
      { sessionId: 's-docs', name: 'Docs helper', cwd: `${ROOT}/packages/docs` },
      ...Array.from({ length: 25 }, (_, i) => ({ sessionId: `s-b${i}`, name: `Batch ${i + 1}`, cwd: `${ROOT}/batch` })),
      { sessionId: 's-else', name: 'Elsewhere', cwd: '/work/other' },
    ]
    const w = world(on, { agents: [agent('a', 'Writer', 'sid-a', 40, 0)], links: [] }, 'canvas-chat', others)
    for (const d of ['packages', 'packages/eval-lab', 'packages/docs', 'batch', 'empty', '.git']) w.dirs.add(`${ROOT}/${d}`)
    w.dirs.add('/work/other')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const screen = async () => (await lines()).join('\n')
    const at = async (text: string) => {
      const all = await lines()
      const y = all.findIndex(r => r.includes(text))
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
      await settle()
    }
    const key = async (k: string) => { await ui.key({ key: k, in: 'canvas' }); await settle() }
    const type = async (text: string) => { for (const ch of text) await key(ch === ' ' ? 'space' : ch) }

    await key('a')
    let s = await screen()
    expect(s).toContain('Folder  /work/proj')
    expect(s).toContain('batch/')
    expect(s).toContain('● 25 chats')
    expect(s).toContain('packages/')
    expect(s).toContain('● 2 chats')
    expect(s).toContain('empty/')
    expect(s).not.toContain('.git/') // hidden, holds no chat
    expect(s).not.toContain('Elsewhere') // outside this folder
    expect(s).toMatch(/Eval runner\s+packages\/eval-lab/) // where each runs, from this folder
    expect(s.indexOf('batch/')).toBeLessThan(s.indexOf('empty/')) // folders with chats first

    // Search, by name or folder.
    await type('eval')
    s = await screen()
    expect(s).toContain('Eval runner')
    expect(s).not.toContain('Skill Review Chat')
    expect(s).not.toContain('batch/')
    for (let i = 0; i < 4; i++) await key('backspace')

    // Into a folder, and back up.
    await click(await at('packages/'))
    s = await screen()
    expect(s).toContain('Folder  /work/proj/packages')
    expect(s).toContain('eval-lab/')
    expect(s).not.toContain('Skill Review Chat')
    await click(await at('[ ↑ Up ]'))
    expect(await screen()).toContain('Folder  /work/proj ')

    // More rows than fit: page down scrolls.
    const firstRange = (await screen()).match(/1–(\d+) of (\d+)/)!
    expect(Number(firstRange[2])).toBe(3 + 28) // 3 folders + every chat in or below: Skill Review, Eval, Docs, 25 Batch
    await key('pagedown')
    await key('pagedown')
    expect(await screen()).not.toContain(firstRange[0])
    expect(await screen()).toMatch(/›/)

    // A pasted path in the folder box (one key event), then Enter; a missing one says so.
    await click(await at('Folder  /work/proj'))
    for (let i = 0; i < '/work/proj'.length; i++) await key('backspace')
    await key('/nope')
    await key('return')
    expect(await screen()).toContain('⚠ No folder at /nope')
    // A path to a file opens the folder it's in.
    await click(await at('Folder  /work/proj'))
    for (let i = 0; i < '/work/proj'.length; i++) await key('backspace')
    await key(`${FLOW}`)
    await key('return')
    expect(await screen()).toContain('Folder  /work/proj/.claude/flows')
    await click(await at('[ ↑ Up ]'))
    await click(await at('[ ↑ Up ]'))
    await click(await at('Folder  /work/proj'))
    for (let i = 0; i < '/work/proj'.length; i++) await key('backspace')
    await key('/work/other/')
    await key('return')
    s = await screen()
    expect(s).toContain('Folder  /work/other')
    expect(s).toContain('Elsewhere')

    // Enter adds the highlighted chat to the flow.
    await key('return')
    expect(JSON.parse(w.files[FLOW]!).agents.map((n: any) => n.name)).toContain('Elsewhere')
    await ui.unmount()
  })
})

describe('typing in a text box', () => {
  test('the cursor moves with the arrows, Home and End, up and down a wrapped box, and a click; Ctrl+V and Cmd+V paste at it', async ($, on) => {
    const w = world(on, { agents: [card('s', 'start', 'Start', {}, 0, 0), agent('a', 'Writer', 'sid-a', 40, 0)], links: [link('1', 's', 'a')] }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    const pane = { isFocused: true }
    on('ui.panes', async () => ({ value: [{ id: 'agent-flows', title: 'Agent Flows', isShown: true, isPlaced: true, ...pane }] }) as any)
    // The prompt box itself: the edit made.
    on('prompt.edit', async (_$: unknown, e: any) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0) => {
      const all = await lines()
      const y = all.findIndex(r => r.indexOf(text, minX) >= 0)
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
      await settle()
    }
    const key = async (k: string, mods: Record<string, true> = {}) => { await ui.key({ key: k, ...mods, in: 'canvas' }); await settle() }
    const type = async (text: string) => { for (const ch of text) await key(ch === ' ' ? 'space' : ch) }
    const command = () => JSON.parse(w.files[FLOW]!).agents.find((n: any) => n.id === 's').prompt

    // The Start card's COMMAND box.
    const start = await at('▶ Start', 26)
    await click({ x: start.x + 2, y: start.y })
    const placeholder = await at('What the run begins with', 160)
    await click(placeholder)
    await type('helo')
    await key('left')
    await type('l') // into the middle
    await key('end')
    await type(' world')
    await key('home')
    await type('>')
    expect((await lines()).join('\n')).toContain('>▏hello world')

    // Cmd+V: the clipboard goes in at the cursor.
    w.clipboard.text = 'PASTED\nTEXT '
    await key('v', { meta: true })
    expect((await lines()).join('\n')).toContain('>PASTED TEXT ▏hello world')

    // A click on a letter puts the cursor before it.
    const row = await at('>PASTED TEXT', 160)
    await click({ x: row.x + '>PASTED TEXT '.length + 1, y: row.y }) // past the cursor mark, on the "h"
    await type('X')
    await key('return')
    expect(command()).toBe('>PASTED TEXT Xhello world')

    // A wrapped box: up goes to the line above, at the same column.
    const value = await at('>PASTED TEXT', 160)
    await click({ x: value.x, y: value.y })
    await key('end')
    await type(' and a second line that wraps')
    await key('up')
    await key('home')
    await type('^')
    await key('return')
    expect(command()).toBe('^>PASTED TEXT Xhello world and a second line that wraps')

    // Cmd+V is the terminal's: it pastes into Claude's prompt box. While the canvas has the keys, it comes here instead.
    const promptPaste = async (inputText: string) => {
      const r = await ($ as any).prompt.edit({ origin: { kind: 'composer' }, text: 'draft', cursor: 5, start: 5, end: 5, inputText })
      await settle()
      return r
    }
    // With no text box open, the canvas says where to click.
    expect(await promptPaste('KEEP')).toEqual({ text: 'draft', cursor: 5 })
    expect((await lines()).join('\n')).toContain('Click a text box to paste into it.')
    // With one open, the paste goes in at its cursor and the prompt box is left as it was.
    const box = await at('^>PASTED', 160)
    await click({ x: box.x, y: box.y })
    await key('home')
    expect(await promptPaste('CMD\nV ')).toEqual({ text: 'draft', cursor: 5 })
    expect((await lines()).join('\n')).toContain('CMD V ▏^>PASTED')
    // A typed key, or the canvas not holding the keys, is the prompt box's.
    pane.isFocused = false
    expect(await promptPaste('ELSEWHERE')).toEqual({ text: 'draftELSEWHERE', cursor: 14 })
    expect((await lines()).join('\n')).not.toContain('ELSEWHERE')
    await ui.unmount()
  })
})

describe('a text box left without Enter', () => {
  test("keeps what was typed: Run flow runs the edited command, and a click away saves a card's text", async ($, on) => {
    const w = world(on, {
      agents: [{ ...card('s', 'start', 'Start', {}, 0, 0), prompt: 'Find questions' }, agent('a', 'Finder', 'sid-a', 40, 0)],
      links: [link('1', 's', 'a')],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0) => {
      const all = await lines()
      const y = all.findIndex(r => r.indexOf(text, minX) >= 0)
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
      await settle()
    }
    const type = async (text: string) => {
      for (const ch of text) await ui.key({ key: ch === ' ' ? 'space' : ch, in: 'canvas' })
      await settle()
    }
    const saved = () => JSON.parse(w.files[FLOW]!).agents.find((n: any) => n.id === 's').prompt

    // Edit the Start card's command, then go straight to Run flow: no Enter.
    const start = await at('▶ Start', 26)
    await click({ x: start.x + 2, y: start.y })
    await click(await at('Find questions', 160))
    await ui.key({ key: 'end', in: 'canvas' })
    await type(' and list their links')
    await click(await at('▶ Run flow', 160))
    expect((await lines()).join('\n')).toContain('Find questions and list their links')
    expect(saved()).toBe('Find questions and list their links')
    await ui.key({ key: 'return', in: 'canvas' })
    await settle()
    expect(w.sent.filter(m => m.to.includes('sid-a')).map(m => m.text).join('\n')).toContain('Find questions and list their links')

    // A click on empty canvas also keeps the typing (the box wraps: "links" is its second line).
    await click(await at('links ', 160))
    await ui.key({ key: 'end', in: 'canvas' })
    await type('!')
    await click({ x: 100, y: 30 })
    expect(saved()).toBe('Find questions and list their links!')
    await ui.unmount()
  })
})

describe('reading what an agent did', () => {
  test('a long name wraps on its card; View chat opens its conversation over the canvas; q closes it', async ($, on) => {
    const w = world(on, { agents: [agent('a', 'help-design-system-flow-agent1', 'sid-a', 0, 0)], links: [] }, 'canvas-chat')
    const j = (o: unknown) => JSON.stringify(o)
    w.files['/home/k/.claude/projects/-work-proj/sid-a.jsonl'] = [
      j({ type: 'user', message: { content: 'Find the newest questions' } }),
      j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'slack_read_channel' }] } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: '**3 of the 5** have earlier answers.\nThe Muted Chatter thread was answered by the design systems team last week.' }] } }),
    ].join('\n')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const at = async (text: string, minX = 0) => {
      const all = await lines()
      const y = all.findIndex(r => r.indexOf(text, minX) >= 0)
      if (y < 0) throw new Error(`not on screen: ${text}\n${all.join('\n')}`)
      return { x: all[y]!.indexOf(text, minX), y }
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
      await settle()
    }

    // The card's name in two lines, broken after a hyphen, not cut in the middle.
    const screen = (await lines()).join('\n')
    expect(screen).toMatch(/│ help-design-system- +(⧉ )?│/)
    expect(screen).toMatch(/│ flow-agent1 +│/)

    // Its panel: View chat; the conversation opens, newest last, read-only.
    const card = await at('help-design-system-', 26)
    await click({ x: card.x, y: card.y })
    // On the card, unselected: the newest text wrapped over its last rows, markdown's ** gone.
    // Unselected, the card shows its status and a way to its work, not a cut-off line of it.
    expect(screen).toContain('See response ›')
    expect(screen).not.toContain('design systems team')

    // Selected: a drawer under the card, wider than it, with the prompt and the newest lines in full.
    const drawn = (await lines()).join('\n')
    expect(drawn).toContain('▸ Find the newest questions')
    expect(drawn).toContain('⚙ slack_read_channel')
    expect(drawn).toContain('3 of the 5 have earlier answers.')
    expect(drawn).toContain('View chat (v) for all of it ›')
    expect(drawn).not.toContain('**')
    // The side panel keeps to settings: the agent's output lives on the canvas.
    const side = (await lines()).map(r => r.slice(160)).join('\n')
    expect(side).not.toContain('LAST ACTIVITY')
    expect(side).not.toContain('LATEST ANSWER')
    // Its buttons line up: two to a row, the same width.
    const grid = (await lines()).map(r => r.slice(160)).filter(r => r.includes('[ ▶ Test') || r.includes('[ Open in tab'))
    expect(grid).toHaveLength(2)
    expect(grid[0]!.indexOf('[ View chat')).toBe(grid[1]!.indexOf('[ → Link to…'))

    await click(await at('[ View chat', 160))
    const view = (await lines()).join('\n')
    expect(view).toContain('read-only')
    expect(view).toContain('Find the newest questions')
    expect(view).toContain('⚙ slack_read_channel')
    expect(view).toContain('3 of the 5 have earlier answers.')
    await ui.key({ key: 'q', in: 'canvas' })
    await settle()
    expect((await lines()).join('\n')).not.toContain('read-only')

    // The card's See response opens the chat view too.
    await click(await at('See response ›', 26))
    expect((await lines()).join('\n')).toContain('read-only')
    await ui.key({ key: 'q', in: 'canvas' })
    await settle()

    // A long panel scrolls: ▼ moves on, and PgUp comes back.
    const panel = (await lines()).join('\n')
    if (panel.includes(' of ') && panel.includes('PgUp PgDn')) {
      await click(await at('▼', 160))
      expect((await lines()).join('\n')).toContain('LATEST ANSWER')
    }
    await ui.unmount()
  })
})

describe('link notices', () => {
  test('only agents linked to agents are told; a Model card or a logic card link is set and removed silently', async ($, on) => {
    const w = world(on, {
      agents: [card('m', 'model', 'Fast', { model: 'claude-haiku-4-5-20251001' }, 0, 0), agent('a', 'Writer', 'sid-a', 40, 0), card('i', 'if', 'Done?', { check: 'contains', value: 'ok' }, 80, 0)],
      links: [link('1', 'm', 'a'), link('2', 'a', 'i')],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map(r => r.text)
    const handles = async () => {
      const all = await lines()
      return all.flatMap((r, y) => [...r.matchAll(/◆/g)].filter(m => m.index! > 26 && m.index! < 160 && r[m.index! + 1] === '─').map(m => ({ x: m.index!, y })))
    }
    const click = async (p: { x: number; y: number }) => {
      await ui.pointer({ type: 'down', ...p, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', ...p, button: 'left', in: 'canvas' })
      await settle()
    }
    // Delete both links by their ◆ handles.
    for (let i = 0; i < 2; i++) {
      const [h] = await handles()
      await click(h!)
      await ui.key({ key: 'x', in: 'canvas' })
      await settle()
    }
    expect(JSON.parse(w.files[FLOW]!).links).toHaveLength(0)
    expect(w.sent.filter(m => m.text.includes('[Agent Flows · notice]'))).toEqual([])
    await ui.unmount()
  })
})

describe('opening an agent that is already open', () => {
  const setup = async ($: any, on: any, env: Record<string, string>) => {
    const w = world(on, { agents: [agent('a', 'Writer', 'sid-a', 40, 0)], links: [] }, 'canvas-chat', [], env)
    // The chat runs as pid 100, in terminal ttys100, shown by one cmux tab.
    w.cmux.tree = [
      '├── workspace workspace:3 AAAA "Agents"',
      '│   └── pane pane:4 BBBB',
      '│       ├── surface surface:7 C7899D9A-9003-4163-AD54-9D29B70CAD1F [terminal] "✳ Writer" tty=ttys100',
      '│       └── surface surface:8 D0000000-0000-4000-8000-000000000000 [terminal] "other" tty=ttys1000',
    ].join('\n')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await $.command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    await ui.resize({ columns: 200, rows: 40, in: 'canvas' })
    const lines = async () => (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).map((r: any) => r.text)
    const click = async (text: string, minX: number) => {
      const all = await lines()
      const y = all.findIndex((r: string) => r.indexOf(text, minX) >= 0)
      const x = all[y]!.indexOf(text, minX)
      await ui.pointer({ type: 'down', x: x + 2, y, button: 'left', in: 'canvas' })
      await ui.pointer({ type: 'up', x: x + 2, y, button: 'left', in: 'canvas' })
      await settle()
    }
    await click('Writer', 26)
    await click('[ Open in tab', 160)
    return { w, ui }
  }

  test('in cmux it switches to the tab the chat runs in', async ($, on) => {
    const { w, ui } = await setup($, on, { CMUX_BUNDLED_CLI_PATH: '/cmux' })
    expect(w.cmux.ran).toContainEqual(['surface', 'open', 'local/terminal/C7899D9A-9003-4163-AD54-9D29B70CAD1F', '--focus', 'true'])
    expect(w.toasts.filter(t => t.includes('already open'))).toEqual([])
    await ui.unmount()
  })

  test('elsewhere it says the chat is open, and opens no second copy', async ($, on) => {
    const { w, ui } = await setup($, on, {})
    expect(w.toasts.some(t => t.includes('"Writer" is already open'))).toBe(true)
    expect(w.cmux.ran).toEqual([])
    await ui.unmount()
  })
})

