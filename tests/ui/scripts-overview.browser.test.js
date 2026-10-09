'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

let chromium;
let requireJs;
try {
    chromium = require('playwright').chromium;
    requireJs = require.resolve('requirejs/require.js');
} catch (_) { /* Browser dependencies are optional in unit-only environments. */ }

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636}.gp__container{height:100vh}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace"></main></div>
<script src="/require.js"></script><script>
function asset(name, references) {
 return {name,byte_size:3,revision:'r1',references:references||[]};
}
function view(event, entry, files) {
 return {event,execution_order:'unspecified',upload_limit_bytes:16777216,
  classic:{snapshot:event+'-classic',editable:true,entries:entry?[{
   identity:event+'-entry',command_line:entry,parameters:'',kind:'managed_asset',managed_asset_name:entry
  }]:[]},
  powershell:{snapshot:event+'-powershell',editable:true,entries:[]},assets:files};
}
window.views={
 computer:{
  startup:view('startup','startup.cmd',[
   asset('startup.cmd',[{event:'startup',executable_group:'classic',index:0}]),
   asset('loose.cmd'),asset('spare.cmd')]),
  shutdown:view('shutdown','shutdown.cmd',[
   asset('shutdown.cmd',[{event:'shutdown',executable_group:'classic',index:0}]),
   asset('extra.cmd')])
 },
 user:{
  logon:view('logon','user.cmd',[
   asset('user.cmd',[{event:'logon',executable_group:'classic',index:0}])]),
  logoff:view('logoff',null,[])
 }
};
window.calls=[];
function response(scope,event) {
 const scripts=structuredClone(views[scope][event]);
 scripts.scope=scope;return {scripts};
}
function change(method,scope,event,request,update) {
 calls.push({method,scope,event,request:structuredClone(request)});
 update(views[scope][event]);return Promise.resolve(response(scope,event));
}
define('util/API',[],()=>({
 scriptsShow:async(scope,event)=>{
  calls.push({method:'show',scope,event});return response(scope,event);
 },
 scriptEntryAdd:(scope,event,request)=>change('add',scope,event,request,scripts=>{
  scripts[request.executable_group].entries.push({identity:'added-'+calls.length,
   command_line:request.name,parameters:request.parameters,kind:'managed_asset',
   managed_asset_name:request.name});
  scripts.assets.find(file=>file.name===request.name).references.push({
   event,executable_group:request.executable_group,index:0});
 }),
 scriptAssetUpload:(scope,event,request)=>change('upload',scope,event,request,scripts=>{
  scripts.assets.push({name:request.name,byte_size:atob(request.content_base64).length,
   revision:'r2',references:[]});
 }),
 scriptAssetDelete:(scope,event,request)=>change('delete',scope,event,request,scripts=>{
  scripts.assets=scripts.assets.filter(file=>file.name!==request.name);
 }),
 scriptAssetDownload:async(scope,event,request)=>{
  calls.push({method:'download',scope,event,request:structuredClone(request)});
  return {asset:{name:request.name,revision:request.revision,byte_size:3,
   content_base64:'YWJj'}};
 }
}));
require.config({baseUrl:'/js'});
require(['components/templates/script-template','components/header/header','locales/translations'],
 (template,headerModule,translations)=>{
  translations.setLanguage('en');
  window.setLanguage=translations.setLanguage;
  window.header=headerModule.renderHeader(document.getElementById('header'));
  window.render=scope=>{
   if(window.currentView)window.currentView.cleanup();
   window.currentView=template.renderScriptsTemplate({item:{scope},header:window.header,
    isCurrent:()=>true});
   document.getElementById('workspace').replaceChildren(currentView.getElement());
  };
  render('computer');window.ready=true;
 });
</script></body></html>`;

test('Scripts overview opens event details and manages files in the selected SYSVOL folder', {
    skip: !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false
}, async () => {
    const server = http.createServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            return response.end(html);
        }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : 'application/javascript');
            response.end(fs.readFileSync(filename));
        } catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready &&
            [...document.querySelectorAll('.gpo-editor-scripts__event-table tbody tr')]
                .every(row => !row.textContent.includes('—')), null, { timeout: 10000 }).catch(error => {
            throw new Error(error.message + '; browser errors: ' + errors.join('; '));
        });

        const rows = page.locator('.gpo-editor-scripts__event-table tbody tr');
        assert.equal(await rows.count(), 2);
        assert.deepEqual(await rows.allTextContents(), ['Startup scripts10', 'Shutdown scripts10']);
        assert.equal(await page.getByRole('button', { name: 'Open scripts folder…' }).isVisible(), true);

        await rows.filter({ hasText: 'Shutdown scripts' }).dblclick({ timeout: 5000 }).catch(async error => {
            const bounds = await page.evaluate(() => Object.fromEntries([
                '.gp__container', '#workspace', '.gpo-editor-scripts',
                '.gpo-editor-scripts__title', '.gpo-editor-scripts__overview',
                '.gpo-editor-scripts__event-table',
                '.gpo-editor-scripts__event-table tbody tr:last-child'
            ].map(selector => {
                const element = document.querySelector(selector);
                const rect = element.getBoundingClientRect();
                return [selector, { x: rect.x, y: rect.y, width: rect.width,
                    height: rect.height, display: getComputedStyle(element).display }];
            })));
            throw new Error(error.message + '; bounds: ' + JSON.stringify(bounds));
        });
        const eventDialog = page.getByRole('dialog', { name: 'Shutdown scripts', exact: true });
        await eventDialog.waitFor();
        await eventDialog.locator('.gpo-editor-scripts__entries tbody tr').filter({ hasText: 'shutdown.cmd' }).waitFor();
        const eventBounds = await eventDialog.boundingBox();
        const entryListBounds = await eventDialog.locator('.gpo-editor-scripts__entries .gpo-editor-scripts__list')
            .boundingBox();
        const entryActionsBounds = await eventDialog.locator('.gpo-editor-scripts__entries .gpo-editor-scripts__toolbar')
            .boundingBox();
        const showFilesBounds = await eventDialog.getByRole('button', { name: 'Show files…' }).boundingBox();
        const eventFooterBounds = await eventDialog.locator('.preference__modal-footer').boundingBox();
        assert.ok(eventBounds.width <= 660 && eventBounds.height <= 480);
        assert.ok(entryActionsBounds.x >= entryListBounds.x + entryListBounds.width - 2);
        assert.ok(Math.abs(entryActionsBounds.y - entryListBounds.y) <= 12);
        assert.ok(eventFooterBounds.y - (showFilesBounds.y + showFilesBounds.height) <= 26);
        assert.equal(await eventDialog.locator('.gpo-editor-scripts__assets').count(), 0);
        assert.equal(await eventDialog.getByRole('button', { name: 'Show files…' }).isVisible(), true);
        assert.equal(await eventDialog.locator('input[type=file]:visible').count(), 0);
        await eventDialog.getByRole('button', { name: 'Add', exact: true }).click();
        const form = eventDialog.locator('.gpo-editor-scripts__form');
        await form.waitFor();
        const scriptName = form.locator('.gpo-editor-scripts__asset-field input[type=text]');
        assert.equal(await scriptName.count(), 1);
        assert.equal(await scriptName.getAttribute('readonly'), null);
        await scriptName.fill('manual.cmd');
        await form.getByRole('button', { name: 'Select a file from SYSVOL' }).click();
        const picker = eventDialog.locator('.gpo-editor-scripts__picker');
        await picker.waitFor();
        assert.deepEqual(await picker.locator('tbody tr td:first-child').allTextContents(),
            ['shutdown.cmd', 'extra.cmd']);
        await picker.locator('tbody tr').filter({ hasText: 'extra.cmd' }).click();
        await picker.getByRole('button', { name: 'Select file' }).click();
        assert.equal(await scriptName.inputValue(), 'extra.cmd');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'add'));
        assert.deepEqual(await page.evaluate(() => {
            const call = calls.find(item => item.method === 'add');
            return [call.scope, call.event, call.request.mode, call.request.name];
        }), ['computer', 'shutdown', 'existing_asset', 'extra.cmd']);
        await eventDialog.locator('.gpo-editor-scripts__order select').selectOption('powershell_first');
        await eventDialog.getByRole('button', { name: 'Show files…' }).click();
        const discardConfirmation = page.getByRole('alertdialog');
        await discardConfirmation.waitFor();
        assert.equal(await page.getByRole('dialog', { name: 'Files: Shutdown scripts' }).count(), 0);
        await discardConfirmation.getByRole('button', { name: 'Yes' }).click();
        await eventDialog.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => calls.some(call => call.method === 'order')), false);
        const explorer = page.getByRole('dialog', { name: 'Files: Shutdown scripts' });
        await explorer.waitFor();
        await explorer.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'shutdown.cmd' }).waitFor();
        assert.equal(await explorer.getByRole('combobox', { name: 'Event' }).count(), 0);
        assert.equal(await explorer.locator('input[type=file]:visible').count(), 0);
        assert.deepEqual(await explorer.locator('.gpo-editor-scripts__assets tbody tr td:nth-child(2)').allTextContents(),
            ['shutdown.cmd', 'extra.cmd']);
        await explorer.locator('.preference__modal-footer > .btn-cancel').click();
        await explorer.waitFor({ state: 'hidden' });
        await rows.filter({ hasText: 'Startup scripts' }).click();
        await page.getByRole('button', { name: 'Open scripts folder…' }).click();
        const startupExplorer = page.getByRole('dialog', { name: 'Files: Startup scripts' });
        await startupExplorer.waitFor();
        await startupExplorer.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'loose.cmd' }).waitFor();
        assert.deepEqual(await startupExplorer.locator('.gpo-editor-scripts__assets tbody tr td:nth-child(2)').allTextContents(),
            ['startup.cmd', 'loose.cmd', 'spare.cmd']);

        await startupExplorer.getByRole('checkbox', { name: 'Select file: loose.cmd' }).check();
        const downloadReady = page.waitForEvent('download');
        await startupExplorer.getByRole('button', { name: 'Download' }).click();
        assert.equal((await downloadReady).suggestedFilename(), 'loose.cmd');
        assert.deepEqual(await page.evaluate(() => {
            const call = calls.find(item => item.method === 'download');
            return [call.scope, call.event, call.request.name, call.request.revision];
        }), ['computer', 'startup', 'loose.cmd', 'r1']);

        const entryAddsBeforeUpload = await page.evaluate(() => calls.filter(call => call.method === 'add').length);
        const fileChooserReady = page.waitForEvent('filechooser');
        await startupExplorer.getByRole('button', { name: 'Upload', exact: true }).click();
        await (await fileChooserReady).setFiles({
            name: 'fresh.cmd', mimeType: 'text/plain', buffer: Buffer.from('abc')
        });
        await page.waitForFunction(() => calls.some(call => call.method === 'upload'));
        assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'add').length),
            entryAddsBeforeUpload);
        assert.deepEqual(await page.evaluate(() => {
            const call = calls.find(item => item.method === 'upload');
            return [call.scope, call.event, call.request.name, call.request.content_base64];
        }), ['computer', 'startup', 'fresh.cmd', 'YWJj']);
        await startupExplorer.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'fresh.cmd' }).waitFor();

        await startupExplorer.getByRole('checkbox', { name: 'Select file: spare.cmd' }).check();
        await startupExplorer.getByRole('button', { name: 'Delete file' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Yes' }).click();
        await page.waitForFunction(() => calls.filter(call => call.method === 'delete').length === 2);
        assert.deepEqual(await page.evaluate(() => calls.filter(call => call.method === 'delete')
            .map(call => [call.scope, call.event, call.request.name])), [
            ['computer', 'startup', 'loose.cmd'], ['computer', 'startup', 'spare.cmd']
        ]);
        await startupExplorer.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'loose.cmd' })
            .waitFor({ state: 'hidden' });
        await startupExplorer.locator('.preference__modal-footer > .btn-cancel').click();
        await startupExplorer.waitFor({ state: 'hidden' });

        await page.evaluate(() => render('user'));
        await page.locator('.gpo-editor-scripts__event-table tbody tr').filter({ hasText: 'Logon scripts' }).waitFor();
        assert.equal(await page.locator('.gpo-editor-scripts__event-table tbody tr').count(), 2);
        await page.getByRole('button', { name: 'Open scripts folder…' }).click();
        const userExplorer = page.getByRole('dialog', { name: 'Files: Logon scripts' });
        await userExplorer.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'user.cmd' }).waitFor();
        assert.deepEqual(await userExplorer.locator('.gpo-editor-scripts__assets tbody tr td:nth-child(2)').allTextContents(),
            ['user.cmd']);
        await userExplorer.locator('.preference__modal-footer > .btn-cancel').click();
        await userExplorer.waitFor({ state: 'hidden' });
        await page.locator('.gpo-editor-scripts__event-table tbody tr').filter({ hasText: 'Logoff scripts' }).click();
        await page.getByRole('button', { name: 'Open scripts folder…' }).click();
        const emptyExplorer = page.getByRole('dialog', { name: 'Files: Logoff scripts' });
        await emptyExplorer.waitFor();
        await emptyExplorer.getByText('No files. Upload a script to this folder.').waitFor();
        const explorerBounds = await emptyExplorer.boundingBox();
        const fileActionsBounds = await emptyExplorer.locator('.gpo-editor-scripts__assets .gpo-editor-scripts__toolbar')
            .boundingBox();
        const fileListBounds = await emptyExplorer.locator('.gpo-editor-scripts__assets .gpo-editor-scripts__list')
            .boundingBox();
        const explorerFooterBounds = await emptyExplorer.locator('.preference__modal-footer').boundingBox();
        assert.ok(explorerBounds.width <= 680 && explorerBounds.height <= 340);
        assert.ok(fileActionsBounds.y + fileActionsBounds.height <= fileListBounds.y + 3);
        assert.ok(explorerFooterBounds.y - (fileListBounds.y + fileListBounds.height) <= 26);
        assert.equal(await emptyExplorer.locator('input[type=file]:visible').count(), 0);
        assert.deepEqual(await emptyExplorer.locator('.gpo-editor-scripts__toolbar button:visible')
            .allTextContents(), ['Upload']);
        assert.equal(await emptyExplorer.getByRole('button', { name: 'Upload', exact: true })
            .evaluate(el => getComputedStyle(el).borderStyle), 'solid');
        await emptyExplorer.locator('.preference__modal-footer > .btn-cancel').click();
        await page.evaluate(() => { setLanguage('ru'); render('computer'); });
        await page.locator('.gpo-editor-scripts__event-table tbody tr').filter({ hasText: 'Сценарии запуска' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Открыть каталог скриптов…' }).count(), 1);
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
