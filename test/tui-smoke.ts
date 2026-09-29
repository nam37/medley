// Drives the terminal UI through OpenTUI's test renderer against a real
// session on test/app.html, printing frames along the way.
//
//   bun test/tui-smoke.ts

import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prewarm, readSessionInfo, send } from '../src/client.ts';
import { App } from '../src/tui/app.ts';
import { sessionBackend } from '../src/tui/main.ts';

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

const SESSION = 'tui-smoke';
const url = pathToFileURL(join(import.meta.dir, 'app.html')).href;
const setup = await createTestRenderer({ width: 100, height: 24 });
const { mockInput, mockMouse } = setup;
// Downloads and bookmarks go to scratch places, not the real ones, and a
// search goes to a local page instead of the web.
const downloads = join(tmpdir(), 'medley-smoke-downloads');
rmSync(downloads, { recursive: true, force: true });
process.env.MEDLEY_BOOKMARKS = join(tmpdir(), 'medley-smoke-bookmarks.json');
rmSync(process.env.MEDLEY_BOOKMARKS, { force: true });
process.env.MEDLEY_SEARCH = `${pathToFileURL(join(import.meta.dir, 'fixture.html')).href}?q=%s`;
const app = new App(setup.renderer, sessionBackend(SESSION, { downloads }));

async function waitFor(s: Setup, what: string, test: (frame: string) => boolean, ms = 20000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await s.renderOnce();
    const frame = s.captureCharFrame();
    if (test(frame)) return frame;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}:\n${s.captureCharFrame()}`);
}
const until = (what: string, test: (frame: string) => boolean) => waitFor(setup, what, test);

function show(title: string, frame: string) {
  console.log(`\n=== ${title} ===\n${frame.split('\n').map((l) => l.trimEnd()).join('\n')}`);
}

const keys = async (...names: string[]) => {
  for (const k of names) mockInput.pressKey(k);
  await setup.renderOnce();
};

try {
  void app.start(url);
  show('opened the page', await until('the page', (f) => f.includes('# Todos')));

  await keys('\t', '\t', '\t');
  const inverted = setup
    .captureSpans()
    .lines.flatMap((l) => l.spans)
    .filter((s) => s.attributes & TextAttributes.INVERSE)
    .map((s) => s.text)
    .join('');
  console.log(`\nselected after Tab x3 (drawn inverted): ${inverted}`);
  mockInput.pressEnter();
  show('Tab x3, Enter: the menu opens', await until('the menu', (f) => f.includes('Settings')));

  await keys('4');
  mockInput.pressEnter();
  show('typed 4, Enter: a prompt for the field', await until('the prompt', (f) => f.includes('type into [4')));
  await mockInput.typeText('Buy milk');
  mockInput.pressEnter();
  show('typed and submitted', await until('the new todo', (f) => f.includes('- Buy milk')));

  // An agent acts in the same session; the UI follows along.
  await send(SESSION, { cmd: 'snapshot', client: 'mcp-smoke' });
  await send(SESSION, { cmd: 'click', args: { ref: 7 }, client: 'mcp-smoke' });
  show('an agent clicked "Say hello"', await until('the agent', (f) => f.includes('Hello said 1') && f.includes('agent:')));

  await keys('r');
  show('r reloads the page', await until('the reload', (f) => f.includes('Hello said 0') && f.includes('reloaded')));

  const notes = join(tmpdir(), 'medley smoke notes.txt');
  writeFileSync(notes, 'hello from the smoke test\n');
  await keys('1', '3');
  mockInput.pressEnter();
  await until('the file prompt', (f) => f.includes('choose files for [13 file'));
  await mockInput.typeText(`"${notes}"`);
  mockInput.pressEnter();
  show('13, Enter, a path: the file field gets the file', await until('the upload', (f) => f.includes('Got medley smoke notes.txt')));

  // While a command runs, a band sweeps across the medley badge (so its cells
  // come in several shades) and the status line says what's happening.
  const badgeShades = () => {
    let width = 0;
    let shades = 0;
    for (const s of setup.captureSpans().lines[0].spans) {
      if (width >= 8) break;
      width += s.text.length;
      shades++;
    }
    return shades;
  };
  await keys('w');
  const working = await until('the wait', (f) => f.includes('waiting 2s for the page…'));
  await Bun.sleep(200);
  await setup.renderOnce();
  const during = badgeShades();
  show('w waits for the page, saying so', working);
  await until('the wait to end', (f) => f.includes('waited 2s'));
  console.log(`\nthe badge while working: ${during > 1 ? `animated (${during} shades)` : 'still (bad)'}; after: ${badgeShades() === 1 ? 'still' : 'animated (bad)'}`);

  // A password field's prompt shows dots, never what's typed.
  await keys('1', '6');
  mockInput.pressEnter();
  await until('the password prompt', (f) => f.includes('type into [16 password'));
  await mockInput.typeText('hunter2');
  const masked = await until('the dots', (f) => f.includes('•••••••'));
  console.log(`\nthe password prompt shows ${masked.includes('hunter2') ? 'the password (bad)' : 'only dots'}`);
  mockInput.pressEnter();
  show('16, Enter, a password: typed, never shown', await until('the password', (f) => f.includes('Password has 7 characters')));

  // A download link saves the file and says where.
  await keys('1', '5');
  mockInput.pressEnter();
  show('15, Enter: a download link says where the file went', await until('the download', (f) => f.includes('downloaded report.csv')));
  const saved = join(downloads, 'report.csv');
  console.log(`\nthe download: ${existsSync(saved) ? `saved, ${readFileSync(saved, 'utf8').split('\n').length - 1} lines` : 'missing (bad)'}`);

  await keys('a');
  show('a bookmarks the page', await until('the bookmark', (f) => f.includes('bookmarked "Medley test app"')));

  // l pulls down the page's refs; typing filters them, Enter opens the one selected.
  await keys('l');
  show('l lists the refs', await until('the list', (f) => /\d+ refs · type to filter/.test(f) && f.includes('textbox "New todo"')));
  await mockInput.typeText('hello');
  show('typing filters the list', await until('the filtered list', (f) => /1 of \d+ refs match "hello"/.test(f) && f.includes('button "Say hello"')));
  mockInput.pressEnter();
  show('Enter opens it', await until('the click', (f) => f.includes('Hello said 1') && !f.includes('refs match')));
  // A click on "N refs" in the top bar pulls the list down too; Esc closes it.
  const bar = setup.captureCharFrame().split('\n')[0];
  await mockMouse.click(bar.indexOf(' refs') - 1, 0);
  await until('the list from a click', (f) => /\d+ refs · type to filter/.test(f));
  mockInput.pressEscape();
  await Bun.sleep(100);
  await until('the list to close', (f) => !/refs · type to filter/.test(f));
  console.log('\na click on "N refs" in the top bar opened the list; Esc closed it');

  mockInput.pressKey(':');
  await mockInput.typeText('scroll bottom');
  mockInput.pressEnter();
  await until('the lazy items to load', (f) => /scrolled bottom · \+\d+ -0 lines/.test(f));
  await keys('END'); // they're below the fold
  show(':scroll bottom loads lazy items', await until('lazy items', (f) => f.includes('Lazy item 3')));

  mockInput.pressKey('/');
  await mockInput.typeText('lazy');
  mockInput.pressEnter();
  show('/lazy finds matches', await until('matches', (f) => f.includes('of 3')));

  mockInput.pressEscape(); // clear the find
  await Bun.sleep(100); // a lone Esc waits briefly in case it starts an escape sequence
  await until('the find to clear', (f) => !f.includes('match 1 of 3'));
  await keys('HOME'); // back up to the top of the page
  const frame = await until('the top of the page', (f) => f.includes('[1]Fixture page'));
  const row = frame.split('\n').findIndex((l) => l.includes('[1]Fixture page'));
  await mockMouse.click(frame.split('\n')[row].indexOf('[1]') + 4, row);
  show('clicked [1] with the mouse', await until('the fixture page', (f) => f.includes('Medley fixture')));

  await keys('v');
  show('v: partial grid puts the cards side by side', await until('columns', (f) => /Card A\s+│ ### \[8\]Card B/.test(f)));
  await keys('v');
  const advanced = await until('advanced grid', (f) => f.includes('advanced grid'));
  const cardRow = advanced.split('\n').findIndex((l) => l.includes('[8]Card B'));
  await mockMouse.click(advanced.split('\n')[cardRow].indexOf('[8]') + 4, cardRow);
  await until('Card B to open', (f) => f.includes("couldn’t be accessed"));
  console.log('\nclicked [8]Card B in the right-hand column: it opened');
  await keys('v');
  await until('no grid', (f) => f.includes('no grid'));

  await keys('b');
  await until('the fixture again', (f) => f.includes('Medley fixture'));
  await keys('b');
  await until('the app again', (f) => f.includes('# Todos'));
  await keys('8');
  mockInput.pressEnter();
  show('"Clear all" opens a confirm()', await until('the dialog', (f) => f.includes('the page asks (confirm)')));
  await keys('y');
  show('y accepts it', await until('todos cleared', (f) => f.includes('accepted the confirm')));

  // A modal over the page: pressing a ref it covers goes to the modal's button instead.
  await keys('9');
  mockInput.pressEnter();
  await until('the newsletter', (f) => f.includes('clicked [9 button "Show newsletter"]'));
  await keys('1', '0');
  mockInput.pressEnter();
  show('10, Enter under a modal: its button is selected', await until('the jump', (f) => f.includes('Enter presses [19 button "No thanks"]') && f.includes('Subscribe to our newsletter')));
  // Advanced grid draws the modal as a card over the page, where it floats.
  await keys('v', 'v');
  show('advanced grid: the modal is a card', await until('the card', (f) => f.includes('advanced grid') && /┌─+┐/.test(f) && f.includes('Subscribe')));
  await keys('v');
  await until('no grid', (f) => f.includes('no grid'));
  mockInput.pressEnter();
  await until('the modal to close', (f) => f.includes('clicked [19 button "No thanks"] · +0 -4 lines'));
  console.log('\nEnter closed the modal');

  mockInput.pressKey(':');
  await mockInput.typeText('hover 11');
  mockInput.pressEnter();
  show(':hover 11 opens a menu that shows on hover', await until('the hover menu', (f) => f.includes('Profile')));

  await keys('2');
  mockInput.pressEnter();
  show('2, Enter: a link that opens a new tab', await until('the new tab', (f) => f.includes('Medley fixture') && f.includes('tab 2/2')));
  await keys('[');
  await until('tab 1 again', (f) => f.includes('tab 1/2') && f.includes('Todos'));
  console.log('\n[ went back to tab 1');

  // A page that moves on by itself, after the command that started it is done
  // (like a "checking your browser" page): the UI follows without a key press.
  mockInput.pressKey(':');
  await mockInput.typeText('click 14');
  mockInput.pressEnter();
  show('the page went on by itself', await until('the new page', (f) => f.includes('Medley fixture') && f.includes('the page loaded')));

  // B lists bookmarks and this tab's history; a number and Enter opens one.
  await keys('B');
  show('B lists bookmarks and history', await until('the list', (f) => /1 +Medley test app/.test(f) && f.includes("this tab's history")));
  await keys('1');
  mockInput.pressEnter();
  show('1, Enter: the bookmark opens', await until('the bookmarked page', (f) => f.includes('# Todos') && !f.includes('bookmarks and history')));

  // T lists the tabs; a number and Enter switches. A click on "tab 1/2" in the top bar does too.
  await keys('T');
  show('T lists the tabs', await until('the tabs', (f) => f.includes('open tabs') && /2 +Medley fixture/.test(f)));
  await keys('2');
  mockInput.pressEnter();
  await until('tab 2', (f) => f.includes('tab 2/2') && f.includes('Medley fixture'));
  const topBar = setup.captureCharFrame().split('\n')[0];
  await mockMouse.click(topBar.indexOf('tab 2/2') + 2, 0);
  await until('the tabs from a click', (f) => f.includes('open tabs'));
  await keys('1');
  mockInput.pressEnter();
  await until('tab 1', (f) => f.includes('tab 1/2') && f.includes('# Todos'));
  console.log('\n2, Enter switched to tab 2; a click on "tab 2/2" listed the tabs; 1, Enter came back');

  // t opens the selected link in a new tab; T, then its number and d, closes it.
  await keys('\t');
  await keys('t');
  show('t opens the selected link in a new tab', await until('the new tab', (f) => f.includes('tab 3/3') && f.includes('Medley fixture')));
  await keys('T');
  await until('the tabs', (f) => f.includes('open tabs') && /3 +• Medley fixture/.test(f));
  await keys('3', 'd');
  await until('the tab to close', (f) => f.includes('tab 1/2') && f.includes('# Todos'));
  console.log('\nT, 3, d closed it, back in the tab it came from');

  await keys('?');
  show('? shows the keys', await until('the help', (f) => f.includes('any key to close')));
  await keys('x');
  await until('the help to close', (f) => !f.includes('any key to close'));

  await keys('q');
  show('q asks first', await until('the question', (f) => f.includes('Quit medley?')));
  await keys('n');
  await until('the question to go', (f) => !f.includes('Quit medley?'));
  await keys('q', 'y');
  show('y asks about the session', await until('the session question', (f) => f.includes('Close the background browser session')));
  await keys('y');
  await app.closed;
  // The session answers "stop" first and removes its file a moment later.
  for (let i = 0; i < 40 && readSessionInfo(SESSION); i++) await Bun.sleep(50);
  console.log(`\nn stayed; q, y, y quit and stopped the session: ${readSessionInfo(SESSION) ? 'still running (bad)' : 'stopped'}`);
} finally {
  setup.renderer.destroy();
  await send(SESSION, { cmd: 'stop', client: 'test' }).catch(() => {});
}

// With no session running, the address prompt opens by itself. A q typed
// there (meant to quit) must not start a browser for "https://q".
const EMPTY = 'tui-smoke-none';
const bare = await createTestRenderer({ width: 100, height: 24 });
try {
  const idle = new App(bare.renderer, sessionBackend(EMPTY, {}));
  void idle.start();
  show('no session: the address prompt opens, over the logo', await waitFor(bare, 'the prompt', (f) => f.includes('words to search for') && f.includes('m e d l e y')));
  await bare.mockInput.typeText('q');
  bare.mockInput.pressEnter();
  show('q, Enter: refused', await waitFor(bare, 'the refusal', (f) => f.includes("isn't a web address")));
  // The browser starts in the background while the address is typed, but a q opens nothing.
  await prewarm(EMPTY, {});
  const blank = await send(EMPTY, { cmd: 'status', client: 'test' }).catch((e: Error) => e.message);
  console.log(`the browser started ahead: ${readSessionInfo(EMPTY) ? 'yes' : 'no (bad)'}; q opened ${blank.includes('about:blank') ? 'nothing' : `something (bad): ${blank}`}`);

  // Words that aren't an address are a search (here MEDLEY_SEARCH points at a local page).
  bare.mockInput.pressBackspace();
  await bare.mockInput.typeText('two words');
  bare.mockInput.pressEnter();
  show('words, Enter: a search', await waitFor(bare, 'the search', (f) => f.includes('Medley fixture')));
  const at = await send(EMPTY, { cmd: 'status', client: 'test' });
  console.log(`the search went to: ${at.includes('fixture.html?q=two+words') ? 'the search page, with the words' : `${at} (bad)`}`);
  bare.mockInput.pressKey('Q');
  await idle.closed;
  console.log('Q quit at once');
} finally {
  bare.renderer.destroy();
  await send(EMPTY, { cmd: 'stop', client: 'test' }).catch(() => {});
}
