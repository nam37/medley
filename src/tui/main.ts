import { createCliRenderer } from '@opentui/core';
import { prewarm, request, sessionIsStale, watch, type StartOptions } from '../client.ts';
import { App, type Backend } from './app.ts';

/** A backend that talks to the named session daemon (starting it when asked). */
export function sessionBackend(session: string, start: StartOptions): Backend {
  const client = `tui-${process.pid}`;
  return {
    client,
    request: (cmd, args = {}, starting = false) =>
      request(session, { cmd, args, client, state: true }, starting ? start : undefined),
    watch(onEvent, onConnection) {
      const abort = new AbortController();
      void watch(session, onEvent, abort.signal, onConnection);
      return () => abort.abort();
    },
    stale: () => sessionIsStale(session),
    prewarm: () => prewarm(session, start),
  };
}

export async function runTui({ session, start, url }: { session: string; start: StartOptions; url?: string }) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const app = new App(renderer, sessionBackend(session, start));
  void app.start(url);
  await app.closed;
  renderer.destroy();
  // A browser started ahead of time for a page that was never opened isn't left running.
  if (app.prewarmedUnused) {
    await prewarm(session, start); // if it's still starting, let it finish so it can be stopped
    await request(session, { cmd: 'stop', client: 'tui' }).catch(() => {});
    process.exit(0);
  }
  if (app.stoppedSession) {
    process.stdout.write('Closed medley and stopped the browser session.\n');
  } else if (app.attached) {
    process.stdout.write(
      'Closed the medley UI. The browser session is still running: run the tui command again to return to it, or stop to end it.\n',
    );
  }
  process.exit(0);
}
