const {chromium, webkit} = require('playwright');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const fs = require('node:fs/promises');
const socket = `ttyp-browser-${process.pid}`;
const port = 17864;
const server = spawn(process.env.TTYP_BINARY || './build-phone/ttyp', ['-i','127.0.0.1','-p',String(port),'--tmux-socket',socket],{stdio:'ignore'});
let browser;
(async()=>{
    for(let i=0;i<100;i++) {try {if((await fetch(`http://127.0.0.1:${port}/token`)).ok)break;}catch{} await delay(100);}
    const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
    browser = await engine.launch({headless:true, ...(process.env.CHROME_HEADLESS_SHELL ? {executablePath:process.env.CHROME_HEADLESS_SHELL}: {})});
    const context = await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true});
    const phone = await context.newPage();
    const errors=[];phone.on('pageerror',error=>errors.push(error.message));
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('#tabs button').first().waitFor();
    await phone.locator('#compose').click();
    await phone.locator('#draft').fill('echo phone-browser-check');
    await phone.locator('#insert').click();
    await phone.waitForFunction(()=>document.querySelector('#draft').value==='');
    await phone.locator('#dismiss').click();
    await phone.getByRole('button',{name:'Enter',exact:true}).click();
    await phone.locator('#read').click();
    await phone.waitForFunction(()=>document.querySelector('#output').textContent.includes('phone-browser-check'));
    await phone.locator('#read-close').click();
    await phone.locator('#new').click();
    await phone.waitForFunction(()=>document.querySelectorAll('#tabs button').length===2);
    const desktop=await browser.newPage({viewport:{width:1280,height:800}});
    await desktop.goto(`http://127.0.0.1:${port}/`);
    await desktop.locator('#tabs button').first().waitFor();
    await desktop.locator('#tabs button').first().click();
    await phone.waitForFunction(()=>document.querySelector('#tabs button').getAttribute('aria-pressed')==='true');
    const phoneGrid = (await phone.locator('#status').textContent()).split(' · ')[0];
    await desktop.waitForFunction(grid=>document.querySelector('#status').textContent.startsWith(grid),phoneGrid);
    await phone.setViewportSize({width:390,height:420});
    await delay(2500);
    const bounds=await phone.locator('footer').boundingBox(); assert.ok(bounds.y+bounds.height<=421);
    await fs.mkdir('output/playwright',{recursive:true});
    await phone.screenshot({path:'output/playwright/ttyp-phone.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: phone compose/submit/read, create tabs, desktop mirroring, phone dimensions, reduced viewport');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await browser?.close();server.kill('SIGTERM');
    try{execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore'});}catch{}
});
