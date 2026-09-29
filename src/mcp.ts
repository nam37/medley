// MCP server on stdio. Each tool forwards to the session daemon, so an agent
// and a person at a terminal (`medley snapshot`) share one browser.

import { createInterface } from 'node:readline';
import { send, type StartOptions } from './client.ts';

const REF = { type: 'integer', description: 'The number of an element in the latest snapshot' };

const INSTRUCTIONS = `Medley is a text-mode web browser. Pages come back as text: headings (#),
lists, tables, and "── nav ──"-style dividers for page regions. Every interactive
element has a number, its ref: [7]Docs is a link, [8 button "Save"] or
[9 textbox "Email" = "ada@example.com" focused] are other controls. Pass the number
as \`ref\` to act on it. After an action you get only what changed, as diff hunks
("- " old line, "+ " new line) under the region they belong to; a new page comes
back in full. Refs stay valid until the page navigates.`;

interface Tool {
  name: string;
  cmd: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: Tool[] = [
  {
    name: 'browser_goto',
    cmd: 'goto',
    description: 'Open a URL (starting the browser if needed) and return the page as text.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    cmd: 'snapshot',
    description: 'Return the current page as text. With diff=true, return only what changed since you last looked.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'boolean', description: 'Only show changes since your last snapshot or action' },
        links: { type: 'boolean', description: 'Also list every link target' },
      },
    },
  },
  {
    name: 'browser_click',
    cmd: 'click',
    description: 'Click an element. Fails with an explanation if something (a banner, a modal) covers it.',
    inputSchema: { type: 'object', properties: { ref: REF }, required: ['ref'] },
  },
  {
    name: 'browser_type',
    cmd: 'type',
    description: "Replace a text field's content with `text`. With submit=true, press Enter afterwards.",
    inputSchema: {
      type: 'object',
      properties: { ref: REF, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select',
    cmd: 'select',
    description: 'Choose an option of a select element by its visible text or value.',
    inputSchema: { type: 'object', properties: { ref: REF, option: { type: 'string' } }, required: ['ref', 'option'] },
  },
  {
    name: 'browser_press',
    cmd: 'press',
    description: 'Press a key in the focused element: Enter, Escape, Tab, ArrowDown, PageDown, a character, or a combination like Control+a.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'browser_scroll',
    cmd: 'scroll',
    description: 'Scroll the page to load more content: "down", "up", "top", "bottom", or a ref number to bring into view.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
  },
  {
    name: 'browser_hover',
    cmd: 'hover',
    description: 'Move the mouse over an element, for menus and details that only appear on hover.',
    inputSchema: { type: 'object', properties: { ref: REF }, required: ['ref'] },
  },
  {
    name: 'browser_tabs',
    cmd: 'tabs',
    description: 'List the open tabs (a link or script can open a new one; the result of that action says so).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_switch_tab',
    cmd: 'tab',
    description: 'Switch to a tab by its number in browser_tabs, and return its page.',
    inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
  },
  {
    name: 'browser_close_tab',
    cmd: 'close-tab',
    description: 'Close a tab by its number (the current one if omitted).',
    inputSchema: { type: 'object', properties: { n: { type: 'integer' } } },
  },
  {
    name: 'browser_back',
    cmd: 'back',
    description: 'Go back to the previous page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_forward',
    cmd: 'forward',
    description: 'Go forward again after going back.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_wait',
    cmd: 'wait',
    description: 'Wait for the page to do something on its own (default 2 seconds, at most 60), then return what changed.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } },
  },
  {
    name: 'browser_dialog',
    cmd: 'dialog',
    description: 'Answer a confirm() or prompt() dialog the page opened: accept (optionally with text for a prompt) or dismiss.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, text: { type: 'string' } },
      required: ['action'],
    },
  },
];

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export async function serveMcp(sessionName: string, start: StartOptions) {
  const client = `mcp-${process.pid}`;
  const write = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

  async function handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'medley', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) throw new RpcError(-32602, `unknown tool: ${params?.name}`);
        try {
          const command = { cmd: tool.cmd, args: params.arguments ?? {}, client };
          const text = await send(sessionName, command, tool.cmd === 'goto' ? start : undefined);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          const message = (e as Error).message.startsWith('no browser session')
            ? 'no page is open yet; call browser_goto first'
            : (e as Error).message;
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let msg: { id?: string | number; method: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (msg.id === undefined) continue; // a notification; nothing to answer
    handle(msg.method, msg.params).then(
      (result) => write({ id: msg.id, result }),
      (e) => write({ id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e.message } }),
    );
  }
}
