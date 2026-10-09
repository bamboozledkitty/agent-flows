import { describe, expect, test } from 'claude-code/testing'

import { FLOW, agent, card, link, sentTo, settle, turn, world } from './world'

/**
 * Every setting of every condition card, run through a real flow: the message
 * leaves by the output it should, and only that one. One agent's reply fans out to
 * many cards at once; each card's outputs go to their own agents.
 */

type Case = { name: string; cfg: Record<string, unknown>; want: 'yes' | 'no' }

/** A flow where agent `a`'s reply reaches every If card; each card's Yes and No go to their own agents. */
function ifMatrix(cases: Case[]) {
  const agents: unknown[] = [agent('a', 'Source', 'sid-a')]
  const links: unknown[] = []
  cases.forEach((c, i) => {
    agents.push(card(`if${i}`, 'if', c.name, c.cfg), agent(`y${i}`, `Yes ${i}`, `sid-y${i}`), agent(`n${i}`, `No ${i}`, `sid-n${i}`))
    links.push(link(`in${i}`, 'a', `if${i}`), link(`yes${i}`, `if${i}`, `y${i}`, 'yes'), link(`no${i}`, `if${i}`, `n${i}`, 'no'))
  })
  return { agents, links }
}

const took = (w: ReturnType<typeof world>, i: number) =>
  `${sentTo(w, `sid-y${i}`).length ? 'yes' : ''}${sentTo(w, `sid-n${i}`).length ? 'no' : ''}` || 'nothing'

describe('If: every kind of check', () => {
  const MESSAGE = 'Countries: France, United Kingdom, Japan. Score: 92'
  const cases: Case[] = [
    { name: 'contains', cfg: { check: 'contains', value: 'United' }, want: 'yes' },
    { name: 'contains, other case', cfg: { check: 'contains', value: 'UNITED kingdom' }, want: 'yes' },
    { name: 'contains, absent', cfg: { check: 'contains', value: 'Brazil' }, want: 'no' },
    { name: 'contains, blank', cfg: { check: 'contains', value: '' }, want: 'no' },
    { name: 'not-contains, absent', cfg: { check: 'not-contains', value: 'Brazil' }, want: 'yes' },
    { name: 'not-contains, present', cfg: { check: 'not-contains', value: 'japan' }, want: 'no' },
    { name: 'not-contains, blank', cfg: { check: 'not-contains', value: '' }, want: 'yes' },
    { name: 'pattern, matches', cfg: { check: 'regex', value: 'score: (9\\d|100)' }, want: 'yes' },
    { name: 'pattern, no match', cfg: { check: 'regex', value: '^Japan' }, want: 'no' },
    { name: 'pattern, broken', cfg: { check: 'regex', value: '([' }, want: 'no' },
  ]

  test('text checks: contains, doesn\'t contain and patterns each take the right output', async ($, on) => {
    const w = world(on, ifMatrix(cases))
    await ($ as any).turn.complete(turn(MESSAGE))
    await settle()
    const got = cases.map((c, i) => `${c.name}: ${took(w, i)}`)
    expect(got).toEqual(cases.map(c => `${c.name}: ${c.want}`))
  })

  test('Claude judges: YES, NO, a wordy answer and an unreadable one', async ($, on) => {
    const judged: Case[] = [
      { name: 'yes', cfg: { check: 'judge', value: 'it says YES-CASE' }, want: 'yes' },
      { name: 'no', cfg: { check: 'judge', value: 'it says NO-CASE' }, want: 'no' },
      { name: 'wordy yes', cfg: { check: 'judge', value: 'it says WORDY-CASE' }, want: 'yes' },
      { name: 'unreadable', cfg: { check: 'judge', value: 'it says GARBLED-CASE' }, want: 'no' },
      { name: 'no statement', cfg: { check: 'judge', value: '' }, want: 'no' },
    ]
    const w = world(on, ifMatrix(judged))
    w.answer.fn = p =>
      p.includes('YES-CASE') ? 'YES' : p.includes('NO-CASE') ? 'NO' : p.includes('WORDY-CASE') ? 'Yes. The message lists them.' : 'Maybe?'
    await ($ as any).turn.complete(turn(MESSAGE))
    await settle()
    expect(judged.map((c, i) => `${c.name}: ${took(w, i)}`)).toEqual(judged.map(c => `${c.name}: ${c.want}`))
  })

  test('an If passes the message on unchanged', async ($, on) => {
    const w = world(on, ifMatrix([cases[0]!]))
    await ($ as any).turn.complete(turn(MESSAGE))
    await settle()
    expect(sentTo(w, 'sid-y0')[0]!.text).toContain(MESSAGE)
  })
})

describe('Switch: which branch', () => {
  /** Claude's answer → the agent that should get the message. */
  const answers: [string, string][] = [
    ['bug', 'sid-bug'],
    ['Feature', 'sid-feature'], // case
    ['"question".', 'sid-question'], // quotes and a full stop
    ['- bug', 'sid-bug'], // a list dash
    ['feature request', 'sid-feature'], // starts with a branch name
    ['spam', 'sid-other'], // none of them
    ['', 'sid-other'], // no answer
  ]

  for (const [said, to] of answers) {
    test(`Claude says ${JSON.stringify(said)} → ${to.slice(4)}`, async ($, on) => {
      const w = world(on, {
        agents: [
          agent('a', 'Triage', 'sid-a'), card('s', 'switch', 'Kind', { branches: ['bug', 'feature', 'question'] }),
          agent('b', 'Bugs', 'sid-bug'), agent('f', 'Features', 'sid-feature'), agent('q', 'Questions', 'sid-question'), agent('o', 'Other', 'sid-other'),
        ],
        links: [link('1', 'a', 's'), link('2', 's', 'b', 'bug'), link('3', 's', 'f', 'feature'), link('4', 's', 'q', 'question'), link('5', 's', 'o', 'other')],
      })
      w.answer.fn = () => said
      await ($ as any).turn.complete(turn('Some message'))
      await settle()
      const reached = ['sid-bug', 'sid-feature', 'sid-question', 'sid-other'].filter(s => sentTo(w, s).length)
      expect(reached).toEqual([to])
    })
  }

  test('a Switch with no branches sends everything to Other', async ($, on) => {
    const w = world(on, {
      agents: [agent('a', 'Triage', 'sid-a'), card('s', 'switch', 'Kind', { branches: [] }), agent('o', 'Other', 'sid-other')],
      links: [link('1', 'a', 's'), link('2', 's', 'o', 'other')],
    })
    await ($ as any).turn.complete(turn('Anything'))
    await settle()
    expect(sentTo(w, 'sid-other')).toHaveLength(1)
  })
})

describe('Loop until: text checks', () => {
  /** A writer whose reply goes through the Loop: Again back to the writer, Done on to the publisher. */
  const loopFlow = (cfg: Record<string, unknown>) => ({
    agents: [agent('a', 'Writer', 'sid-a'), card('l', 'loop', 'Until approved', cfg), agent('p', 'Publisher', 'sid-p')],
    links: [link('1', 'a', 'l'), link('2', 'l', 'p', 'done'), link('3', 'l', 'a', 'again', 10)],
  })

  test('contains: Again while it is missing, Done once it appears', async ($, on) => {
    const w = world(on, loopFlow({ check: 'contains', value: 'APPROVED', maxTries: 5 }))
    await ($ as any).turn.complete(turn('[Agent Flows · run r1 · hand-off 1]\nDraft 1'))
    await settle()
    expect(sentTo(w, 'sid-a')).toHaveLength(1) // back to the writer
    expect(sentTo(w, 'sid-p')).toHaveLength(0)
    await ($ as any).turn.complete(turn('[Agent Flows · run r1 · hand-off 2]\nDraft 2: APPROVED'))
    await settle()
    expect(sentTo(w, 'sid-p')).toHaveLength(1)
    expect(sentTo(w, 'sid-p')[0]!.text).toContain('Draft 2: APPROVED')
  })

  test('a pattern that holds the first time goes straight to Done', async ($, on) => {
    const w = world(on, loopFlow({ check: 'regex', value: 'score: (8|9)\\d', maxTries: 3 }))
    await ($ as any).turn.complete(turn('score: 91'))
    await settle()
    expect(sentTo(w, 'sid-p')).toHaveLength(1)
    expect(sentTo(w, 'sid-a')).toHaveLength(0)
  })

  test('one try allowed: Done after the first, held or not', async ($, on) => {
    const w = world(on, loopFlow({ check: 'contains', value: 'APPROVED', maxTries: 1 }))
    await ($ as any).turn.complete(turn('Not yet'))
    await settle()
    expect(sentTo(w, 'sid-p')).toHaveLength(1)
    expect(sentTo(w, 'sid-a')).toHaveLength(0)
  })
})

describe('cards in a row', () => {
  test('Prompt → If → Switch → End: each card does its part and End keeps the right answer', async ($, on) => {
    const w = world(on, {
      agents: [
        agent('a', 'Source', 'sid-a'),
        card('p', 'prompt', 'Frame it', { template: 'TICKET from {{from}}: {{message}}' }),
        card('i', 'if', 'Is a ticket?', { check: 'contains', value: 'TICKET' }),
        card('s', 'switch', 'Kind', { branches: ['bug', 'feature'] }),
        card('eb', 'end', 'Bug log', { saveTo: 'out/bugs.md' }),
        card('ef', 'end', 'Feature log', { saveTo: 'out/features.md' }),
        agent('x', 'Not a ticket', 'sid-x'),
      ],
      links: [
        link('1', 'a', 'p'), link('2', 'p', 'i'), link('3', 'i', 's', 'yes'), link('4', 'i', 'x', 'no'),
        link('5', 's', 'eb', 'bug'), link('6', 's', 'ef', 'feature'),
      ],
    })
    w.answer.fn = p => (p.includes('crashes') ? 'bug' : 'feature')
    await ($ as any).turn.complete(turn('The app crashes on save'))
    await settle()
    expect(w.files['/work/proj/out/bugs.md']).toBe('TICKET from Source: The app crashes on save\n')
    expect(w.files['/work/proj/out/features.md']).toBeUndefined()
    expect(sentTo(w, 'sid-x')).toHaveLength(0)
  })
})

describe('agent instructions in a flow', () => {
  test('an agent gets its instructions, with @files read in, ahead of every message; files outside the project are refused', async ($, on) => {
    const w = world(on, {
      agents: [
        agent('a', 'Lister', 'sid-a'),
        { ...agent('b', 'Checker', 'sid-b'), instructions: 'You check country lists.\n@docs/brief.md\n@~/.ssh/id_rsa\n@missing.md' },
        agent('c', 'Plain', 'sid-c'),
      ],
      links: [link('1', 'a', 'b'), link('2', 'a', 'c')],
    })
    w.files['/work/proj/docs/brief.md'] = 'Keep only UN members.\n'
    w.files['/home/k/.ssh/id_rsa'] = 'PRIVATE KEY'
    await ($ as any).turn.complete(turn('France, Japan'))
    await settle()
    const got = sentTo(w, 'sid-b')[0]!.text
    expect(got).toContain('[Agent Flows · your instructions as Checker]')
    expect(got).toContain('You check country lists.')
    expect(got).toContain('<file path="/work/proj/docs/brief.md">\nKeep only UN members.\n</file>')
    expect(got).not.toContain('PRIVATE KEY')
    expect(got).toContain("@~/.ssh/id_rsa wasn't added")
    expect(got).toContain("@missing.md wasn't added: no such file")
    // The message comes after the instructions.
    expect(got.indexOf('France, Japan')).toBeGreaterThan(got.indexOf('[End of instructions. The message follows.]'))
    // An agent with none gets the message as before.
    expect(sentTo(w, 'sid-c')[0]!.text).not.toContain('instructions')
  })
})

describe("an open chat's model", () => {
  /** Writer has a Model card linked in; Reviewer has none. Each request either chat makes, as the engine would send it. */
  const flow = () => ({
    agents: [
      agent('a', 'Writer', 'sid-a'), agent('b', 'Reviewer', 'sid-b'),
      card('m', 'model', 'Model', { model: 'claude-haiku-4-5', effort: 'low' }),
    ],
    links: [link('1', 'a', 'b'), link('2', 'm', 'a')],
  })
  const step = (over: Record<string, unknown> = {}) => ({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3, ...over })
  /** Sends one request through the hooks, read to its end. */
  const request = async ($: any, over?: Record<string, unknown>) => {
    for await (const _ of $.turn.step(step(over)));
  }

  test("each request names the Model card's model and effort; a subagent's and an unlinked chat's are left alone", async ($, on) => {
    const sent: any[] = []
    on('turn.step', async function* (_$: unknown, e: any) {
      sent.push(e)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as any
    })
    world(on, flow(), 'sid-a')
    await request($)
    await request($, { agentId: 'sub-1' })
    expect(sent.map(e => [e.model, e.effort])).toEqual([['claude-haiku-4-5', 'low'], ['claude-sonnet-5-5', 'high']])
  })

  test("a card's opus, sonnet or haiku is sent as that family's first id in Extra models; none there leaves the request as it was", { options: { extraModels: 'claude-sonnet-5-5, claude-opus-5-5' } }, async ($, on) => {
    const sent: any[] = []
    on('turn.step', async function* (_$: unknown, e: any) {
      sent.push(e)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as any
    })
    const w = world(on, flow(), 'sid-a')
    const setModel = (model: string) => {
      const doc = JSON.parse(w.files[FLOW]!)
      doc.agents.find((n: any) => n.id === 'm').card.model = model
      w.files[FLOW] = JSON.stringify(doc)
    }
    setModel('sonnet')
    await request($)
    setModel('haiku')
    await request($)
    expect(sent.map(e => e.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test('an agent with no Model card linked keeps the model its chat has', async ($, on) => {
    const sent: any[] = []
    on('turn.step', async function* (_$: unknown, e: any) {
      sent.push(e)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as any
    })
    world(on, flow(), 'sid-b')
    await request($)
    expect(sent.map(e => [e.model, e.effort])).toEqual([['claude-sonnet-5-5', 'high']])
  })
})
