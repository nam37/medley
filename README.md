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
bun src/medley.ts tui en.wikipedia.org
```

The examples below write `medley` for `bun src/medley.ts`. To type it that way,
add an alias, such as `alias medley="bun /path/to/medley/src/medley.ts"` in bash
or zsh, or `function medley { bun C:\path\to\medley\src\medley.ts @args }` in
PowerShell (in the file `$PROFILE` names, so every new window has it).

A command takes as long as the page does to load and settle, plus Bun's own
start (a few hundred milliseconds). The first command also starts the browser,
which takes a second or two; the terminal UI starts it while you type the first
address. If Bun came from npm, its launcher adds to every start; Bun's own
installer ([bun.sh](https://bun.sh)) doesn't have one.

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

It shows the session's current page, or opens `url`; until there's a page, medley's
logo stands in for it, a light running along the "m". Refs are colored and
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
| t | open the selected link in a new tab |
| T, or a click on "tab 2/3" | the open tabs: type a number, then Enter switches to it (or d closes it) |
| l, or a click on "N refs" | pull down a list of the page's refs, with where each link goes: type to filter, ↑ ↓ to choose, Enter (or a click) opens |
| Enter, or a mouse click | open the ref: links and buttons are clicked; text fields, selects and file fields ask for input |
| 0-9, then Enter | open a ref by its number |
| h | hover over the selected ref (menus that open on hover) |
| [ ] | previous or next tab; the top bar shows `tab 2/3` when there's more than one |
| ↑ ↓ j k, Space PgDn PgUp, Home End | scroll; scrolling past the end scrolls the browser too, loading lazy content |
| o, Ctrl+L | open an address, or type words to search for them |
| a | bookmark this page |
| B | bookmarks and this tab's history: type a line's number, then Enter opens it (or d deletes a bookmark) |
| ← b, → f | back, forward |
| / then n N | find text, next or previous match |
| : | run any session command, e.g. `press Escape`, `wait 2`, `select 6 High`; `audit`, `console`, `network`, `extract` and `record stop` show their results in a box over the page, and while `record start` records, the top bar shows `● rec` and the number of steps |
| v | cycle the grid: no grid → partial grid (the page's main columns, like a sidebar beside the content) → advanced grid (the page as laid out, with its colors and pictures) |
| i | the page's pictures one at a time, as big as the view fits them, starting from the first in view: ← → step, Esc closes |
| m | reader mode: articles show only their main text, without the site's menus, sidebars and footers; it stays on from page to page until m again |
| > | tell the agent something (about the selected ref, if one is), or answer the question it asked; a box shows what you and the agent said |
| =, or a click on the title or address | page info, as a browser's padlock menu shows it: the connection and certificate, cookies and site data (c, then y, clears this site's), what the page says about itself, and what loading it took |
| \ | the page's source, as the server sent it (with find); \ again brings the page back |
| r, R | reload the page, like a browser's refresh (R bypasses the cache) |
| w | wait 2 seconds and show what the page changed by itself |
| y n | accept or dismiss a `confirm()` the page opened (a `prompt()` asks for its answer) |
| ? | show all keys (↑ ↓ PgUp PgDn scroll them when they don't all fit) |
| q | quit: asks "Quit medley?", then "Close the background browser session?" (n keeps it running for other clients) |
| Q, Ctrl+C | quit at once, keeping the session running |

In a field prompt, Enter types and submits (like pressing Enter in the field),
Tab types without submitting, and Esc cancels. A password field's prompt shows
a dot for each character and never the text itself; it starts empty.

The grid modes only change how the page is drawn; the text, refs and keys stay
the same.

- **Partial grid** turns groups of side-by-side blocks into columns, with widths
  in proportion to the page. It only does so when every column gets at least 20
  characters; otherwise the group stays linear, so on a narrow terminal it falls
  back to the plain view.
- **Advanced grid** draws the page itself, scaled to the terminal. Each block's
  text goes where the block was, in the page's own text colors, over its
  background colors and card borders. Pictures (`<img>`, `<video>`, `<canvas>`,
  and CSS background pictures and gradients) come from a screenshot, which the
  UI fetches again whenever the page's pictures change or the page grows, and
  are drawn the best way the terminal can: Kitty graphics (Kitty, WezTerm, Ghostty), Sixel
  (Windows Terminal and others), or else block characters, which work in any
  terminal. OpenTUI picks; `OPENTUI_IMAGE_PROTOCOL=blocks|sixel|kitty`
  overrides it. When text needs more rows than its box had on the page,
  everything below moves down together, so blocks that lined up on the page
  still line up. Things that were off the page to the side or above it, such
  as a carousel's hidden slides or a hidden "skip to content" link, aren't
  drawn, as on the page. A dialog floating over the page (a
  modal, a consent notice) is drawn as a bordered card where it floated,
  hiding what it covers, as on the page. The `#` and `──` markup of the text
  format is left out, and tables are drawn as ruled grids with a bold header
  row. A grid grows wider than the table was on the page when its text needs
  the room, but only into free space; otherwise its cells wrap.

## Commands

```
medley goto <url>                   open a page (starts the session if needed)
medley search <words>               search the web and open the results
medley snapshot [--diff] [--links]  print the current page, or only what changed since you last looked
medley snapshot --outline           the page's regions and headings, with how many lines and refs each holds
medley snapshot --section <name>     one region or heading and what's under it
medley snapshot --reader             reader view: only the page's main text (goto <url> --reader too)
medley click <ref>                   a ref's number, or its name: click Add to cart, hover link Moss Step
medley type <ref> <text> [--submit] replace a field's text, optionally pressing Enter
medley fill <ref>=<value>... [--submit]  fill fields at once: text, a select's option, a checkbox on/off, a slider's number
medley select <ref> <option>        choose a <select> option by text or value
medley press <key>                  Enter, Escape, Tab, ArrowDown, PageDown, a, Control+a, …
medley hover <ref>                  move the mouse over an element (menus that open on hover)
medley drag <ref> <ref|text>        drag an element onto another, or onto a drop zone's text
medley scroll [down|up|top|bottom|<ref>]
medley upload <ref> <file>...        choose files for a file field, as if picked in its dialog
medley reload [--hard] [--diff]     reload the page (--hard: bypass the cache; --diff: only what changed)
medley back | forward
medley history [n]                  list this tab's pages, or go to the n-th
medley downloads                    list what this session downloaded, and where
medley tabs                         list open tabs
medley newtab [url]                 open a new tab, blank or on a page, and switch to it
medley click <ref> --new-tab        open a link in a new tab, keeping this page
medley tab <number>                 switch to a tab
medley close-tab [number]           close a tab (the current one by default)
medley wait [seconds]               let the page work, then show what changed
medley wait --for <text> [seconds]  wait until the text (or the page title) shows, then show what changed
medley wait --gone <text> [seconds] wait until it doesn't (a "Loading…" going away)
medley screenshot [file] [--full]   save a PNG of the window, or of the whole page
medley find <text>                  the lines with the text, each with a line around it and where it is
medley extract                      the page's tables and runs of repeated items (results, cards)
medley extract table <n> [--csv]    one table as JSON rows keyed by its header, or CSV
medley extract items <n> [--csv]    one run of items: each one's text, and its link's ref, words and address
medley console [--all]              the errors and warnings the page logged (--all: every message)
medley network [--all]              the page's failed requests (--all: every request)
medley audit [--json]               check the page's accessibility, with the refs of what's wrong
medley inspect <ref> [--shot <file>]  one element, closely: markup, selector, name, box, why it can't be
                                    seen or clicked, styles, CSS rules and listeners with file and line
medley expect <text>                check the text is on the page (waiting up to 5s), or fail
medley expect --gone <text>         check it isn't
medley expect --count <n> <text>    check it's there n times ("button Remove" counts buttons by name)
medley expect --url <text>          check the address has the text (--title <text>: the title)
medley expect --value <ref>=<text>  check a field holds exactly that (a checkbox: on or off)
medley expect --disabled <ref>      check a control's state: --enabled, --checked, --unchecked,
                                    --focused, --expanded, --collapsed, --selected, --pressed
medley expect --no-errors           check the page logged no errors and none of its requests failed
                                    (several in one expect: all must be so; --within <seconds> waits longer)
medley record start [file]          write down what's done in the session, as a script
medley record stop | status         stop and print the script, or say how far it's got
medley info [--json]                page info: connection and certificate, cookies and site data, about the page, loading
medley clear-site-data              delete the page's site's cookies and stored data (signs you out there)
medley source [--dom]               the page's HTML as the server sent it (--dom: as it is now)
medley ask <question> [choice…]     ask the person watching in the terminal UI, and wait for the answer
medley tell <message>               tell the person watching what you're doing
medley dialog accept [text] | dismiss
medley status | stop

medley replay <script> [--verbose]  do a script's steps again, stopping at the first that fails
medley playwright <script>          print a script as a Playwright test
medley watch [dir] [--hot]          reload the page when files change, and say how its text changed
medley tui [url]                    the terminal UI, sharing the session
medley snapshot <url> [--json]      one-off: fresh browser, print the page (or its raw model), exit
medley mcp                          MCP server on stdio, sharing the session
```

A long page can be read in parts: `goto <url> --outline` (or `search … --outline`)
returns the new page's outline instead of all of it, and `snapshot --section
History` returns one part, with refs that work as usual. On a Wikipedia article
the outline is 1.5 KB where the page is 22 KB. MCP takes `outline` and
`section` the same way.

An article can be read without the site around it: `goto <url> --reader` or
`snapshot --reader` (MCP `reader`, the terminal UI's `m`) returns only the
page's main text, with its refs: the headline, byline and body, without the
menus, sidebars, footers and teasers. Medley finds it much as Firefox's Reader
View does, by where the page's running text is, and says so when a page (a
home page, a search) has no main text to single out. A BBC News article is 34
of its 93 lines.

Options: `--session <name>` for parallel sessions, `--headed` to watch the
browser window, `--no-color`, `--width <px>`, `--browser <path>`, and two that
apply when a session starts:

- `--profile <name>` keeps the browser profile in `~/.medley/profiles/<name>`,
  so cookies, logins and site storage last from one session to the next (or
  set `MEDLEY_PROFILE`). Without it, each session starts with a fresh profile
  that's deleted when it stops. One session at a time can use a profile.
- `--downloads <dir>` is where downloads go (default `~/Downloads/medley`).
  A click or a `goto` that downloads a file waits for it (up to 30 seconds)
  and ends with a note saying where it was saved; `downloads` lists them all.
  A file never overwrites another: the second `report.csv` is `report (2).csv`.

Searches (`search`, MCP `browser_search`, or words typed in the terminal UI's
address prompt) go to Bing, which answers headless browsers; set
`MEDLEY_SEARCH` to another engine's URL with `%s` where the words go.
Bookmarks are kept in `~/.medley/bookmarks.json` (or `MEDLEY_BOOKMARKS`),
shared by every session.

If a session was started by an older copy of medley, commands it doesn't know
fail with a hint to restart it (`medley stop`), and the terminal UI says so
when it attaches.

### Use it from an agent

```
claude mcp add medley -- bun /path/to/medley/src/medley.ts mcp
```

The MCP tools (`browser_goto`, `browser_click`, `browser_type`, …) talk to the
same session as the CLI and the terminal UI. Run `medley tui` while an agent
browses to watch it live, or `medley snapshot` to take a single look. An agent
with a shell can also just call the CLI.

Some things are there to keep an agent's context small and its steps sure:

- **Names for refs.** Anywhere a ref goes, the element's name works too:
  `click Add to cart`, MCP `{"ref": "Add to cart"}`. `button Save` says which
  kind. Names are looked up on the page as it is, so they keep working after
  the numbers move on; a name that fits several elements fails with a list of
  them rather than guessing.
- **A size limit.** Over MCP, a page result longer than `max_chars` (40,000 by
  default; 0 for none) comes back as the page's outline instead, saying so, so
  one heavy page can't flood a conversation. On the CLI, `--max`.
- **`find`.** Only the lines with some text, each with a line around it and
  where it is on the page (`@@ main › ## Results @@`), with their refs.
- **`extract`.** A page's tables (JSON rows keyed by their header, or CSV) and
  runs of repeated items such as search results and product cards (each with
  its text and its link's ref, words and address). Menus and footers aren't
  data, and neither is a paragraph with a link in it.
- **Errors, as notes.** After any action, a note says if the page logged errors
  or requests to its own site failed (`note: 1 request failed: 404 POST
  /api/cart`); `console` and `network` list them. Console messages are heard on
  local development pages (localhost, `*.test`, files) from the start, and
  elsewhere from the first time you ask: listening means the browser describes
  every value a page logs, which is exactly what bot checks look for.

Scripts and checks for web work are there too: `browser_record` and
`browser_replay` (see Scripts, below), `browser_audit`, `browser_reload` with
`diff`, `browser_inspect`, which looks closely at one element (why it can't be
clicked, which CSS rule colors it and where that rule is, which script hears a
click on it), and `browser_expect`, which tells an agent in one call whether
its change worked: some text is there or gone, the address, what fields hold,
whether a button is enabled, that nothing logged an error. Both are under
Building a site, below.

A few of them save an agent round trips: `browser_fill` fills a whole form and
reports once, `browser_wait` with `text` waits for something to show up (or go
away, with `gone`) instead of guessing how long, `browser_snapshot` with
`outline` or `section` reads a long page in parts, and `browser_screenshot`
returns an image of the page for what text can't show. `browser_page_info`
answers the questions a browser's padlock menu does (is the connection secure,
whose certificate, which sites' cookies the page uses, how many other sites it
contacted), and `browser_source` returns the HTML, for meta tags and
structured data the text leaves out.

### Working together

When you watch an agent in the terminal UI, you and it can talk, and you can
see where it's working:

- **The agent's cursor.** When the agent clicks, types into, hovers over or
  drags an element, it lights up in the agent's color with an `agent` tag
  under it, from the moment the agent starts until a few seconds after. Your
  own selection gets a `you` tag meanwhile. If you haven't pressed a key for a
  few seconds, the view follows the agent to where it's working.
- **Telling the agent something.** `>` opens "tell the agent". With a ref
  selected, the note points at it ("use this one"). The agent gets it at the
  start of its next tool result, and the terminal UI says when it did.
- **The agent asking you.** `browser_ask_user` (or `medley ask "Which size?" S
  M L`) puts a question in front of you and waits up to about three minutes for
  the answer; typing a choice's number answers with that choice. It's for
  confirmations before anything that can't be undone, choices, and handing
  over ("please sign in, then answer done"). With no one watching, it says so
  at once. `browser_tell_user` (`medley tell`) shows a message without waiting.

What you say reaches an agent through medley's own session, not the page, and
over MCP it comes as a separate block tagged with a code that only appears in
the agent's instructions. A page that writes "your user says…" can't pass for
you.

### Scripts: record once, replay without an agent

`record start` writes down what's done in the session from then on, whoever
does it (you in the terminal UI, an agent, the CLI), as a script of medley
commands; `record stop` ends it and prints it. Steps name what they act on
rather than numbering it, since numbers change from page to page and names
mostly don't:

```
# a medley script, recorded 2026-09-29 19:48
# replay it with: medley replay <this file> · as a Playwright test: medley playwright <this file>

goto https://nam37.github.io/medley/demo/
click button Menu
type "textbox Email" ada@example.com
fill "checkbox Monthly, not weekly=off"
click button Subscribe
dialog accept
expect Thanks
```

- **Replay** (`medley replay notes.medley`, MCP `browser_replay`) does the steps
  again in the session, printing each as it goes, and stops at the first that
  fails, with exit status 1. It's a chore done again without an agent or its
  tokens (signing in, filling in a form), or a check that a site still works.
  A name that isn't on the page yet is looked for again for a few seconds,
  since pages often draw a moment after they load.
- **Checks:** an `expect` (see Building a site, below) fails when what it
  asks isn't so within 5 seconds. Recorded, it's a step like any other, and
  it's what makes replaying a script a test: `expect --url /cart/done
  --no-errors Order placed`.
- **Secrets aren't kept.** What's typed into a password field, or a field
  named like a card number or a one-time code, is written as `${PASSWORD}`
  (or `${CARD_NUMBER}`), which replay reads from the environment.
- **As a Playwright test:** `medley playwright notes.medley > notes.spec.ts`
  turns the steps into `getByRole('button', { name: "Subscribe" }).click()`
  and so on, for a test suite. What doesn't translate one to one (tabs) comes
  out as a comment.
- A script is plain text: edit it, add checks, keep it with your code. Lines
  starting with `#` are comments. Words are quoted as in a shell: `"…"`, `'…'`
  (taken literally: a `${…}` in it isn't read from the environment), and
  `$'…'` with `\n`-style escapes, which recording uses for text with line
  breaks, so whatever was typed reads back exactly, as one step. A quoted word
  is never an option: `type "textbox Note" "--submit"` types `--submit`. A step whose element has no name of its own
  (two "Add to cart" buttons) keeps its number, with a comment saying so.
  Recordings go to `~/.medley/recordings/` unless you name a file, and are
  saved after every step.

### Building a site

- **`inspect`** (MCP `browser_inspect`) looks closely at one element, as a
  browser's developer tools would, for finding out why it looks or behaves as
  it does and where in the source to change it:

  ```
  $ medley inspect button Place order
  [14 button "Place order"]
  <button id="order" class="btn primary" type="button" disabled>
  in         body › main › form#checkout › p.actions
  selector   #order
  name       "Place order", from its text · role button (from its tag)
  states     disabled
  box        106.6×33 at 24,189.9 · in the window
  visible    yes
  clickable  no: it's disabled
  colors     #ffffff on #0a7d5e · contrast 5.1:1
  font       600 13.3px/normal Arial · text-align center
  layout     display block · padding 8px 16px · border 1px solid #0a7d5e · border-radius 6px
             an item of p.actions (flex row, align-items center, gap 12px): flex 0 1 auto
  other      cursor not-allowed · opacity 0.5
  rules      .btn.primary { background: #0a7d5e; color: #ffffff }  app.css:9
             button:disabled { opacity: 0.5; cursor: not-allowed }  app.css:10
             @media (min-width: 600px) .btn { font-weight: 600 }  app.css:12
             .btn { padding: 8px 16px; border: 1px solid #0a7d5e; border-radius: 6px; colour: red (not valid: ignored) }  app.css:3
             from body: body { font-family: Georgia, serif; color: #1f2a33 }  app.css:1
  listeners  click  cart.js:42
             click, on form#checkout  cart.js:12
  html       <button id="order" class="btn primary" type="button" disabled>Place order</button>
  ```

  - **Where it is:** what it's inside of, and a CSS selector that finds it
    and nothing else (its id, a test id, its classes, or a path), to search
    the source for.
  - **What it's called**, and where the name comes from: its text, a label,
    `aria-label`, or only a placeholder.
  - **Whether it can be seen and clicked, and why not:** `display: none` on
    something around it, no size, cut off by an `overflow: hidden` box,
    outside the window, covered by a banner (and which), disabled,
    `pointer-events: none`. Nothing is scrolled to find out.
  - **How it looks:** its colors and their contrast, font, box and layout,
    and its part in a flex row or a grid. `--css gap,min-width` reads more
    properties.
  - **The rules behind that:** the page's own CSS rules that apply to it,
    strongest first, each with its stylesheet and line, the media query it's
    in, and any declaration the browser ignored as not valid; then the rules
    of what's around it that it inherits from. A minified file's line comes
    with its column.
  - **What hears it:** the event listeners on it, and those around it for
    clicks, keys and input, each with its script and line. A framework that
    listens for everything at the top (React) shows as one line there.
  - `--shot order.png` saves a picture of just the element (small ones at
    twice their size); over MCP, `screenshot: true` returns it as an image.
    `--json` gives all of it as data. In the terminal UI, `:inspect` is about
    the selected ref.
  - A password's value is never shown, in the report or in the markup. The
    rules and listeners come from the browser's own debugger and CSS tools,
    which are on only for the moment it takes to read them.
- **`expect`** (MCP `browser_expect`) says whether a change worked, so nobody
  has to read the page again and judge. It waits up to 5 seconds (`--within
  <seconds>` for longer) for what it's asked to be so, and fails, with exit
  status 1, saying what is so instead:

  ```
  medley expect Thanks for your order                    the text is on the page, or in its title
  medley expect --gone Loading                           it isn't
  medley expect --count 3 In stock                       it's there 3 times
  medley expect --count 3 button Remove                  there are 3 buttons with Remove in their names
  medley expect --url /cart/done --title Thanks          the address has the text, and the title does
  medley expect --value "textbox Email=ada@example.com"  the field holds exactly that
  medley expect --disabled "button Place order"          the button is disabled
  medley expect --no-errors                              the page logged no errors, none of its requests failed
  ```

  Several go in one expect, which passes when all of them are so, and
  otherwise says which weren't, then which were:

  ```
  $ medley expect --url /cart --enabled "Place order" --no-errors
  medley: expected [14 button "Place order"] to be enabled, but it's disabled (after 5s; the page is "Your cart", http://localhost:3000/cart)
  ok: the address has "/cart" (http://localhost:3000/cart)
  ok: the page logged no errors, and none of its own requests failed
  ```

  - Text is matched as people read it: in any case, any run of whitespace as
    one space, and in the page's frames too.
  - `--count` counts text, unless it starts with a kind of element (`button`,
    `link`, `checkbox`, `textbox`, …): then it counts those elements, by the
    names snapshots show (`button Remove` fits `[8 button "Remove Trail
    shoes"]`), or all of that kind when there's no name.
  - `--value` takes `field=text` as `fill` does: exactly the field's text, a
    select's option by its text or value, `on` or `off` for a checkbox. A
    password is compared but never shown.
  - States are the words snapshots show after a control, and `enabled`:
    `--checked`, `--unchecked`, `--enabled`, `--disabled`, `--focused`,
    `--expanded`, `--collapsed`, `--selected`, `--pressed`. A wrong focus
    says where the focus is.
  - `--no-errors` is about the page since it loaded: errors it logged
    (uncaught ones too), and requests to its own site for pages, scripts and
    data that failed. It's what the notes after actions report.
  - The address is matched as written; the title in any case.
  - A page that doesn't answer fails the check ("couldn't tell whether…"):
    no answer is never a pass.
  - Over MCP the same checks are `text` (with `gone` or `count`), `url`,
    `title`, `fields` (as `browser_fill` takes them), `states` and
    `no_errors`. In the terminal UI, `:expect …` shows how each came out.
- **`watch`** reloads the session's page whenever a file in the directory
  changes (`medley watch src`), and prints how its text changed, with any
  errors it logged. `--hot` is for dev servers that update the page
  themselves (Vite, webpack): it waits a moment instead of reloading. Folders
  like `node_modules` and `.git` don't count.
- **`reload --diff`** (MCP `browser_reload` with `diff`) says how the page's
  text changed since before the reload, not all of it: the loop for an agent
  editing a page. Refs that a reload renumbered don't count as changes.
- **`audit`** (MCP `browser_audit`) checks the page for the accessibility
  problems that can be found by looking at it (WCAG 2.2 A and AA): pictures
  without a text alternative, controls without names, text with too little
  contrast (on a known background; not over a picture), clickable things a
  keyboard can't reach, focusable things hidden from screen readers, frames
  without titles, no page language or title, zoom turned off; and as warnings,
  fields labelled only by a placeholder, vague link text, headings that skip
  levels, tabindex above 0, file names as alt text. Each finding names the ref
  it's about, so an agent can act on it, and the element as a developer finds
  it (`button.icon`), with how to fix it. `--json` gives the findings as data.
- **`console` and `network`** (above) say what the page logged and which of
  its requests failed.

`info` reads like this (for The Verge):

```
Connection
  Secure: TLS 1.3 (X25519MLKEM768, AES_128_GCM) over HTTP/2 from 151.101.65.91:443
  Certificate for *.theverge.com (and 22 other names), issued by GlobalSign Atlas R3 DV TLS CA 2026 Q2, valid Jun 26, 2026 to Jan 11, 2027
Cookies and site data
  38 cookies from theverge.com; 79 from 24 other sites: sonobi.com 20, pubmatic.com 11, twitter.com 5, rubiconproject.com 5, smartadserver.com 3 and 19 more
  351 kB stored: indexeddb 351 kB, service workers 720 bytes
About this page
  The Verge
  https://www.theverge.com/
  "The Verge is about technology and how it makes us feel. …"
  American English
  3,656 words, about 16 minutes to read
  504 links · 10 fields in 1 form · 115 pictures · 18 frames
Loading
  200 OK, text/html · parsed in 1.8 s · still loading after 8.6 s
  351 requests to 96 hosts (65 other sites) · at least 4.2 MB transferred
  Other sites it asked: adsafeprotected.com, ad-delivery.net, cookielaw.org, doubleclick.net, google.com, … and 57 more
```

## Output format

| Syntax | Meaning |
|---|---|
| `[7]text` | link (ref 7); state in parens, e.g. `(current)`, `(expanded)` |
| `[8 kind "name" = "value" states]` | other controls: button, textbox, password, combobox, select, checkbox, radio, slider, tab, menuitem, option, file, draggable (a password's value shows as `********`; a file field's, as the chosen files' names) |
| `[9 clickable …]` | outermost pointer-cursor element that isn't a real control (script-driven click target) |
| `── nav "Primary" ──` | landmark: header, nav, main, aside, footer, search, form, dialog; `header › nav` when nested |
| `#`, `-`, `1.`, `\|` tables, fences, `>` | headings, lists, data tables, `<pre>`, blockquotes |
| `[img "alt"]`, `[iframe "title"]`, `[video]` | non-text content (unlabelled images are dropped; an iframe shows as a placeholder only when its content can't be read) |
| `── iframe "Checkout" ──` | the content of an embedded frame from another site, read in where the frame is; its refs work like any other |

Blocks that sit side by side on the page share a line. Hidden content is
dropped, label text is folded into its control's name, and passwords are masked.
An open modal (a cookie or terms notice, a sign-up box) usually comes last, as
`── dialog "…" ──`, since pages put it at the end. Clicking something it covers
fails with the modal's buttons, e.g. `ref 17 is covered by a dialog "Legal Terms
and Privacy"; close it first: [323 button "Agree"]`; in the terminal UI, that
button is selected instead, so Enter presses it.

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
  on `stop`, when the browser closes, or 30 minutes after its last command
  (`MEDLEY_IDLE_MINUTES` changes that). Its log is
  `~/.medley/<name>.log`.
- **Terminal UI** (`src/tui/`) is one more client. It asks for the page's
  lines with each command, wraps and draws only the visible rows in a custom
  OpenTUI renderable (`page-view.ts`), and finds refs in the text itself
  (`src/tokens.ts`), checking each against the page's own list of refs, so
  text that only looks like one (a link reading "[1] Intro", a snapshot
  quoted in a README) isn't taken for one. With the lines it also gets
  layout data from the renderer: which runs of blocks sat side by side (for
  partial grid), and for
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
  instead of hitting whatever now has that number, and so are refs into a
  frame that has since loaded another page.
- **Clicks are real mouse events** at a point that hit-testing confirms lands on
  the element (or its label), and, in a frame, gets through each page around
  it to that frame. If something covers it, the error names what.
  `type` focuses the field, selects its text and inserts the new text, so
  frameworks see ordinary input events. It checks first that the keyboard
  focus went to that field: a widget that takes it only when clicked (a
  combobox that opens a search box) is clicked, and if the focus still isn't
  in a field of its own, `type` fails rather than type into whatever had it.
- **Settling:** after each action it waits for any navigation, then for the
  network and the DOM to go quiet, before taking the next snapshot. Requests
  that can't change the text (images, media, fonts, pings, prefetches) and
  ones open for over 3 seconds (long polls, streams) aren't waited for, nor are
  the pages of frames (they're waited for when read). A page that moves on
  later by itself (a redirect after a browser check, a meta refresh) is
  announced on the event stream once it settles; the next command reports it
  as a new page. The session log has a line per command with where its time
  went: `goto https://news.ycombinator.com 1992ms (action 1440 · settle 511 · read 39)`.
- **Nothing waits forever.** Settling takes 15 seconds at most; a page still
  loading by then (a script or a request holding it up) comes back as far as
  it got, with a note saying so. The browser has 30 seconds to answer anything
  (`MEDLEY_PAGE_TIMEOUT` changes that), and a page stuck in a script, which
  answers nothing, is reported as stuck within a few seconds; `reload`, `goto`,
  `back` and `forward` stop the stuck script first. A wait or a check that
  couldn't look at the page says it couldn't tell, never that the text came or
  went. `stop` never waits behind other commands, and a command whose sender
  gave up while it waited in line isn't run.
- **Uploads** set a file field's files directly, as picking them in its
  dialog would, and the page gets its usual `change` event. Paths are resolved
  by the client (the CLI, the terminal UI or the MCP server) against its own
  directory. A snapshot shows the chosen files' names as the field's value.
- **Frames from other sites** (a sign-in or payment form, a comment widget, a
  cookie banner) run in their own process, which the page's scripts can't
  reach. The session attaches to each one, reads it in medley's own isolated
  world there, and puts its content where the frame is, under an
  `── iframe "…" ──` divider, nested frames included. Every ref gets one
  number for the whole page (a page without such frames keeps its own
  numbering exactly). A click in a frame scrolls each enclosing frame into
  view, waits for the browser to draw, and adds up where each frame's content
  starts; typing clicks the field first, since keys go to the focused frame.
- **Extraction** (`src/extract.js`) runs inside the page and walks what's
  rendered, including open shadow roots and same-origin iframes.
  **Rendering** (`src/render.ts`) turns that into text. **Diffs**
  (`src/diff.ts`) use Myers' algorithm on lines.

`test/fixture.html` covers rendering edge cases; `test/app.html` covers
actions (menus, async form submit, `<select>`, alert, confirm, a covering
overlay, lazy loading, a hover menu, links to the same tab and a new tab, a
popup that closes itself, a multi-file field, a button whose page moves on by
itself a moment later, a download link, a password field, and a script that
tries to forge the ref table). `test/profile.html` counts its visits in the
browser profile, for checking that `--profile` keeps it.
`bun run test` runs every suite below, one after another (each is also its own
`bun run test:…`; they're scripts that drive a real browser, not `bun test` files).
`bun run test:script` checks, without a browser, that a recorded step reads back
as what was done, whatever was typed: line breaks, both kinds of quote, text
that looks like an option (`"--submit"`), a literal `${…}`, secrets, and the
Playwright test made from them.
`bun test/preview.ts <url> out.html [--mode advanced] [--width 150] [--rows 120]`
draws a page the way the terminal UI would, into an HTML file of colored
terminal cells, for looking at the grid modes without a terminal.
`bun run test:tui` drives the terminal UI through OpenTUI's test renderer
against a real session on `test/app.html`: keys, a field prompt, a simulated
agent acting in the same session, reload, a file prompt, the working badge,
a masked password prompt, a download, bookmarks and history, the refs list, find, a command,
a mouse click, back, a `confirm()`, a page that moves on by itself, the picture
viewer, page info, the source view, recording a script (the `● rec`
badge, the script's box), `:audit`, `:inspect`, `:expect`, the help overlay, and a search from the
address prompt. It prints each frame as it goes.
`bun run test:stability` checks medley's word when things go wrong, against
pages served for it: typing into comboboxes that won't take the focus or open
a search box, a page stuck in a script (a click on it returns, a wait says it
couldn't tell and checks don't pass, reload frees it), a page held up by a script that never
arrives, tabs opened and closed leaving no listeners behind, `stop` while a
command is stuck, a command whose sender gave up in line, and a failed replay
over MCP.
`bun run test:idle` starts a session that stops after 3 idle seconds and
checks that a command keeps it going and that it then stops by itself; then
that four commands run at once from four processes start one session between
them.
`bun run test:checks` checks `expect`, against a page served for it: text
there, gone and counted (in frames from this site and another), elements
counted by kind, the address and title, what fields hold (a password unseen),
states, the focus, errors logged and requests failed, and what comes a moment
later, each both passing and failing; then from the command line, recorded
into a script, replayed (with a wrong password too), as a Playwright test, and
asked for over MCP.
`bun run test:inspect` checks `inspect`, against a page served with its own
stylesheet and script: the selector, the name and where it comes from, the
box, each reason something can't be seen or clicked, the rules (their order,
files and lines, a media query, an invalid declaration, inherited ones) and
the listeners (on it, around it, inline ones), in a shadow root and in frames
from this site and another, a password kept out, then the picture from the
command line and over MCP.
`bun run test:dev` checks what developers lean on: `audit` against
`test/a11y.html` (one of each problem, beside the same things done right),
`expect`, recording the demo shop's form and replaying it in a fresh session,
a failing check, a password kept out of a script, the Playwright test,
`reload --diff`, and `watch`.
`bun run test:agent` checks what agents lean on, against `test/problems.html`
(a page that logs errors and asks for a file that isn't there) and
`test/data.html` (a table, results and menus): the notes after actions,
`console`, `network`, names for refs, `find`, `extract`, `--max`, and an
outline that leaves out a page's code (a snapshot shown as an example) and
link text that only looks like a ref.
`bun run test:frames` serves a page on 127.0.0.1 that embeds a form from
localhost (another site, so its own process), which embeds a widget from
127.0.0.1 again, and checks reading, typing, a checkbox, a select and clicks
in each, a frame below the fold, and that refs stay put. Then that a ref from
before its frame loaded another page is refused (after another client has
looked, when the old number means something else), that a notice over the
page stops clicks into frames under it (from another site and from this one),
that a frame from this site is read in like one from another, and that a
table's hidden rows and cells don't show.
`bun scripts/site-shots.ts <dir> [--as <url>] [--png <dir>]` drives the
terminal UI through the demo shop in `docs/demo/` and saves its frames as
HTML, and with `--png` as pictures too. The website's are made with
`bun scripts/site-shots.ts <dir> --as https://nam37.github.io/medley/demo/ --png docs/assets`.
`bun run image-compare [url] [--pictures 6]` compares ways of drawing pictures
in the terminal it runs in, side by side: the half blocks advanced grid drew
at first, OpenTUI's quadrant blocks, Sixel and Kitty graphics. It shows a test card
(`scripts/image-card.html`: gradients, fine text, thin lines, color), then the
page's window and its biggest pictures, and says what the terminal reported
supporting. Keys: ← → picture, 1-4 one technique alone, + − size, s a scroll
test that times the frames, f draw techniques the terminal didn't report.
`--check out.html` draws it into HTML instead, with a stand-in terminal.

## Known gaps

- A frame from another site inside a same-origin frame stays a placeholder
  (frames directly in the page, or inside other cross-site frames, are read).
  Advanced grid doesn't draw pictures inside frames, and `audit` checks the
  page itself, not what's inside its frames.
- Canvas and WebGL apps don't render as text; `screenshot` (MCP
  `browser_screenshot`, which returns the image) shows them.
- Some sites block headless Chrome; `--headed` may help.
- `--headed` hasn't been exercised yet.
- Advanced grid leaves out a CSS background taller than a window and a half
  (a section's or the whole page's backdrop, which would put everything over a
  picture) and pictures drawn by `::before` and `::after`. Elements
  fixed to the window (chat buttons, cookie bars) appear where they sat at the
  top of the page. Pictures inside tables aren't drawn, since a grid's rows
  don't follow the page's.
