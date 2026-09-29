// medley watch: reload the session's page whenever files change, and print how
// its text changed, with any errors it logged. A quick loop for someone (or an
// agent) editing a site: save, and see what the page says now.

import { watch as watchDir } from 'node:fs';
import { request } from './client.ts';

// Changes that aren't to the site: dependencies, version control, editors' scratch files.
const IGNORED = /(^|[\\/])(node_modules|\.git|\.hg|\.svn|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache|coverage)([\\/]|$)|(~|\.swp|\.swx|\.tmp|\.DS_Store|4913)$/;
const QUIET_MS = 250; // a save often writes several files; wait for them all

export interface WatchOptions {
  session: string;
  dir: string;
  hot: boolean; // the dev server updates the page itself: wait for it instead of reloading
  client: string;
  print: (text: string) => void;
}

export async function watchFiles(o: WatchOptions): Promise<void> {
  const clock = () => new Date().toTimeString().slice(0, 8);
  // The page as it is now is what the first change is compared with.
  const first = await request(o.session, { cmd: 'snapshot', args: { outline: true }, client: o.client });
  const [title = '', meta = ''] = first.text.split('\n').filter((l) => !l.startsWith('note: '));
  const page = `"${title}" (${meta.split(' · ')[0]})`;
  o.print(`watching ${o.dir}: when files change, ${o.hot ? `waiting for ${page} to update itself` : `reloading ${page}`} and saying how its text changed (Ctrl+C stops)`);

  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const run = async () => {
    if (running) return; // runs again when this one is done
    running = true;
    try {
      while (changed.size) {
        const files = [...changed];
        changed.clear();
        const which = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
        try {
          const command = o.hot ? { cmd: 'wait', args: { seconds: 1, diff: true } } : { cmd: 'reload', args: { diff: true } };
          const reply = await request(o.session, { ...command, client: o.client });
          o.print('');
          o.print(`${clock()} ${which} changed · ${reply.text}`);
        } catch (e) {
          o.print('');
          o.print(`${clock()} ${which} changed · ${(e as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const watcher = watchDir(o.dir, { recursive: true }, (_event, file) => {
    const name = file ? String(file) : '';
    if (!name || IGNORED.test(name)) return;
    changed.add(name.replace(/\\/g, '/'));
    clearTimeout(timer);
    timer = setTimeout(run, QUIET_MS);
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      watcher.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
