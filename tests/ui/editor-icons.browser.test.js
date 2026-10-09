'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

let chromium, requireJs;
try {
    chromium = require('playwright').chromium;
    requireJs = require.resolve('requirejs/require.js');
} catch (_) { /* Optional browser dependencies. */ }
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const skip = !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false;
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/icons.css">
<style>body{font:12px Arial,sans-serif;color:#363636;background:white;margin:20px}h1{font-size:18px;font-weight:400;margin:0 0 18px}h2{font-size:14px;font-weight:400;margin:12px 0 8px}.sheet{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 16px}.sample{display:flex;align-items:center;gap:8px;min-height:24px;padding:4px;border:1px solid #eee}.sample:nth-child(odd){background:#f5f5f5}.sample span:last-child{min-width:0}section{margin-bottom:20px}</style>
</head><body><h1>GPUI — semantic icon catalog · 16px</h1><main></main>
<script src="/require.js"></script><script>
require.config({baseUrl:'/js'});
require(['components/editor-icons','components/templates/preference/targeting-presentations'],(icons,presentation)=>{
 function add(title,entries){const section=document.createElement('section');const heading=document.createElement('h2');heading.textContent=title;section.append(heading);const sheet=document.createElement('div');sheet.className='sheet';section.append(sheet);for(const entry of entries){const row=document.createElement('div');row.className='sample';const icon=document.createElement('span');icon.className=entry[1];icon.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent=entry[0];row.append(icon,label);sheet.append(row)}document.querySelector('main').append(section)}
 add('Preferences — 22 supported families',icons.preferenceKinds.map(kind=>[kind.replaceAll('_',' '),icons.preference(kind)]));
 add('Item-Level Targeting — 29 supported kinds',icons.targetingKinds.map(kind=>[presentation.kindLabel(kind,kind,'en'),icons.targeting(kind)]));
 add('Categories and Scripts',[
 ['Preferences',icons.preferencesRoot()],['System Settings',icons.preferenceCategory('system_settings')],['Component Settings',icons.preferenceCategory('control_panel_settings')],['Other Settings',icons.preferenceCategory('other_settings')],
 ['Scripts',icons.scripts()],['Startup',icons.scriptEvent('startup')],['Shutdown',icons.scriptEvent('shutdown')],['Logon',icons.scriptEvent('logon')],['Logoff',icons.scriptEvent('logoff')],['Script file',icons.scriptFile('classic')],['PowerShell file',icons.scriptFile('powershell')],['Unknown vendor filter',icons.targeting(null)]]);
 window.ready=true;
});
</script></body></html>`;

test('every semantic SVG loads at 16px without missing requests and keeps labels separate', { skip }, async () => {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.statusCode = 404; return response.end('Not found'); }
        response.setHeader('Content-Type', filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.css') ? 'text/css' : 'application/javascript');
        response.end(fs.readFileSync(filename));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage({ viewport: { width: 1080, height: 960 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        const rendered = await page.evaluate(async () => {
            const nodes = Array.from(document.querySelectorAll('.gpo-icon'));
            return Promise.all(nodes.map(async node => {
                const style = getComputedStyle(node);
                const url = style.backgroundImage.match(/url\("?(.+?)"?\)/);
                if (!url) return { missing: node.className };
                const image = new Image(); image.src = url[1]; await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
                const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                const data = context.getImageData(0, 0, 16, 16).data;
                let ink = 0;
                for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 80 && data[i] < 210) ink++;
                return { width: style.width, height: style.height, naturalWidth: image.naturalWidth,
                    naturalHeight: image.naturalHeight, ariaHidden: node.getAttribute('aria-hidden'), ink };
            }));
        });
        assert.equal(rendered.length, 63);
        for (const icon of rendered) {
            assert.equal(icon.width, '16px'); assert.equal(icon.height, '16px');
            assert.equal(icon.naturalWidth, 16); assert.equal(icon.naturalHeight, 16);
            assert.equal(icon.ariaHidden, 'true'); assert.ok(icon.ink >= 20, 'Icon should paint a discernible silhouette');
        }
        assert.deepEqual(errors, []);
        if (process.env.ICON_CATALOG_SCREENSHOT) await page.screenshot({ path: process.env.ICON_CATALOG_SCREENSHOT, fullPage: true });
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
