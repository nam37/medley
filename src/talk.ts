// The conversation between an agent and the person watching it in the
// terminal UI, kept by the session's daemon. The person sends notes, which the
// agent gets with the result of its next step; the agent asks questions, which
// wait for an answer, and tells the person what it's doing. None of it waits
// behind browser commands.

/** What's said, announced on /events for the terminal UI (see SessionEvent). */
export interface TalkEvent {
  kind: 'note' | 'read' | 'question' | 'answered' | 'withdrawn' | 'message';
  id: number;
  text: string; // the note, the question, the answer, or the message
  choices?: string[];
  about?: string; // what a note points at (the ref selected when it was sent)
}

interface Question {
  id: number;
  text: string;
  choices?: string[];
  waiting: Set<(answer: string) => void>; // ask calls waiting for the answer
}

const MAX_WAIT_S = 170; // clients give up on a request after 180 seconds

export class Talk {
  private next = 1;
  private unread: { id: number; line: string }[] = []; // for the agent's next step
  private question: Question | null = null;

  constructor(
    private announce: (e: TalkEvent) => void,
    private watching: () => boolean, // whether anyone follows the session in the terminal UI
  ) {}

  /** The person sends the agent a note, maybe pointing at something on the page. */
  note(text: string, about?: string): string {
    const clean = text.trim();
    if (!clean) throw new Error('there is nothing to send');
    const id = this.next++;
    this.unread.push({ id, line: `says: "${clean}"${about ? ` (pointing at ${about})` : ''}` });
    this.announce({ kind: 'note', id, text: clean, about });
    return 'sent; the agent gets it with its next step';
  }

  /**
   * Notes and late answers the agent hasn't seen, taken for the result of its
   * step: one line each ("says: …"). The terminal UI hears they were read.
   */
  take(): string[] {
    if (!this.unread.length) return [];
    const taken = this.unread;
    this.unread = [];
    for (const t of taken) this.announce({ kind: 'read', id: t.id, text: '' });
    return taken.map((t) => t.line);
  }

  /**
   * The agent asks the person something and waits up to `seconds` for the
   * answer. Asking the question that's already up waits for it again; a new
   * one replaces it.
   */
  async ask(text: string, choices: string[] = [], seconds = 120): Promise<string> {
    const clean = text.trim();
    if (!clean) throw new Error('ask needs a question');
    if (!this.watching()) {
      return "no one is watching this session in medley's terminal UI, so no one can answer; ask in your own conversation instead";
    }
    let q = this.question;
    if (!q || q.text !== clean) {
      if (q) this.announce({ kind: 'withdrawn', id: q.id, text: q.text });
      q = { id: this.next++, text: clean, choices: choices.length ? choices : undefined, waiting: new Set() };
      this.question = q;
      this.announce({ kind: 'question', id: q.id, text: clean, choices: q.choices });
    }
    const wait = Math.min(Math.max(1, seconds), MAX_WAIT_S);
    const answer = await new Promise<string | null>((resolve) => {
      const done = (a: string | null) => {
        clearTimeout(timer);
        q!.waiting.delete(got);
        resolve(a);
      };
      const got = (a: string) => done(a);
      const timer = setTimeout(() => done(null), wait * 1000);
      q!.waiting.add(got);
    });
    if (answer !== null) return `your user answered: "${answer}"`;
    return `no answer yet after ${wait} s; the question is still showing in the terminal UI. Ask the same question again to keep waiting, or carry on: an answer that comes later arrives with your next step.`;
  }

  /** The person answers the question that's up (by its id, so a stale answer can't land on a new question). */
  answer(id: number, text: string): string {
    const q = this.question;
    if (!q || q.id !== id) throw new Error('that question is no longer asked');
    const clean = text.trim();
    this.question = null;
    this.announce({ kind: 'answered', id, text: clean });
    if (q.waiting.size) for (const got of [...q.waiting]) got(clean);
    else this.unread.push({ id, line: `answered your question "${q.text}": "${clean}"` });
    return 'answered';
  }

  /** The agent tells the person something, without waiting. */
  tell(text: string): string {
    const clean = text.trim();
    if (!clean) throw new Error('tell needs a message');
    if (!this.watching()) return "no one is watching this session in medley's terminal UI";
    this.announce({ kind: 'message', id: this.next++, text: clean });
    return 'shown to your user';
  }

  /** The question that's up, for a terminal UI that starts watching after it was asked. */
  get asking(): TalkEvent | null {
    const q = this.question;
    return q ? { kind: 'question', id: q.id, text: q.text, choices: q.choices } : null;
  }
}
