import { describe, expect, test } from 'claude-code/testing'

import { chatsUnder, folderRows, matchChat, parentOf, resolveDir, showPath } from '../hooks/picker'

const HOME = '/Users/k'
const chat = (name: string, cwd: string) => ({ sessionId: name, name, cwd, startedAt: 0 })

describe('the running-chat browser', () => {
  test('a typed or pasted folder: ~, relative, trailing slashes, . and ..', () => {
    expect(resolveDir('~', HOME, '/tmp')).toBe(HOME)
    expect(resolveDir('~/design-intelligence/', HOME, '/tmp')).toBe(`${HOME}/design-intelligence`)
    expect(resolveDir('packages', HOME, `${HOME}/di`)).toBe(`${HOME}/di/packages`)
    expect(resolveDir('../kdelta', HOME, `${HOME}/di`)).toBe(`${HOME}/kdelta`)
    expect(resolveDir('/a//b/./c/', HOME, '/tmp')).toBe('/a/b/c')
    expect(resolveDir('/../..', HOME, '/tmp')).toBe('/')
    expect(resolveDir('  ', HOME, '/tmp')).toBe('/tmp')
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBe('/')
    expect(showPath(`${HOME}/di/packages`, HOME)).toBe('~/di/packages')
    expect(showPath('/tmp', HOME)).toBe('/tmp')
  })

  test('chats in a folder are the ones running in it or anywhere below it', () => {
    const chats = [chat('a', `${HOME}/di`), chat('b', `${HOME}/di/packages/x`), chat('c', `${HOME}/dino`), chat('d', '/tmp')]
    expect(chatsUnder(chats, `${HOME}/di`).map(c => c.name)).toEqual(['a', 'b'])
    expect(chatsUnder(chats, '/').map(c => c.name)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('folders with chats in them or below come first, marked with their count; hidden ones only when they hold chats', () => {
    const entries = ['zeta', 'alpha', 'packages', '.git', '.claude', 'notes.md'].map(name => ({ name, kind: name.includes('.md') ? 'file' : 'dir' }))
    const chats = [chat('a', `${HOME}/di/packages/x`), chat('b', `${HOME}/di/packages`), chat('c', `${HOME}/di/.claude/w`)]
    expect(folderRows(entries, chats, `${HOME}/di`)).toEqual([
      { name: '.claude', path: `${HOME}/di/.claude`, chats: 1 },
      { name: 'packages', path: `${HOME}/di/packages`, chats: 2 },
      { name: 'alpha', path: `${HOME}/di/alpha`, chats: 0 },
      { name: 'zeta', path: `${HOME}/di/zeta`, chats: 0 },
    ])
  })

  test('search finds a chat by its name or the folder it runs in, ignoring case', () => {
    const c = chat('Skill Review Chat', `${HOME}/di/packages/eval-lab`)
    expect(matchChat(c, 'review', `${HOME}/di`)).toBe(true)
    expect(matchChat(c, 'EVAL', `${HOME}/di`)).toBe(true)
    expect(matchChat(c, 'di', `${HOME}/di`)).toBe(false) // the folder you're in doesn't count
    expect(matchChat(c, '', `${HOME}/di`)).toBe(true)
  })
})
