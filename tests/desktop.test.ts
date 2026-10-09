import { describe, expect, test } from 'claude-code/testing'

import { agent, card, link, world } from './world'

const PANE = {
  plugin: 'agent-flows', surface: 'desktop', component: 'Pane', requestId: 'agent-flows',
  props: { title: 'Agent Flows', isFocused: true, bodyColumns: 134, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as any,
  // What the desktop app reports: a viewport narrower than the pane's body.
  viewport: { columns: 40, rows: 46 },
} as const

describe('the canvas in the desktop app', () => {
  test('places each piece at its own cell, over all the rows it was given, and takes clicks there', async ($, on) => {
    world(on, {
      agents: [card('s', 'start', 'Start', {}, 0, 0), agent('a', 'Lister', 'sid-a', 34, 0)],
      links: [link('1', 's', 'a')],
    }, 'canvas-chat')
    on('ui.open', async () => ({ value: { isOpened: true } }) as any)
    on('clock.every', async () => ({ value: undefined }))
    await ($ as any).command.run({ command: 'flow', args: '' }).catch(() => {})
    const ui = await $.ui.mount(PANE)
    // The desktop app reports the rows of what was drawn, not of the region.
    await ui.resize({ columns: 134, rows: 2, in: 'canvas' })

    type Piece = { x: number; y: number; text: string; width?: number; rows: number }
    const pieces = async (): Promise<Piece[]> =>
      (await ui.findAll({ in: 'canvas', type: 'Box' })).slice(1).filter(b => (b.props as { position?: string }).position === 'absolute').map(b => {
        const p = b.props as { left: number; top: number; width?: number; flexDirection?: string }
        return { x: p.left, y: p.top, width: p.width, text: b.text, rows: p.flexDirection === 'column' ? [...b.text.replace(/\s/g, '')].length : 1 }
      })
    const at = async (text: string) => {
      const found = (await pieces()).find(p => p.text.includes(text))
      if (!found) throw new Error(`not drawn: ${text}`)
      return found
    }

    const all = await pieces()
    // The Flows list on the left and the flow's panel on the right both show at this width.
    expect(all.some(p => p.text.includes('New flow'))).toBe(true)
    expect(all.some(p => p.text.includes('Run flow'))).toBe(true)
    // 36 rows: the pane's 40 less the hint, the log line and the border.
    expect(Math.max(...all.map(p => p.y + p.rows - 1))).toBe(35)
    // A panel's side is one piece down its rows, not one a row.
    expect(all.some(p => p.x === 0 && p.rows === 34)).toBe(true)
    // No piece counts on spaces to line up, and a horizontal line is held to its cells.
    expect(all.every(p => !/ {2}/.test(p.text))).toBe(true)
    const top = all.find(p => /^─+$/.test(p.text) && p.text.length > 10)!
    expect(top.width).toBe(top.text.length - 1)

    const lister = await at('Lister')
    await ui.pointer({ type: 'down', x: lister.x, y: lister.y, button: 'left', in: 'canvas' })
    await ui.pointer({ type: 'up', x: lister.x, y: lister.y, button: 'left', in: 'canvas' })
    expect((await pieces()).some(p => p.text.includes('Open chat') || p.text.includes('INSTRUCTIONS') || p.text.includes('Agent: Lister'))).toBe(true)
    await ui.unmount()
  })
})
