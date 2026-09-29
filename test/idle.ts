// The session stops by itself after it has been idle for MEDLEY_IDLE_MINUTES
// (30 by default): here, 3 seconds. Checks that it does, and that a command
// in the meantime keeps it going.
//
//   bun test/idle.ts

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSessionInfo } from '../src/client.ts';

const SESSION = 'idle-test';
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const page = pathToFileURL(join(import.meta.dir, 'app.html')).href;
const env = { ...process.env, MEDLEY_IDLE_MINUTES: '0.05' }; // 3 s
const medley = (...args: string[]) => spawnSync(process.execPath, [cli, '--session', SESSION, '--no-color', ...args], { env, encoding: 'utf8' });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let failures = 0;
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

medley('stop');
medley('goto', page);
const info = readSessionInfo(SESSION);
check('the session started', !!info);
await Bun.sleep(2000);
medley('snapshot'); // a command 2 s in: the 3 s start over
await Bun.sleep(2000);
check('a command keeps it going', !!readSessionInfo(SESSION) && alive(info!.pid));
for (let i = 0; i < 40 && (readSessionInfo(SESSION) || alive(info!.pid)); i++) await Bun.sleep(250);
check('3 idle seconds later it stopped and removed its file', !readSessionInfo(SESSION) && !alive(info!.pid));
medley('stop');
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
