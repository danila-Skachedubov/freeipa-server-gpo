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
const browserOptions = {
    skip: !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false
};
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636}.gp__container{height:100vh}#workspace{padding:20px}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace">
<input id="catalog-query" value="File"><div id="catalog-row" class="active">Selected All Policies result</div>
<button id="open-preferences">Preferences result</button><button id="open-scripts">Scripts result</button>
<div id="dialog-host"></div></main></div>
<script src="/require.js"></script><script>
window.calls=[];window.saved=[];window.closeCount=0;window.holdPreferences=false;window.holdScripts=false;
window.holdWrite=false;window.closed=false;
const field=(id,label,kind,value)=>({id,label,value:{kind,value},editable:true});
window.preferenceRows=[{identity:['files','one'],label:'First file',has_filters:false},
 {identity:['files','two'],label:'Second file',has_filters:false}];
window.preferenceFields=[field('properties.action','Action','action','update'),
 field('properties.fromPath','Source','text','source.txt'),field('metadata.desc','Description','text','Description')];
window.scripts={scope:'computer',event:'shutdown',execution_order:'unspecified',
 classic:{snapshot:'classic-1',editable:true,entries:[{identity:'script-one',command_line:'one.cmd',parameters:'',kind:'managed_asset',managed_asset_name:'one.cmd'}]},
 powershell:{snapshot:'ps-1',editable:true,entries:[]},
 assets:[{name:'one.cmd',byte_size:3,revision:'r1',references:[{event:'shutdown',executable_group:'classic',index:0}]}]};
const scriptsResponse=()=>({scripts:structuredClone(scripts)});
define('util/API',[],()=>({
 preferenceItems:async(scope,kind)=>{
  calls.push({method:'preferenceItems',scope,kind});
  if(holdPreferences)await new Promise(resolve=>window.resolvePreferences=resolve);
  return {items:structuredClone(preferenceRows)};
 },
 preferenceShow:async(scope,kind,identity)=>{
  calls.push({method:'preferenceShow',scope,kind,identity});
  return {item:identity==null?null:structuredClone(preferenceRows.find(row=>JSON.stringify(row.identity)===JSON.stringify(identity))),
   fields:structuredClone(preferenceFields),new_item_fields:structuredClone(preferenceFields),
   filters:[],filter_fields:[],filter_kinds:[{kind:'battery',label:'Battery',supports_children:false,
    fields:[field('filter.bool','Operator','filter_combine','and'),field('filter.not','Not','boolean',false)]}],
   parent_candidates:[{identity:null,label:'Root',depth:0}]};
 },
 preferenceUpdate:async(scope,kind,request)=>{
  calls.push({method:'preferenceUpdate',scope,kind,request:structuredClone(request)});
  const row=preferenceRows.find(row=>JSON.stringify(row.identity)===JSON.stringify(request.identity));
  if(request.name!==undefined)row.label=request.name;
  if(holdWrite)await new Promise(resolve=>window.resolveWrite=resolve);
  return {item:structuredClone(row),publication:{changed:true}};
 },
 preferenceCreate:async(scope,kind,request)=>{
  calls.push({method:'preferenceCreate',scope,kind,request:structuredClone(request)});
  const row={identity:['files','added-'+calls.length],label:'Added file',has_filters:false};
  preferenceRows.push(row);return {item:row,publication:{changed:true}};
 },
 preferenceDelete:async(scope,kind,identity)=>{
  calls.push({method:'preferenceDelete',scope,kind,identity});
  preferenceRows=preferenceRows.filter(row=>JSON.stringify(row.identity)!==JSON.stringify(identity));
  return {publication:{changed:true}};
 },
 scriptsShow:async(scope,event)=>{
  calls.push({method:'scriptsShow',scope,event});
  if(holdScripts)await new Promise(resolve=>window.resolveScripts=resolve);
  return scriptsResponse();
 },
 scriptEntryAdd:async(scope,event,request)=>{
  calls.push({method:'scriptEntryAdd',scope,event,request:structuredClone(request)});
  if(holdWrite)await new Promise(resolve=>window.resolveWrite=resolve);
  scripts[request.executable_group].entries.push({identity:'script-added',command_line:request.name||request.command_line,
   parameters:request.parameters,kind:'managed_asset',managed_asset_name:request.name});return scriptsResponse();
 },
 scriptAssetUpload:async(scope,event,request)=>{
  calls.push({method:'scriptAssetUpload',scope,event,request:structuredClone(request)});
  scripts.assets.push({name:request.name,byte_size:atob(request.content_base64).length,revision:'r2',references:[]});return scriptsResponse();
 },
 reconcile:async()=>({})
}));
require.config({baseUrl:'/js'});
require(['util/element-creator','components/templates/script-template','components/templates/preference/preferences-view-template',
 'components/header/header','locales/translations'],(elements,scriptTemplate,preferenceTemplate,headerModule,translations)=>{
 translations.setLanguage('en');window.translations=translations;
 window.header=headerModule.renderHeader(document.getElementById('header'));
 window.headerBefore=document.getElementById('header').innerHTML;
 window.host=elements.createElement('div');document.getElementById('dialog-host').appendChild(host.getElement());
 const configuration=()=>({isCurrent:()=>!closed,onClose:()=>{closeCount++;closed=true;},onSaved:response=>saved.push(structuredClone(response))});
 window.openPreferences=()=>{
  closed=false;window.opening=preferenceTemplate.openPreferencesDialog(host,{...configuration(),
   item:{scope:'computer',template:'preferences',preferenceKind:'files',title:'Files',document:{editable:true,label:'Files'}}});
  return opening.then(result=>{window.current=result;return Boolean(result);});
 };
 window.openScripts=()=>{
  closed=false;window.current=scriptTemplate.openScriptsDialog(host,{...configuration(),
   item:{scope:'computer',template:'scripts',scriptEvent:'shutdown',title:'Shutdown scripts'}});
 };
 document.getElementById('open-preferences').addEventListener('click',()=>void openPreferences());
 document.getElementById('open-scripts').addEventListener('click',openScripts);
 window.ready=true;
});
</script></body></html>`;

async function withPage(run) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            return response.end(html);
        }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
            response.end(fs.readFileSync(filename));
        } catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
        page.setDefaultTimeout(5000);
        page.on('dialog', dialog => dialog.accept());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        try { await run(page); }
        catch (error) { error.message += '; browser errors: ' + errors.join('; '); throw error; }
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function unchangedCatalog(page) {
    assert.equal(await page.locator('#catalog-query').inputValue(), 'File');
    assert.equal(await page.locator('#catalog-row').getAttribute('class'), 'active');
    assert.equal(await page.evaluate(() => document.getElementById('header').innerHTML === headerBefore), true);
}

test('Preferences result opens a local family toolbar, reuses item/targeting editors, saves and returns without changing the catalog', browserOptions, async () => {
    await withPage(async page => {
        await page.locator('#open-preferences').click();
        const family = page.getByRole('dialog', { name: 'Files', exact: true });
        await family.locator('.preference__table tbody tr').first().waitFor();
        assert.equal(await family.locator('[data-category-path]').count(), 0);
        assert.equal(await family.locator('.preferences__btn-create').isVisible(), true);
        assert.equal(await family.locator('.preferences__btn-edit').isVisible(), true);
        assert.equal(await family.locator('.preferences__btn-delete').isVisible(), true);
        await unchangedCatalog(page);
        await family.locator('.preference__table tbody tr').first().click();
        await family.locator('.preferences__btn-edit').click();
        const form = page.getByRole('dialog', { name: 'Edit preference item', exact: true });
        await form.waitFor();
        assert.equal(await family.evaluate(element => element.inert), true);
        await form.locator('.preference__tab-button[data-tab="tab-general"]').click();
        await form.locator('.preference__tab-targetting-btn').click();
        const targeting = page.getByRole('dialog', { name: 'Targeting Editor', exact: true });
        await targeting.waitFor();
        await targeting.locator('.btn-cancel').click();
        await targeting.waitFor({ state: 'hidden' });
        await form.locator('.preference__tab-button[data-tab="tab-basic"]').click();
        await form.locator('[data-field-id="name"] input').fill('Renamed file');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        await family.locator('tbody tr').filter({ hasText: 'Renamed file' }).waitFor();
        assert.equal(await page.evaluate(() => saved.length), 1);
        await family.locator('.preference__modal-footer > .btn-cancel').click();
        await family.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => closeCount), 1);
        assert.equal(await page.locator('#open-preferences').evaluate(element => element === document.activeElement), true);
        await unchangedCatalog(page);
    });
});

test('Preferences family supports repeated creates and removal using its local controls', browserOptions, async () => {
    await withPage(async page => {
        await page.locator('#open-preferences').click();
        const family = page.getByRole('dialog', { name: 'Files', exact: true });
        await family.locator('tbody tr').first().waitFor();
        for (const source of ['first-new.txt', 'second-new.txt']) {
            await family.locator('.preferences__btn-create').click();
            const form = page.getByRole('dialog', { name: 'Create preference item', exact: true });
            await form.locator('[data-field-id="properties.fromPath"] input').fill(source);
            await form.getByRole('button', { name: 'Save', exact: true }).click();
            await form.waitFor({ state: 'hidden' });
        }
        assert.equal(await family.locator('tbody tr').count(), 4);
        await family.locator('tbody tr').last().click();
        await family.locator('.preferences__btn-delete').click();
        await page.waitForFunction(() => calls.some(call => call.method === 'preferenceDelete'));
        assert.equal(await family.locator('tbody tr').count(), 3);
        assert.equal(await page.evaluate(() => saved.length), 3);
        await family.locator('.close').click();
        await unchangedCatalog(page);
    });
});

test('Preferences outer close shares discard confirmation and cleans nested forms without discarding on No', browserOptions, async () => {
    await withPage(async page => {
        await page.locator('#open-preferences').click();
        const family = page.getByRole('dialog', { name: 'Files', exact: true });
        await family.locator('tbody tr').first().dblclick();
        const form = page.getByRole('dialog', { name: 'Edit preference item', exact: true });
        await form.locator('[data-field-id="name"] input').fill('Retain this draft');
        await page.evaluate(() => current.dialog.requestClose());
        const confirmation = page.getByRole('alertdialog');
        await confirmation.waitFor();
        await confirmation.locator('.btn-no').click();
        assert.equal(await form.locator('[data-field-id="name"] input').inputValue(), 'Retain this draft');
        assert.equal(await page.evaluate(() => current.editor.hasUnsavedChanges()), true);
        await page.evaluate(() => current.dialog.requestClose());
        await confirmation.locator('.btn-yes').click();
        await family.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.gpo-editor-preference-form').count(), 0);
        assert.equal(await page.locator('.gpo-editor-preferences__modal-host').count(), 0);
        assert.equal(await page.evaluate(() => calls.some(call => call.method === 'preferenceUpdate')), false);
        await unchangedCatalog(page);
    });
});

test('closing a still-loading Preferences family does not resurrect it after its response arrives', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => { holdPreferences = true; });
        await page.locator('#open-preferences').click();
        const family = page.getByRole('dialog', { name: 'Files', exact: true });
        await family.waitFor();
        await page.waitForFunction(() => Boolean(window.resolvePreferences));
        await family.locator('.close').click();
        await page.evaluate(() => { resolvePreferences(); return opening; });
        assert.equal(await page.evaluate(() => current), null);
        assert.equal(await page.locator('[role="dialog"]').count(), 0);
        assert.equal(await page.locator('.gpo-editor-preferences__modal-host').count(), 0);
        assert.equal(await page.evaluate(() => closeCount), 1);
        await unchangedCatalog(page);
    });
});

test('Scripts result loads only its event, opens a nested SYSVOL explorer and publishes existing entry operations immediately', browserOptions, async () => {
    await withPage(async page => {
        await page.locator('#open-scripts').click();
        const event = page.getByRole('dialog', { name: 'Shutdown scripts', exact: true });
        await event.locator('.gpo-editor-scripts__entries tbody tr').first().waitFor();
        assert.deepEqual(await page.evaluate(() => calls.filter(call => call.method === 'scriptsShow').map(call => [call.scope, call.event])), [['computer', 'shutdown']]);
        assert.equal(await page.locator('.gpo-editor-scripts__overview').count(), 0);
        assert.equal(await event.locator('[data-category-path]').count(), 0);
        await unchangedCatalog(page);
        await event.locator('.gpo-editor-scripts__order select').selectOption('powershell_first');
        await event.getByRole('button', { name: 'Show files…', exact: true }).click();
        const explorer = page.getByRole('dialog', { name: 'Files: Shutdown scripts', exact: true });
        await explorer.locator('tbody tr').first().waitFor();
        assert.equal(await event.evaluate(element => element.inert), true);
        const file = explorer.locator('input[type=file]').first();
        await file.setInputFiles({ name: 'uploaded.cmd', mimeType: 'application/octet-stream', buffer: Buffer.from('echo test') });
        await explorer.locator('tbody tr').filter({ hasText: 'uploaded.cmd' }).waitFor();
        await explorer.press('Escape');
        await explorer.waitFor({ state: 'hidden' });
        assert.equal(await event.evaluate(element => element.inert), false);
        assert.equal(await event.locator('.gpo-editor-scripts__order select').inputValue(), 'powershell_first');
        await event.getByRole('button', { name: 'Add', exact: true }).click();
        const form = event.locator('.gpo-editor-scripts__form');
        await form.locator('.gpo-editor-scripts__asset-field input').fill('uploaded.cmd');
        await form.getByRole('button', { name: 'Apply', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        await event.locator('.gpo-editor-scripts__entries tbody tr').filter({ hasText: 'uploaded.cmd' }).waitFor();
        assert.equal(await page.evaluate(() => calls.find(call => call.method === 'scriptEntryAdd').request.mode), 'existing_asset');
        assert.equal(await page.evaluate(() => saved.length), 2);
        assert.ok(await page.evaluate(() => calls.filter(call => call.method === 'scriptsShow').every(call => call.event === 'shutdown')));
        await page.evaluate(() => current.editor.cancelChanges());
        await event.locator('.preference__modal-footer > .btn-cancel').last().click();
        await event.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => closeCount), 1);
        await unchangedCatalog(page);
    });
});

test('Scripts cleanup suppresses a late event load and restores the result focus', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => { holdScripts = true; });
        await page.locator('#open-scripts').click();
        const event = page.getByRole('dialog', { name: 'Shutdown scripts', exact: true });
        await page.waitForFunction(() => Boolean(window.resolveScripts));
        await event.locator('.close').click();
        await page.evaluate(() => resolveScripts());
        await page.waitForTimeout(50);
        assert.equal(await page.locator('[role="dialog"]').count(), 0);
        assert.equal(await page.evaluate(() => closeCount), 1);
        assert.equal(await page.locator('#open-scripts').evaluate(element => element === document.activeElement), true);
        await unchangedCatalog(page);
    });
});

test('busy script publication prevents closing its family dialog and keeps the submitted form', browserOptions, async () => {
    await withPage(async page => {
        await page.locator('#open-scripts').click();
        const event = page.getByRole('dialog', { name: 'Shutdown scripts', exact: true });
        await event.locator('tbody tr').first().waitFor();
        await page.evaluate(() => { holdWrite = true; });
        await event.getByRole('button', { name: 'Add', exact: true }).click();
        const form = event.locator('.gpo-editor-scripts__form');
        await form.locator('.gpo-editor-scripts__asset-field input').fill('one.cmd');
        await form.getByRole('button', { name: 'Apply', exact: true }).click();
        await page.waitForFunction(() => Boolean(window.resolveWrite));
        assert.equal(await page.evaluate(() => current.dialog.requestClose()), false);
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        assert.equal(await form.isVisible(), true);
        await page.evaluate(() => resolveWrite());
        await form.waitFor({ state: 'hidden' });
        await event.locator('.preference__modal-footer > .btn-cancel').last().click();
        await event.waitFor({ state: 'hidden' });
        await unchangedCatalog(page);
    });
});
