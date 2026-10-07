import type { AvailableSession } from '../types'

/**
 * The running-chat browser's folders: where a typed path goes, which chats a folder
 * holds (in it or anywhere below), and the subfolders to list. Pure; the hooks module
 * lists the folder and the canvas draws it.
 */

/** A typed or pasted folder as an absolute path: `~`, relative to `current`, `.` and `..` worked out. */
export function resolveDir(raw: string, home: string, current: string): string {
  const typed = raw.trim()
  if (!typed) return current
  const abs = typed === '~' || typed.startsWith('~/') ? home + typed.slice(1) : typed.startsWith('/') ? typed : `${current}/${typed}`
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return '/' + parts.join('/')
}

export const parentOf = (dir: string) => (dir.lastIndexOf('/') <= 0 ? '/' : dir.slice(0, dir.lastIndexOf('/')))

/** A path as it is shown: under home, from `~`. */
export const showPath = (path: string, home: string) =>
  path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')

export const chatsUnder = <C extends Pick<AvailableSession, 'cwd'>>(chats: C[], dir: string) => chats.filter(c => isUnder(c.cwd, dir))

export type FolderRow = { name: string; path: string; chats: number }

/**
 * A folder's subfolders, each with the chats running in it or below. Those with
 * chats come first; hidden folders (`.git`) show only when they hold one.
 */
export function folderRows(entries: { name: string; kind: string }[], chats: Pick<AvailableSession, 'cwd'>[], dir: string): FolderRow[] {
  return entries
    .filter(e => e.kind === 'dir')
    .map(e => {
      const path = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
      return { name: e.name, path, chats: chatsUnder(chats, path).length }
    })
    .filter(f => f.chats > 0 || !f.name.startsWith('.'))
    .sort((a, b) => Number(b.chats > 0) - Number(a.chats > 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** Search: the chat's name, or the folders below `dir` it runs in. */
export function matchChat(c: Pick<AvailableSession, 'name' | 'cwd'>, query: string, dir: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const below = c.cwd.startsWith(dir) ? c.cwd.slice(dir.length) : c.cwd
  return c.name.toLowerCase().includes(q) || below.toLowerCase().includes(q)
}
