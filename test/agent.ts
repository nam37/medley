// What agents lean on besides reading pages: errors the page logged and
// requests that failed (as notes after an action, and in console and
// network), acting on elements by name, find, a size limit on results, and
// data taken from tables and runs of items.
//
//   bun test/agent.ts

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION = 'agent-test';
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const page = (name: string) => pathToFileURL(join(import.meta.dir, name)).href;
const medley = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, '--session', SESSION, '--no-color', ...args], { encoding: 'utf8' });
  return (r.stdout + r.stderr).trim();
};

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};

medley('stop');
try {
  // Errors and failed requests, noted after the action that caused them.
  let out = medley('goto', page('problems.html'));
  check('loading notes the error the page logged', out.includes('note: the page logged 1 error: an error while loading'), out);
  out = medley('click', 'Break something');
  check('a click by name clicks it', out.startsWith('clicked [1 button "Break something"]'), out);
  check('and notes the errors it caused', /note: the page logged 3 errors/.test(out), out);
  check('and the request that failed', /note: 1 request failed: .* GET .*missing-data\.json/.test(out), out);
  out = medley('console');
  check('console lists them, an object as its contents', out.includes('clicking broke it {code: 42}') && out.includes('Uncaught TypeError'), out);
  out = medley('network');
  check('network lists the failed request', /1 failed\n.*GET .*missing-data\.json\s+\(Fetch\)/.test(out), out);
  out = medley('info');
  check('page info has them under Problems', /Problems\n {2}\d console errors/.test(out), out);

  // Names, find, data.
  medley('goto', page('data.html'));
  out = medley('hover', 'link Moss Step');
  check('a kind and a name pick one', out.startsWith('hovered over [7]Moss Step'), out);
  out = medley('click', 'S'); // Sale, Scree Glide
  check('a name that fits several fails, listing them', /"S" fits 2 elements: .*Sale.*Scree Glide.*use its number/.test(out), out);
  out = medley('find', 'ridge');
  check('find gives the lines, marked, under where they are', out.includes('@@ main › ## Results @@') && out.includes('> [5]Ridge Runner'), out);
  out = medley('extract');
  check('extract lists the table and the results, not the menus', /1\. \(Shoe, Size, Price\) 3 rows/.test(out) && /runs of items:\n {2}1\. 4 items/.test(out), out);
  out = medley('extract', 'table', '1', '--csv');
  check('a table as CSV', out === 'Shoe,Size,Price\nRidge Runner,42,$129\nRidge Runner,43,$129\n"Scree Glide, ""wide""",44,$149', out);
  out = medley('extract', 'items', '1');
  let items: { text: string; ref: number; link: string }[] = [];
  try {
    items = JSON.parse(out);
  } catch {}
  check('items as JSON, with their links', items.length === 4 && items[0].link === 'Ridge Runner' && items[0].ref === 5, out);

  // A size limit turns a long result into the page's outline.
  out = medley('goto', page('app.html'), '--max', '500');
  check('over --max, the outline instead', out.includes('over your limit') && out.includes('outline:') && out.length < 2000, out);

  // A page's code (an example of a snapshot, as on medley's own site) has no headings, regions or refs,
  // and nor does link text that looks like a ref ("[1]What agents see", on the same site).
  const code = '<h1>Docs</h1><pre>── nav ──\n# Not a heading\n[1]Not a ref  [2 button "Nor this"]</pre><h2>Next</h2><a href="#x">A real link</a> <a href="#y">[1]Looks like a ref</a>';
  out = medley('goto', `data:text/html,${encodeURIComponent(code)}`, '--outline');
  check("the outline leaves out a page's code, and text that looks like a ref", /outline: \d+ lines, 2 refs/.test(out) && !out.includes('Not a heading') && !out.includes('── nav ──') && out.includes('## Next  (1 lines, 2 refs)'), out);
} finally {
  medley('stop');
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
