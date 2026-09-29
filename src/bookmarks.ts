// Bookmarks, kept in ~/.medley/bookmarks.json (or MEDLEY_BOOKMARKS) for every
// session and client to share.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Bookmark {
  title: string;
  url: string;
}

/** Where bookmarks are kept, read each time so a test can point it elsewhere. */
export const bookmarksFile = () => process.env.MEDLEY_BOOKMARKS || join(homedir(), '.medley', 'bookmarks.json');

export function readBookmarks(): Bookmark[] {
  try {
    const list = JSON.parse(readFileSync(bookmarksFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((b) => b && typeof b.url === 'string').map((b) => ({ title: String(b.title ?? ''), url: b.url })) : [];
  } catch {
    return [];
  }
}

function write(list: Bookmark[]) {
  const file = bookmarksFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, file); // never a half-written file
}

/** Add a page; false if it was already there (the list keeps one entry per address). */
export function addBookmark(b: Bookmark): boolean {
  const list = readBookmarks();
  if (list.some((x) => x.url === b.url)) return false;
  write([...list, b]);
  return true;
}

/** Remove the n-th bookmark (1-based); the one removed, or null. */
export function removeBookmark(n: number): Bookmark | null {
  const list = readBookmarks();
  const [gone] = list.splice(n - 1, 1);
  if (!gone) return null;
  write(list);
  return gone;
}
