const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const distDir = path.resolve(process.cwd(), 'dist');

const server = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url, 'http://localhost').pathname;
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    const filePath = path.resolve(distDir, relativePath);

    if (!filePath.startsWith(`${distDir}${path.sep}`)) {
        response.writeHead(403).end();
        return;
    }

    try {
        const content = await fs.readFile(filePath);
        const contentType = filePath.endsWith('.css')
            ? 'text/css'
            : filePath.endsWith('.js')
              ? 'text/javascript'
              : 'text/html';
        response.writeHead(200, {'content-type': contentType}).end(content);
    } catch {
        response.writeHead(404).end();
    }
});

server.listen(0, '127.0.0.1');

async function checkFont() {
    await new Promise(resolve => server.once('listening', resolve));
    const {port} = server.address();
    const browser = await chromium.launch();

    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}`, {waitUntil: 'domcontentloaded'});
        const result = await page.evaluate(async () => {
            const font = '13px "TTYD Nerd Font"';
            await document.fonts.load(font);

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = font;
            return {
                loaded: document.fonts.check(font),
                nerdWidth: context.measureText('\ue0b0').width,
                monospaceWidth: context.measureText('M').width,
            };
        });

        if (!result.loaded) throw new Error('TTYD Nerd Font did not load');
        if (Math.abs(result.nerdWidth - result.monospaceWidth) > 0.01) {
            throw new Error(`Nerd Font glyph width ${result.nerdWidth} differs from monospace width ${result.monospaceWidth}`);
        }
    } finally {
        await browser.close();
        server.close();
    }
}

checkFont().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
