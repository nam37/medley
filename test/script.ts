// Scripts read back what was recorded, exactly: each step written from a
// command (as the session records it) and parsed again (as replay does) gives
// the same command, whatever was typed. No browser needed.
//
//   bun test/script.ts

import { parseCommand, splitFlags, tokenize } from '../src/commands.ts';
import { parseScript, scriptVars, stepCommand, stepFor, toPlaywright } from '../src/script.ts';

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};

// The page the steps were recorded on, as snapshots label its refs.
const labels = new Map<number, string>([
  [1, '[1 textbox "Message"]'],
  [2, '[2 password "Password"]'],
  [3, '[3 button "Say \\"hi\\""]'],
  [4, '[4 textbox "Note"]'],
  [5, '[5 textbox "Card number"]'],
  [6, '[6 button "Add to cart"]'],
  [7, '[7 button "Add to cart"]'],
]);

/** A command recorded and read back: its line, and what replaying it runs. */
function roundTrip(cmd: string, args: Record<string, unknown>, vars: Record<string, string> = {}) {
  const step = stepFor({ cmd, args }, labels)!;
  const steps = parseScript(step.line);
  const back = steps.length === 1 ? stepCommand(steps[0], vars) : null;
  return { step, steps, back };
}

const typed = [
  'hello\nclick button Delete',
  '--submit',
  `He said "it's fine"`,
  '  spaces around  ',
  'tab\there, and a \\ backslash',
  'costs ${HOME} dollars',
  '',
];
for (const text of typed) {
  const { step, steps, back } = roundTrip('type', { ref: 1, text });
  check(`type ${JSON.stringify(text)}: one line, read back exactly`, steps.length === 1 && back?.args.text === text && !back?.args.submit, `${step.line}\n${JSON.stringify(back)}`);
}

let r = roundTrip('type', { ref: 1, text: 'hi', submit: true });
check('--submit, as an option, is still one', r.back?.args.submit === true && r.back?.args.text === 'hi', r.step.line);

r = roundTrip('type', { ref: 2, text: 'hunter2' }, { PASSWORD: 'p "w\nd' });
check('a password is ${PASSWORD}, filled in from the environment, exactly', r.step.line === 'type "password Password" ${PASSWORD}' && r.back?.args.text === 'p "w\nd', r.step.line);
check('which the script says it reads', scriptVars(r.steps).join() === 'PASSWORD');

r = roundTrip('type', { ref: 5, text: '4242 4242' });
check('a card number is kept out too', r.step.line.includes('${CARD_NUMBER}') && !r.step.line.includes('4242'), r.step.line);

r = roundTrip('fill', { fields: [{ ref: 2, value: 'secret' }, { ref: 4, value: 'a ${x} b\nc' }, { ref: 1, value: '--submit' }] }, { PASSWORD: 'pw' });
const fields = r.back?.args.fields as { ref: string; value: string }[] | undefined;
check('fill: a secret filled in, a literal ${x} and a line break kept, "--submit" as text',
  fields?.[0].value === 'pw' && fields?.[1].value === 'a ${x} b\nc' && fields?.[2].value === '--submit' && !r.back?.args.submit, `${r.step.line}\n${JSON.stringify(fields)}`);
check('a literal ${x} is not read from the environment', scriptVars(r.steps).join() === 'PASSWORD', scriptVars(r.steps).join());

r = roundTrip('click', { ref: 3 });
check('a name with quotes in it', r.back?.args.ref === 'button Say "hi"', r.step.line);

r = roundTrip('click', { ref: 6 });
check('a name two elements share is kept as the number, with a note', r.step.line === 'click 6' && !!r.step.note, `${r.step.line}\n${r.step.note}`);

r = roundTrip('expect', { text: 'Line one\nLine two' });
check('expect with a line break', r.back?.args.text === 'Line one\nLine two', r.step.line);

r = roundTrip('dialog', { action: 'accept', text: "It's \"quoted\"" });
check('a prompt answer with both quotes', r.back?.args.text === "It's \"quoted\"", r.step.line);

// Typed commands (the terminal UI's command line) follow the same rules.
const { words, flags } = splitFlags(tokenize(`type 4 "--submit"`));
check('a quoted "--submit" typed at the command line is text', parseCommand(words, flags).args.text === '--submit' && !flags.submit);

// The Playwright test reads secrets from the environment, and keeps literal text as it is.
const script = parseScript(
  [
    'goto https://example.com/',
    'type "password Password" ${PASSWORD}',
    `type "textbox Note" 'costs \${HOME}'`,
    `type "textbox Message" $'two\\nlines'`,
    'click button Sign in',
    'dialog accept "yes, please"',
  ].join('\n'),
);
const test = toPlaywright(script, 'signin.medley');
check('Playwright: ${PASSWORD} from the environment', test.includes(".fill((process.env.PASSWORD ?? ''));"), test);
check('Playwright: a literal ${HOME} stays text', test.includes('.fill("costs ${HOME}");'), test);
check('Playwright: a line break as \\n', test.includes('.fill("two\\nlines");'), test);
check("Playwright: a prompt's answer set up before the click", test.includes(`page.once('dialog', (dialog) => dialog.accept("yes, please"));`), test);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
