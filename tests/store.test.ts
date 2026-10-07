import { describe, expect, test } from 'claude-code/testing'

import { fileFor, findSelf, flowsDir, indexPath, loadProject, parseFlow, readIndex, saveFlow, slug, syncIndex, toFile } from '../hooks/store'
import type { Io } from '../hooks/store'
import type { FlowDoc, FlowNode } from '../types'

/** A filesystem in memory: path → text. */
function memIo(files: Record<string, string> = {}): Io & { files: Record<string, string> } {
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
  return {
    files,
    read: async p => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    write: async (p, t) => void (files[p] = t),
    list: async dir =>
      Object.keys(files)
        .filter(p => dirOf(p) === dir)
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', mtimeMs: 1 })),
    exists: async p => p in files || Object.keys(files).some(f => f.startsWith(p + '/')),
    move: async (from, to) => {
      files[to] = files[from]!
      delete files[from]
    },
    remove: async p => void delete files[p],
  }
}

const agent = (id: string, sessionId?: string): FlowNode => ({ id, name: id, x: 0, y: 0, prompt: '', mode: 'default', sessionId })
const ROOT = '/work/app'
const HOME = '/home/k'
const flow = (over: Partial<FlowDoc> = {}): FlowDoc => ({
  id: 'f1', name: 'Release notes', nodes: [agent('a', 'sid-a')], edges: [], file: `${flowsDir(ROOT)}/release-notes.json`, ...over,
})

describe('flow files', () => {
  test('a saved flow reads back the same, and the folder ignores itself in git', async () => {
    const fs = memIo()
    await saveFlow(fs, flow())
    expect(fs.files[`${flowsDir(ROOT)}/.gitignore`]).toContain('*')
    expect(fs.files[`${flowsDir(ROOT)}/release-notes.json.tmp`]).toBeUndefined() // moved into place
    const project = await loadProject(fs, ROOT)
    expect(project.flows).toEqual([flow()])
    expect(project.broken).toEqual([])
  })

  test('a file that is not a flow is reported, never parsed or overwritten', async () => {
    const bad = `${flowsDir(ROOT)}/broken.json`
    const fs = memIo({ [bad]: '{ not json', [`${flowsDir(ROOT)}/old.json`]: '{"version":9}' })
    const project = await loadProject(fs, ROOT)
    expect(project.flows).toEqual([])
    expect(project.broken).toEqual([bad, `${flowsDir(ROOT)}/old.json`])
    expect(fs.files[bad]).toBe('{ not json')
  })

  test('ids that could leave the run folder, and models that read as flags, make the file unreadable', () => {
    const file = `${flowsDir(ROOT)}/f.json`
    const text = (f: FlowDoc) => toFile(f)
    expect(parseFlow(text(flow()), file)).not.toBeNull()
    expect(parseFlow(text(flow({ id: '../../x' })), file)).toBeNull()
    expect(parseFlow(text(flow({ nodes: [agent('../a')] })), file)).toBeNull()
    expect(parseFlow(text(flow({ nodes: [agent('a', 'sid a')] })), file)).toBeNull()
    expect(parseFlow(text(flow({ nodes: [{ ...agent('a'), cwd: 'relative/dir' }] })), file)).toBeNull()
    const model = (m: string) => flow({ nodes: [{ ...agent('m'), kind: 'model', card: { model: m } }] })
    expect(parseFlow(text(model('us.anthropic.claude-opus-5-5[1m]')), file)).not.toBeNull()
    expect(parseFlow(text(model('--dangerously-skip-permissions')), file)).toBeNull()
    const link = { id: 'l', from: 'a', to: '../b', cond: 'always' as const, value: '', maxPasses: 3, template: '' }
    expect(parseFlow(text(flow({ edges: [link] })), file)).toBeNull()
  })

  test('a copied file repeating a flow or agent id is reported, not loaded twice', async () => {
    const fs = memIo()
    await saveFlow(fs, flow())
    await saveFlow(fs, flow({ file: `${flowsDir(ROOT)}/release-notes-copy.json` }))
    await saveFlow(fs, flow({ id: 'f2', file: `${flowsDir(ROOT)}/z-other.json` })) // new flow id, same agent id
    const project = await loadProject(fs, ROOT)
    expect(project.flows.map(f => f.file)).toEqual([`${flowsDir(ROOT)}/release-notes-copy.json`])
    expect(project.broken).toHaveLength(2)
  })

  test('an agent or link missing a field makes the file unreadable, not a crash later', async () => {
    const bad = JSON.stringify({ version: 1, id: 'f', name: 'x', agents: [{ id: 'a', name: 'a' }], links: [] })
    expect(parseFlow(bad, 'x.json')).toBe(null)
    const badLink = JSON.stringify({ version: 1, id: 'f', name: 'x', agents: [], links: [{ id: 'l', from: 'a', to: 'b', cond: 'maybe' }] })
    expect(parseFlow(badLink, 'x.json')).toBe(null)
  })

  test('a Model card keeps its model and effort; an unknown effort makes the file unreadable', () => {
    const file = (effort: string) => JSON.stringify({
      version: 2, id: 'f', name: 'x', links: [],
      agents: [{ id: 'm', name: 'Model', x: 0, y: 0, prompt: '', mode: 'default', kind: 'model', card: { model: 'claude-opus-5-5', effort } }],
    })
    expect(parseFlow(file('high'), 'x.json')?.nodes[0]?.card).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(parseFlow(file('turbo'), 'x.json')).toBe(null)
  })

  test('a project with no flows folder has no flows', async () => {
    expect(await loadProject(memIo(), ROOT)).toEqual({ flows: [], broken: [], mtimes: {} })
  })

  test('file names come from the flow name, and never collide', () => {
    expect(slug('Bug triage: Q3!')).toBe('bug-triage-q3')
    expect(slug('???')).toBe('flow')
    const dir = flowsDir(ROOT)
    expect(fileFor(dir, 'Bug triage', 'abcd1234', new Set())).toBe(`${dir}/bug-triage.json`)
    expect(fileFor(dir, 'Bug triage', 'abcd1234', new Set([`${dir}/bug-triage.json`]))).toBe(`${dir}/bug-triage-abcd.json`)
  })

  test('the file keeps the user-facing words: agents and links', () => {
    const raw = JSON.parse(toFile(flow()))
    expect(Object.keys(raw)).toEqual(['version', 'id', 'name', 'agents', 'links'])
    expect(parseFlow(toFile(flow()), 'x.json')?.nodes).toHaveLength(1)
  })
})

describe('agent index', () => {
  test('follows a flow: adds its chats, drops the ones that left, clears on delete', async () => {
    const fs = memIo()
    const path = indexPath(HOME)
    const f = flow({ nodes: [agent('a', 'sid-a'), agent('b', 'sid-b'), agent('c')] })
    await syncIndex(fs, path, f.file, f)
    expect(await readIndex(fs, path)).toEqual({ 'sid-a': { flowFile: f.file }, 'sid-b': { flowFile: f.file } })
    await syncIndex(fs, path, f.file, { ...f, nodes: [agent('a', 'sid-a')] })
    expect(Object.keys(await readIndex(fs, path))).toEqual(['sid-a'])
    await syncIndex(fs, path, f.file, null)
    expect(await readIndex(fs, path)).toEqual({})
  })

  test('a missing index is empty; a damaged one is refused, never rewritten from empty', async () => {
    expect(await readIndex(memIo(), indexPath(HOME))).toEqual({})
    const fs = memIo({ [indexPath(HOME)]: 'garbage' })
    await expect(readIndex(fs, indexPath(HOME))).rejects.toThrow()
    await expect(syncIndex(fs, indexPath(HOME), '/f.json', flow())).rejects.toThrow()
    expect(fs.files[indexPath(HOME)]).toBe('garbage')
  })

  test('the index is written whole, beside then moved over', async () => {
    const fs = memIo()
    await syncIndex(fs, indexPath(HOME), flow().file, flow())
    expect(Object.keys(fs.files).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('an agent finding its flow', () => {
  test('through the index, even from another folder', async () => {
    const fs = memIo()
    await saveFlow(fs, flow())
    const found = await findSelf(fs, { 'sid-a': { flowFile: flow().file } }, '/somewhere/else', 'sid-a')
    expect(found?.node.id).toBe('a')
    expect(found?.flow.name).toBe('Release notes')
  })

  test('by scanning its project when the index lost it', async () => {
    const fs = memIo()
    await saveFlow(fs, flow())
    expect((await findSelf(fs, {}, ROOT, 'sid-a'))?.node.id).toBe('a')
  })

  test('an ordinary chat is in no flow', async () => {
    const fs = memIo()
    await saveFlow(fs, flow())
    expect(await findSelf(fs, {}, ROOT, 'sid-zzz')).toBe(null)
    expect(await findSelf(fs, { 'sid-zzz': { flowFile: '/gone.json' } }, '/nowhere', 'sid-zzz')).toBe(null)
  })
})
