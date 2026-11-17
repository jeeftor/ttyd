// Real server + tmux integration. Uses a disposable, uniquely named tmux server.
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');
const WebSocket = require('ws');
const binary = process.env.TTYP_BINARY || './build-phone/ttyp';
const socketName = `ttyp-test-${process.pid}`;
const port = 17862;
let server;
const sockets = [];
function start() {
    server = spawn(binary, ['-i', '127.0.0.1', '-p', String(port), '--tmux-socket', socketName], {stdio: ['ignore', 'ignore', 'pipe']});
    server.stderr.on('data', data => { if(process.env.DEBUG) process.stderr.write(data); });
}
async function ready() {
    for(let i=0; i<100; i++) {
        try {const r = await fetch(`http://127.0.0.1:${port}/token`); if(r.ok)return;} catch {}
        await delay(100);
    }
    throw Error('Server did not start');
}
async function manage(phone, cols, rows) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, 'tty', {origin: `http://127.0.0.1:${port}`});
    sockets.push(ws); await once(ws, 'open');
    ws.send(Buffer.from(JSON.stringify({AuthToken:'', manage:true})));
    return async (op, fields={}) => {
        const response = once(ws, 'message');
        ws.send(JSON.stringify({op, phone, cols, rows, ...fields}));
        const [data] = await Promise.race([response, delay(15000).then(()=>{throw Error(`Timeout: ${op}`);})]);
        return JSON.parse(data);
    };
}
(async()=>{
    start(); await ready();
    const forbidden = new WebSocket(`ws://127.0.0.1:${port}/ws`, 'tty', {origin:'https://untrusted.example'});
    const denied = await new Promise(resolve => { forbidden.on('unexpected-response', (_,response)=>{resolve(response.statusCode);response.destroy();}); forbidden.on('error',()=>resolve(403)); });
    assert.notEqual(denied,101);
    const phone = await manage(1, 42, 20);
    let state = await phone('state'); assert.equal(state.tabs.length,1);
    const first = state.tabs[0].id;
    const desktop = await manage(0, 120, 40);
    state = await desktop('state'); assert.equal(state.cols,42); assert.equal(state.rows,20);
    state = await phone('create'); assert.equal(state.tabs.length,2);
    const second = state.tabs.find(t=>t.id!==first).id;
    await phone('rename', {id: second, name:'Devin test'});
    await phone('select', {id:first});
    state = await desktop('state'); assert.equal(state.tabs.find(t=>t.active).id,first);
    state = await phone('insert', {id:second,text:'echo TTYP_DRAFT'}); assert.ok(!state.error);
    state = await phone('capture', {id:second}); assert.match(state.text,/TTYP_DRAFT/);
    state = await phone('capture', {id:first}); assert.doesNotMatch(state.text,/TTYP_DRAFT/);
    state = await phone('close', {id:'@999999'}); assert.ok(state.error);
    for(const ws of sockets)ws.close(); await delay(200);
    server.kill('SIGTERM'); await once(server,'exit');
    start(); await ready();
    const resumed = await manage(0,100,30);
    state = await resumed('state'); assert.equal(state.tabs.length,2);
    assert.ok(state.tabs.some(t=>t.name==='Devin test'));
    await resumed('close',{id:first}); state=await resumed('close',{id:second}); assert.equal(state.tabs.length,0);
    state=await resumed('create'); assert.equal(state.tabs.length,1);
    console.log('PASS: tabs, mirrored selection, targeted paste, phone sizing, restart persistence, empty workspace');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    for(const ws of sockets)ws.terminate();
    server?.kill('SIGTERM');
    try {execFileSync('tmux',['-L',socketName,'kill-server'],{stdio:'ignore'});}catch{}
});
