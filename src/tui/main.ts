import { createCliRenderer } from '@opentui/core';
import { request, sessionIsStale, watch, type StartOptions } from '../client.ts';
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
  };
}

export async function runTui({ session, start, url }: { session: string; start: StartOptions; url?: string }) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const app = new App(renderer, sessionBackend(session, start));
  void app.start(url);
  await app.closed;
  renderer.destroy();
  if (app.stoppedSession) {
    process.stdout.write('Closed medley and stopped the browser session.\n');
  } else if (app.attached) {
    process.stdout.write(
      'Closed the medley UI. The browser session is still running: run the tui command again to return to it, or stop to end it.\n',
    );
  }
  process.exit(0);
}
