<p align="center">
  <img src="docs/assets/logo.png" alt="medley" width="200">
</p>

<p align="center">
  A text-mode web browser for humans and agents.<br>
  <a href="https://nam37.github.io/medley/">nam37.github.io/medley</a>
</p>

Pages come back as compact text with every interactive element numbered. You
act on elements by number, and each action prints only what changed. People can
browse in a full-screen terminal UI, agents through MCP or the CLI, and both can
share one session: you can watch an agent browse and take over at any point.

```
$ medley goto nam37.github.io/medley/demo/
Fernway Outfitters
https://nam37.github.io/medley/demo/ · 19 refs · viewport 0–900 of 1671px

── header ──
[1]Fernway

── nav "Main" ──
[2]Gear  [3]Trails  [4 button "Menu" collapsed]
…
$ medley click 4
clicked [4 button "Menu"] · +2 -1 lines
@@ nav "Main" @@
  ── nav "Main" ──
- [2]Gear  [3]Trails  [4 button "Menu" collapsed]
+ [2]Gear  [3]Trails  [4 button "Menu" expanded]
+ [20]Account  [21]Orders
```

## Install

You need [Bun](https://bun.sh) 1.3 or later, and Chrome or Edge (medley finds
them, or set `MEDLEY_BROWSER` to the browser's path). It drives the browser
over the DevTools protocol; the only package it depends on is
[OpenTUI](https://opentui.com), for the terminal UI.

```bash
git clone https://github.com/nam37/medley.git
cd medley
bun install
bun src/cli.ts tui en.wikipedia.org
```

The examples below write `medley` for `bun src/cli.ts`. To type it that way,
add an alias, such as `alias medley="bun /path/to/medley/src/cli.ts"` in bash
or zsh, or `function medley { bun C:\path\to\medley\src\cli.ts @args }` in
PowerShell.

## Terminal UI

```
medley tui [url]
```

```
 medley  Medley test app  file:///home/you/medley/test/app.html                12 refs · all
  ── header › nav "Main" ──
▎ [1]Fixture page  [2]Fixture in a new tab  [3 button "Menu" expanded]
▎ - [11]Settings
▎ - [12]Log out
  ── main ──
  # Todos
  [4 textbox "New todo"] [5 button "Add"]
 clicked [3 button "Menu"] · +3 -1 lines          agent: typed into [4 textbox "New todo"] ●
 Tab select · Enter open · o address · ← back · / find · : command · ? keys · q quit
```

It shows the session's current page, or opens `url`. Refs are colored and
link text is underlined. Lines that changed with the last action are marked in
the left gutter. The status line shows the result of your last action on the
left and, in purple, whatever another client (an agent) just did; the page
refreshes by itself when that happens, and also when the page loads a new one
on its own, such as the real site after a "checking your browser" page. `●`
means it's following the session live. While a command runs, a light band
sweeps across the `medley` badge and the status line says what's happening.

| Keys | |
|---|---|
| Tab, Shift+Tab | select the next or previous ref; the status line shows where a link goes |
| Enter, or a mouse click | open the ref: links and buttons are clicked; text fields, selects and file fields ask for input |
| 0-9, then Enter | open a ref by its number |
| h | hover over the selected ref (menus that open on hover) |
| [ ] | previous or next tab; the top bar shows `tab 2/3` when there's more than one |
| ↑ ↓ j k, Space PgDn PgUp, Home End | scroll; scrolling past the end scrolls the browser too, loading lazy content |
| o, Ctrl+L | open an address |
| ← b, → f | back, forward |
| / then n N | find text, next or previous match |
| : | run any session command, e.g. `press Escape`, `wait 2`, `select 6 High` |
| v | cycle the grid: no grid → partial grid (the page's main columns, like a sidebar beside the content) → advanced grid (the page as laid out, with its colors and pictures) |
| r, R | reload the page, like a browser's refresh (R bypasses the cache) |
| w | wait 2 seconds and show what the page changed by itself |
| y n | accept or dismiss a `confirm()` the page opened (a `prompt()` asks for its answer) |
| ? | show all keys |
| q | quit: asks "Quit medley?", then whether to keep the browser session running for other clients |
| Q, Ctrl+C | quit at once, keeping the session running |

In a field prompt, Enter types and submits (like pressing Enter in the field),
Tab types without submitting, and Esc cancels.

The grid modes only change how the page is drawn; the text, refs and keys stay
the same.

- **Partial grid** turns groups of side-by-side blocks into columns, with widths
  in proportion to the page. It only does so when every column gets at least 20
  characters; otherwise the group stays linear, so on a narrow terminal it falls
  back to the plain view.
- **Advanced grid** draws the page itself, scaled to the terminal. Each block's
  text goes where the block was, in the page's own text colors, over its
  background colors and card borders. Pictures are drawn in half-block
  characters from a screenshot, which the UI fetches once per page (`r` fetches
  it again). When text needs more rows than its box had on the page, everything
  below moves down together, so blocks that lined up on the page still line up.
  Things that were off the page to the side, such as a carousel's hidden
  slides, aren't drawn, as on the page. The `#` and `──` markup of the text
  format is left out, and tables are drawn as ruled grids with a bold header
  row. A grid grows wider than the table was on the page when its text needs
  the room, but only into free space; otherwise its cells wrap.

## Commands

```
medley goto <url>                   open a page (starts the session if needed)
medley snapshot [--diff] [--links]  print the current page, or only what changed since you last looked
medley click <ref>
medley type <ref> <text> [--submit] replace a field's text, optionally pressing Enter
medley select <ref> <option>        choose a <select> option by text or value
medley press <key>                  Enter, Escape, Tab, ArrowDown, PageDown, a, Control+a, …
medley hover <ref>                  move the mouse over an element (menus that open on hover)
medley scroll [down|up|top|bottom|<ref>]
medley upload <ref> <file>...        choose files for a file field, as if picked in its dialog
medley reload [--hard]              reload the page (--hard: bypass the cache)
medley back | forward
medley tabs                         list open tabs
medley tab <number>                 switch to a tab
medley close-tab [number]           close a tab (the current one by default)
medley wait [seconds]               let the page work, then show what changed
medley dialog accept [text] | dismiss
medley status | stop

medley tui [url]                    the terminal UI, sharing the session
medley snapshot <url> [--json]      one-off: fresh browser, print the page (or its raw model), exit
medley mcp                          MCP server on stdio, sharing the session
```

Options: `--session <name>` for parallel sessions, `--headed` to watch the
browser window, `--no-color`, `--width <px>`, `--browser <path>`.

### Use it from an agent

```
claude mcp add medley -- bun /path/to/medley/src/cli.ts mcp
```

The MCP tools (`browser_goto`, `browser_click`, `browser_type`, …) talk to the
same session as the CLI and the terminal UI. Run `medley tui` while an agent
browses to watch it live, or `medley snapshot` to take a single look. An agent
with a shell can also just call the CLI.

## Output format

| Syntax | Meaning |
|---|---|
| `[7]text` | link (ref 7); state in parens, e.g. `(current)`, `(expanded)` |
| `[8 kind "name" = "value" states]` | other controls: button, textbox, combobox, select, checkbox, radio, slider, tab, menuitem, option, file |
| `[9 clickable …]` | outermost pointer-cursor element that isn't a real control (script-driven click target) |
| `── nav "Primary" ──` | landmark: header, nav, main, aside, footer, search, form, dialog; `header › nav` when nested |
| `#`, `-`, `1.`, `\|` tables, fences, `>` | headings, lists, data tables, `<pre>`, blockquotes |
| `[img "alt"]`, `[iframe "title"]`, `[video]` | non-text content (unlabelled images are dropped) |

Blocks that sit side by side on the page share a line. Hidden content is
dropped, label text is folded into its control's name, and passwords are masked.

After an action you get one of:

- **a diff:** `- ` old line, `+ ` new line, grouped under `@@ landmark › heading @@`;
- **the full new page**, when the action navigated (`→ new page`) or rewrote most of the page;
- **a dialog notice**, when the page opened `confirm()` or `prompt()`. The page is
  blocked until you answer with `dialog accept` or `dialog dismiss`. Alerts are
  acknowledged automatically and reported as a `note:`.

## How it works

- **Session** (`src/daemon.ts`, `src/session.ts`): a background process owns
  the browser and serves commands to local clients over HTTP on 127.0.0.1.
  Every request must carry a random token from `~/.medley/<name>.json`, which only
  your user can read. Commands run one at a time, and each one is announced on
  an event stream (`/events`) that the terminal UI follows. The session exits
  on `stop`, when the browser closes, or after 30 idle minutes. Its log is
  `~/.medley/<name>.log`.
- **Terminal UI** (`src/tui/`) is one more client. It asks for the page's
  lines with each command, wraps and draws only the visible rows in a custom
  OpenTUI renderable (`page-view.ts`), and finds refs in the text itself
  (`src/tokens.ts`). With the lines it also gets layout data from the
  renderer: which runs of blocks sat side by side (for partial grid), and for
  each line the page box it came from, with that box's position, colors and
  borders, plus where the pictures were (for advanced grid). The text itself
  never changes, so agents and diffs never see any of it.
- **Tabs:** a link or script that opens a new tab moves the session into it,
  and the result says so (`tabs`, `tab <n>` and `close-tab` manage them). When
  a tab closes, whether you closed it or its page did, the session carries on
  in the tab that opened it. A `confirm()` from a tab in the background is
  dismissed and noted.
- **Medley's scripts run in an isolated world**, as a browser extension's do:
  they share the page's DOM but not its JavaScript. A page can't see or forge
  the ref table, which could otherwise steer an agent into clicking the wrong
  thing, and a page that tampers with built-ins can't break extraction.
- **Refs are stable.** An element keeps its number for as long as the document
  lives, so diffs show only real changes. Each client (the CLI, each MCP
  connection) has its own baseline. Refs from before a navigation are refused
  instead of hitting whatever now has that number.
- **Clicks are real mouse events** at a point that hit-testing confirms lands on
  the element (or its label). If something covers it, the error names what.
  `type` focuses the field, selects its text and inserts the new text, so
  frameworks see ordinary input events.
- **Settling:** after each action it waits for any navigation, then for the
  network and the DOM to go quiet, before taking the next snapshot. A page
  that moves on later by itself (a redirect after a browser check, a meta
  refresh) is announced on the event stream once it settles; the next
  command reports it as a new page.
- **Uploads** set a file field's files directly, as picking them in its
  dialog would, and the page gets its usual `change` event. Paths are resolved
  by the client (the CLI, the terminal UI or the MCP server) against its own
  directory. A snapshot shows the chosen files' names as the field's value.
- **Extraction** (`src/extract.js`) runs inside the page and walks what's
  rendered, including open shadow roots and same-origin iframes.
  **Rendering** (`src/render.ts`) turns that into text. **Diffs**
  (`src/diff.ts`) use Myers' algorithm on lines.

`test/fixture.html` covers rendering edge cases; `test/app.html` covers
actions (menus, async form submit, `<select>`, alert, confirm, a covering
overlay, lazy loading, a hover menu, links to the same tab and a new tab, a
popup that closes itself, a multi-file field, a button whose page moves on by
itself a moment later, and a script that tries to forge the ref table).
`bun test/preview.ts <url> out.html [--mode advanced] [--width 150] [--rows 120]`
draws a page the way the terminal UI would, into an HTML file of colored
terminal cells, for looking at the grid modes without a terminal.
`bun run test:tui` drives the terminal UI through OpenTUI's test renderer
against a real session on `test/app.html`: keys, a field prompt, a simulated
agent acting in the same session, reload, a file prompt, the working badge,
find, a command, a mouse click, back, a `confirm()`, a page that moves on by
itself, and the help overlay. It prints each frame as it goes.
`bun scripts/site-shots.ts <dir> [--as <url>]` drives the terminal UI through
the demo shop in `docs/demo/` and saves its frames as HTML; the website's
terminal pictures come from it.

## Known gaps

- Cross-origin iframes render as placeholders and can't be acted on.
- There's no drag and drop.
- Downloads are blocked.
- Canvas and WebGL apps don't render.
- Some sites block headless Chrome; `--headed` may help.
- `--headed` and the 30-minute idle shutdown haven't been exercised yet.
- The terminal UI's input line can't mask what you type, so a password typed
  into a field prompt is visible on screen (the page itself still masks it).
- Advanced grid draws solid background colors and `<img>`, `<video>` and
  `<canvas>` pictures, but not CSS background images or gradients. Elements
  fixed to the window (chat buttons, cookie bars) appear where they sat at the
  top of the page. Pictures inside tables aren't drawn, since a grid's rows
  don't follow the page's.

## Next

- Images in the terminal UI via the kitty or sixel graphics protocols.
- Acting inside cross-origin iframes.
