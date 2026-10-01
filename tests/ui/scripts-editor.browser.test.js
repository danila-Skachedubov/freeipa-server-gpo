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
const createView=()=>({scope:'computer',event:'startup',execution_order:'unspecified',
 upload_limit_bytes:16777216,
 classic:{snapshot:'classic-snapshot',editable:true,entries:[
  {identity:'one',command_line:'one.cmd',parameters:'',kind:'managed_asset',managed_asset_name:'one.cmd'},
  {identity:'two',command_line:'two.cmd',parameters:'/q',kind:'external',managed_asset_name:null}]},
 powershell:{snapshot:'powershell-snapshot',editable:true,entries:[]},
 assets:[
  {name:'one.cmd',byte_size:3,revision:'r1',references:[{event:'startup',executable_group:'classic',index:0}]},
  {name:'unused.cmd',byte_size:6,revision:'r2',references:[]}]
});
window.views={computer:{startup:createView(),shutdown:createView()},user:{logon:createView(),logoff:createView()}};
window.calls=[];
window.failNext=false;
function response(scope,event){const v=structuredClone(views[scope][event]);v.scope=scope;v.event=event;return {scripts:v};}
function change(method,scope,event,request,fn){
 calls.push({method,scope,event,request:structuredClone(request)});
 if(failNext){failNext=false;return Promise.reject(Object.assign(new Error('Server rejected update'),{category:'validation'}));}
 fn(views[scope][event]);return Promise.resolve(response(scope,event));
}
define('util/API',[],()=>({
 scriptsShow:async(scope,event)=>{calls.push({method:'show',scope,event});return response(scope,event);},
 scriptEntryAdd:(scope,event,request)=>change('add',scope,event,request,v=>{
  const id='new-'+calls.length;
  v[request.executable_group].entries.push({identity:id,
   command_line:request.mode==='existing_asset'?request.name:request.command_line,
   parameters:request.parameters,kind:request.mode==='existing_asset'?'managed_asset':'external',
   managed_asset_name:request.mode==='existing_asset'?request.name:null});
  if(request.mode==='existing_asset')v.assets.find(a=>a.name===request.name).references.push({event,executable_group:request.executable_group,index:0});
 }),
 scriptEntryUpdate:(scope,event,request)=>change('update',scope,event,request,v=>{
  const entry=v[request.executable_group].entries.find(e=>e.identity===request.identity);
  entry.command_line=request.command_line;entry.parameters=request.parameters;
 }),
 scriptEntryRemove:(scope,event,request)=>change('remove',scope,event,request,v=>{
  v[request.executable_group].entries=v[request.executable_group].entries.filter(e=>e.identity!==request.identity);
 }),
 scriptEntriesReorder:(scope,event,request)=>change('reorder',scope,event,request,v=>{
  const entries=v[request.executable_group].entries;
  v[request.executable_group].entries=request.identities.map(id=>entries.find(e=>e.identity===id));
 }),
 scriptOrderUpdate:(scope,event,request)=>change('order',scope,event,request,v=>{
  v.execution_order=request.execution_order;
 }),
 scriptAssetUpload:(scope,event,request)=>change('upload',scope,event,request,v=>{
  v.assets.push({name:request.name,byte_size:atob(request.content_base64).length,
   revision:'r3',references:[]});
 }),
 scriptAssetReplace:(scope,event,request)=>change('replace',scope,event,request,v=>{
  const asset=v.assets.find(a=>a.name===request.name);
  asset.byte_size=atob(request.content_base64).length;asset.revision='r4';
 }),
 scriptAssetDelete:(scope,event,request)=>change('delete',scope,event,request,v=>{
  v.assets=v.assets.filter(a=>a.name!==request.name);
 }),
 scriptAssetDownload:async(scope,event,request)=>{
  calls.push({method:'download',scope,event,request:structuredClone(request)});
  return {asset:{name:request.name,revision:request.revision,byte_size:3,content_base64:'T05F'}};
 },
 reconcile:async()=>({})
}));
require.config({baseUrl:'/js'});
require(['components/templates/script-template','components/header/header','locales/translations'],(template,headerModule,translations)=>{
 translations.setLanguage('en');
 window.header=headerModule.renderHeader(document.getElementById('header'));
 window.render=(scope,event)=>{
  if(window.currentView)window.currentView.cleanup();
  window.currentView=template.renderScriptsTemplate({item:{scope,event},header:window.header,isCurrent:()=>true});
  document.getElementById('workspace').replaceChildren(currentView.getElement());
 };
 render('computer','startup');window.ready=true;
});
</script></body></html>`;

test('Scripts event page publishes each operation and manages only its scoped SYSVOL files', {
    skip: !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false
}, async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end(html);
        }
        const file = req.url === '/require.js' ? requireJs : path.join(root, req.url);
        try {
            res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
            res.end(fs.readFileSync(file));
        } catch (_) { res.statusCode = 404; res.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready && document.querySelector('.gpo-editor-scripts__entries tbody tr'));
        assert.equal(await page.locator('.gpo-editor-scripts__title').textContent(), 'Startup scripts');
        assert.equal(await page.getByRole('button', { name: 'Shutdown scripts' }).count(), 0);
        assert.equal(await page.locator('.gpo-editor-scripts__entries .preference__table th').first()
            .evaluate(el => getComputedStyle(el).fontWeight), '400');
        const topAdd = page.locator('.preferences__btn-create');
        const topEdit = page.locator('.preferences__btn-edit');
        const topRemove = page.locator('.preferences__btn-delete');
        assert.equal(await topAdd.textContent(), 'Add');
        assert.equal(await topAdd.evaluate(el => el.classList.contains('active')), true);
        assert.equal(await topEdit.evaluate(el => el.classList.contains('active')), false);
        assert.equal(await topRemove.evaluate(el => el.classList.contains('active')), false);

        await page.locator('.gpo-editor-scripts__order select').selectOption('powershell_first');
        assert.equal(await page.getByRole('button', { name: 'Apply order' }).isEnabled(), true);
        await page.locator('.gpo-editor-scripts__entries tbody tr').nth(1).click();
        assert.equal(await topEdit.evaluate(el => el.classList.contains('active')), true);
        assert.equal(await topRemove.evaluate(el => el.classList.contains('active')), true);
        await page.getByRole('button', { name: 'Up', exact: true }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'reorder'));
        assert.deepEqual(await page.evaluate(() => calls.find(call => call.method === 'reorder').request.identities), ['two', 'one']);
        assert.equal(await page.locator('.gpo-editor-scripts__order select').inputValue(), 'powershell_first');
        assert.equal(await page.getByRole('button', { name: 'Apply order' }).isEnabled(), true);
        await page.getByRole('button', { name: 'Apply order' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'order'));
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'order').request.execution_order), 'powershell_first');

        await topAdd.click();
        const form = page.locator('.gpo-editor-scripts__form');
        await form.locator('select').first().selectOption('external_command');
        await form.locator('input[type=text]:not([readonly])').first().fill('local.cmd');
        await form.locator('input[type=text]:not([readonly])').last().fill('/quiet');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'add'));
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'add').request.command_line), 'local.cmd');
        await form.waitFor({ state: 'hidden' });

        await page.locator('.gpo-editor-scripts__entries tbody tr').filter({ hasText: 'local.cmd' }).click();
        await topEdit.click();
        await form.locator('input[type=text]:not([readonly])').first().fill('edited.cmd');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'update'));
        await page.locator('.gpo-editor-scripts__entries tbody tr').filter({ hasText: 'edited.cmd' }).click();
        await topRemove.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Yes' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'remove'));

        await page.locator('input[type=file]').first().setInputFiles({
            name: 'new.cmd', mimeType: 'text/plain', buffer: Buffer.from('abc')
        });
        await page.waitForFunction(() => calls.some(call => call.method === 'upload'));
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'upload').request.content_base64), 'YWJj');
        await page.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'new.cmd' }).click();
        await page.getByRole('button', { name: 'Add selected script…' }).click();
        assert.equal(await form.locator('input[readonly]').inputValue(), 'new.cmd');
        const callsBeforeCancel = await page.evaluate(() => calls.length);
        await form.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await page.evaluate(() => calls.length), callsBeforeCancel);
        await topAdd.click();
        assert.equal(await form.locator('select').inputValue(), 'existing_asset');
        await form.getByRole('button', { name: 'Browse policy files…' }).click();
        const picker = page.locator('.gpo-editor-scripts__picker');
        await picker.locator('tbody tr').filter({ hasText: 'new.cmd' }).click();
        await picker.getByRole('button', { name: 'Select file' }).click();
        assert.equal(await form.locator('input[readonly]').inputValue(), 'new.cmd');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'add' && call.request.mode === 'existing_asset'));
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'add' && call.request.mode === 'existing_asset').request.name), 'new.cmd');

        await page.locator('.gpo-editor-scripts__entries tbody tr').filter({ hasText: 'new.cmd' }).click();
        await topEdit.click();
        await form.getByRole('button', { name: 'Browse policy files…' }).click();
        await picker.locator('tbody tr').filter({ hasText: 'one.cmd' }).click();
        await picker.getByRole('button', { name: 'Select file' }).click();
        assert.equal(await form.locator('input[readonly]').inputValue(), 'one.cmd');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.filter(call => call.method === 'update').length === 2);
        assert.equal(await page.evaluate(() => calls.filter(call => call.method === 'update').at(-1).request.command_line), 'one.cmd');

        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download' }).click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'new.cmd');
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'download').request.revision), 'r3');

        await page.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'one.cmd' }).click();
        assert.equal(await page.getByRole('button', { name: 'Delete file' }).isDisabled(), true);
        await page.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'new.cmd' }).click();
        await page.locator('input[type=file]').last().setInputFiles({
            name: 'replacement.cmd', mimeType: 'text/plain', buffer: Buffer.from('updated')
        });
        await page.getByRole('alertdialog').getByRole('button', { name: 'Yes' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'replace'));
        assert.deepEqual(await page.evaluate(() => {
            const call = calls.find(item => item.method === 'replace');
            return [call.request.name, call.request.revision, call.request.content_base64];
        }), ['new.cmd', 'r3', 'dXBkYXRlZA==']);

        await page.locator('.gpo-editor-scripts__assets tbody tr').filter({ hasText: 'unused.cmd' }).click();
        await page.getByRole('button', { name: 'Delete file' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Yes' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'delete'));
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'delete').request.name), 'unused.cmd');

        await topAdd.click();
        await form.locator('select').first().selectOption('external_command');
        await form.locator('input[type=text]:not([readonly])').first().fill('keep-this-draft.cmd');
        await page.evaluate(() => { window.failNext = true; });
        await form.getByRole('button', { name: 'Apply' }).click();
        await form.getByRole('button', { name: 'Cancel' }).waitFor();
        assert.equal(await form.locator('input[type=text]:not([readonly])').first().inputValue(), 'keep-this-draft.cmd');
        await form.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'No' }).click();
        assert.equal(await form.locator('input[type=text]:not([readonly])').first().inputValue(), 'keep-this-draft.cmd');
        await form.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Yes' }).click();
        await form.waitFor({ state: 'hidden' });

        await page.evaluate(() => render('user', 'logon'));
        await page.waitForFunction(() => calls.some(call => call.method === 'show' && call.scope === 'user' && call.event === 'logon'));
        assert.equal(await page.locator('.gpo-editor-scripts__title').textContent(), 'Logon scripts');
        await page.getByRole('tab', { name: 'PowerShell scripts' }).click();
        await topAdd.click();
        await form.locator('select').first().selectOption('external_command');
        await form.locator('input[type=text]:not([readonly])').first().fill('user-logon.ps1');
        await form.getByRole('button', { name: 'Apply' }).click();
        await page.waitForFunction(() => calls.some(call => call.method === 'add'
            && call.scope === 'user' && call.event === 'logon'));
        assert.deepEqual(await page.evaluate(() => {
            const call = calls.find(item => item.method === 'add'
                && item.scope === 'user' && item.event === 'logon');
            return [call.request.executable_group, call.request.snapshot, call.request.command_line];
        }), ['powershell', 'powershell-snapshot', 'user-logon.ps1']);

        await page.evaluate(() => {
            views.computer.shutdown.classic.editable = false;
            views.computer.shutdown.classic.diagnostics = [
                { code: 'parse_error', message: 'Malformed scripts.ini' }
            ];
            render('computer', 'shutdown');
        });
        await page.waitForFunction(() => document.querySelector('.gpo-editor-scripts__title')
            ?.textContent === 'Shutdown scripts');
        assert.equal(await page.getByText('This script list cannot be edited.').count(), 1);
        assert.equal(await page.locator('.gpo-editor-status__diagnostics').textContent()
            .then(value => value.includes('Malformed scripts.ini')), true);
        assert.equal(await topAdd.evaluate(el => el.classList.contains('active')), false);
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
