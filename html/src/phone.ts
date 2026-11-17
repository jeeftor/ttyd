import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style/phone.scss';

const root = document.createElement('main');
root.innerHTML = `<nav aria-label="Terminal tabs"><div id="tabs"></div><button id="new">＋</button><button id="menu">⋯</button></nav>
<div id="status" role="status">Connecting…</div><section id="screen"><div id="terminal"></div></section>
<section id="composer" hidden><label for="draft">Prompt draft</label><textarea id="draft" autocapitalize="off" spellcheck="false" placeholder="Compose or dictate a prompt…"></textarea><button id="insert">Insert into terminal</button><button id="dismiss">Hide draft</button></section>
<div id="keys"></div><div id="more" hidden></div>
<footer><button id="keyboard">Keyboard</button><button id="compose">Compose</button><button id="read">Read / copy</button><button id="extra">More keys</button></footer>
<dialog id="reader"><button id="read-close">Close</button><button id="copy">Copy all</button><button id="refresh">Refresh</button><pre id="output"></pre></dialog>`;
document.body.append(root);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => {
    element('status').textContent = text;
};
const term = new Terminal({
    fontSize: 14,
    fontFamily: 'TTYD Nerd Font, monospace',
    theme: { background: '#17191d' },
    scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(element('terminal'));
const path = location.pathname.replace(/\/+$/, '');
const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}/ws`;
const phone = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 768;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let management: WebSocket | undefined;
let terminal: WebSocket | undefined;
let token = '';
let active = '';
let busy = false;
let retry = 1000;
let stopped = false;
let draftId = '';
let cols = 80;
let rows = 24;
let wantedCols = 80;
let wantedRows = 24;
let lastResponse = Date.now();
let tabs: { id: string; name: string; active: boolean }[] = [];
const drafts = new Map<string, string>();
const draft = element<HTMLTextAreaElement>('draft');
const dialog = element<HTMLDialogElement>('reader');
let readId = '';
let flight: { op: string; fields: Record<string, unknown> } | undefined;
const queue: { op: string; fields: Record<string, unknown> }[] = [];
let activity = true;

function layout() {
    const viewport = window.visualViewport;
    root.style.height = `${viewport?.height ?? innerHeight}px`;
    root.style.top = `${viewport?.offsetTop ?? 0}px`;
    const screen = element('screen');
    const width = screen.clientWidth;
    const height = screen.clientHeight;
    // Measure fit independently of the shared grid rendered on this device.
    const container = element('terminal');
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    const size = fit.proposeDimensions();
    if (size) {
        wantedCols = Math.max(2, size.cols);
        wantedRows = Math.max(2, size.rows);
    }
    const cellWidth = width / Math.max(1, wantedCols);
    const cellHeight = height / Math.max(1, wantedRows);
    container.style.width = `${Math.max(width, cols * cellWidth)}px`;
    container.style.height = `${Math.max(height, rows * cellHeight)}px`;
}
function request(op: string, fields: Record<string, unknown> = {}) {
    if (management?.readyState !== WebSocket.OPEN) {
        status('Disconnected; your action was not sent.');
        return false;
    }
    if (busy) {
        if (op !== 'state' && queue.length < 20) {
            queue.push({ op, fields });
            return true;
        }
        return false;
    }
    flight = { op, fields };
    layout();
    management.send(
        JSON.stringify({
            op,
            phone: Number(phone),
            activity: Number(activity),
            cols: wantedCols,
            rows: wantedRows,
            ...fields,
        })
    );
    busy = true;
    activity = false;
    return true;
}
function send(data: string) {
    activity = true;
    if (terminal?.readyState !== WebSocket.OPEN) {
        status('Terminal disconnected; input was not sent.');
        return;
    }
    terminal.send(encoder.encode(`0${data}`));
}
function dimensions() {
    term.resize(cols, rows);
    if (terminal?.readyState === WebSocket.OPEN)
        terminal.send(encoder.encode(`1${JSON.stringify({ columns: cols, rows })}`));
    layout();
}
function connectTerminal() {
    if (terminal || !tabs.length || stopped) return;
    const socket = new WebSocket(url, ['tty']);
    terminal = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
        term.reset();
        socket.send(encoder.encode(JSON.stringify({ AuthToken: token, columns: cols, rows })));
    };
    socket.onmessage = event => {
        const bytes = new Uint8Array(event.data);
        if (bytes[0] === 48) term.write(bytes.subarray(1));
    };
    socket.onclose = () => {
        if (terminal === socket) terminal = undefined;
    };
}
function updateTabs() {
    const strip = element('tabs');
    strip.replaceChildren();
    for (const tab of tabs) {
        const button = document.createElement('button');
        button.textContent = tab.name;
        button.ariaPressed = String(tab.active);
        button.onclick = () => request('select', { id: tab.id });
        strip.append(button);
    }
    active = tabs.find(tab => tab.active)?.id ?? '';
}
async function connect() {
    if (stopped) return;
    try {
        const response = await fetch(`${path}/token`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Sign in through your access gateway, then reload.');
        token = (await response.json()).token;
        const socket = new WebSocket(url, ['tty']);
        management = socket;
        socket.onopen = () => {
            socket.send(encoder.encode(JSON.stringify({ AuthToken: token, manage: true })));
            busy = false;
            lastResponse = Date.now();
            request('state');
        };
        socket.onmessage = event => {
            const state = JSON.parse(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
            busy = false;
            lastResponse = Date.now();
            retry = 1000;
            tabs = state.tabs;
            cols = state.cols;
            rows = state.rows;
            updateTabs();
            dimensions();
            connectTerminal();
            status(
                state.error ||
                    (tabs.length
                        ? `${cols} × ${rows} · ${phone ? 'Phone' : 'Shared workspace'}`
                        : 'No terminals. Tap ＋ to open a shell.')
            );
            if (flight?.op === 'insert' && !state.error) {
                const id = String(flight.fields.id);
                if (drafts.get(id) === flight.fields.text) drafts.delete(id);
                if (draftId === id && draft.value === flight.fields.text) draft.value = '';
            }
            flight = undefined;
            const next = queue.shift();
            if (next) request(next.op, next.fields);
            if (state.text !== undefined) element('output').textContent = state.text;
        };
        socket.onclose = () => {
            busy = false;
            management = undefined;
            terminal?.close();
            terminal = undefined;
            flight = undefined;
            queue.length = 0;
            status('Disconnected. Reconnecting; unsent drafts are preserved.');
            setTimeout(connect, retry);
            retry = Math.min(15000, retry * 2);
        };
    } catch (error) {
        status(String(error));
        setTimeout(connect, retry);
        retry = Math.min(15000, retry * 2);
    }
}
root.addEventListener('pointerdown', () => {
    activity = true;
});
term.onData(send);
term.onBinary(data => {
    if (terminal?.readyState === WebSocket.OPEN) terminal.send(Uint8Array.from(`0${data}`, char => char.charCodeAt(0)));
});
function key(label: string, sequence: string | (() => string), parent = 'keys') {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.onclick = () => {
        send(typeof sequence === 'function' ? sequence() : sequence);
        term.focus();
    };
    element(parent).append(button);
}
key('Esc', '\x1b');
key('Tab', '\t');
key('⇧Tab', '\x1b[Z');
key('Ctrl+C', '\x03');
for (const [label, code] of [
    ['↑', 'A'],
    ['↓', 'B'],
    ['←', 'D'],
    ['→', 'C'],
])
    key(label, () => `\x1b${term.modes.applicationCursorKeysMode ? 'O' : '['}${code}`);
key('Enter', '\r');
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    key(`Ctrl+${letter}`, String.fromCharCode(letter.charCodeAt(0) - 64), 'more');
for (const [label, code] of [
    ['Alt+Enter', '\x1b\r'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['Page Up', '\x1b[5~'],
    ['Page Down', '\x1b[6~'],
])
    key(label, code, 'more');
element('keyboard').onclick = () => term.focus();
element('extra').onclick = () => {
    element('more').hidden = !element('more').hidden;
    layout();
};
element('new').onclick = () => request('create');
element('menu').onclick = () => {
    const id = active;
    if (!id) return;
    const name = prompt('Rename terminal (leave empty to close it):', tabs.find(tab => tab.id === id)?.name);
    if (name === null) return;
    if (name.trim()) request('rename', { id, name: name.trim() });
    else if (confirm('Close this terminal and terminate its running processes?')) request('close', { id });
};
element('compose').onclick = () => {
    if (!active) return;
    draftId = active;
    draft.value = drafts.get(draftId) ?? '';
    element('composer').hidden = false;
    layout();
    draft.focus();
};
draft.oninput = () => drafts.set(draftId, draft.value);
element('dismiss').onclick = () => {
    element('composer').hidden = true;
    layout();
};
element('insert').onclick = () => {
    if (draft.value) request('insert', { id: draftId, text: draft.value });
};
element('read').onclick = () => {
    if (!active) return;
    readId = active;
    element('output').textContent = 'Loading…';
    dialog.showModal();
    request('capture', { id: readId });
};
element('refresh').onclick = () => request('capture', { id: readId });
element('read-close').onclick = () => dialog.close();
element('copy').onclick = async () => {
    try {
        await navigator.clipboard.writeText(element('output').textContent ?? '');
        status('Copied.');
    } catch {
        status('Select text in the reader and use the browser Copy command.');
    }
};
window.visualViewport?.addEventListener('resize', layout);
window.visualViewport?.addEventListener('scroll', layout);
window.addEventListener('resize', layout);
window.addEventListener('pagehide', () => {
    stopped = true;
    management?.close();
    terminal?.close();
});
window.addEventListener('pageshow', event => {
    if (event.persisted) {
        stopped = false;
        void connect();
    }
});
setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastResponse > 45000) management?.close();
    else if (!busy && management?.readyState === WebSocket.OPEN) request('state');
}, 2000);
void document.fonts.load('14px "TTYD Nerd Font"').then(layout);
layout();
void connect();
