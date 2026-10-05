'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let chromium, requireJs;
try { chromium = require('playwright').chromium; requireJs = require.resolve('requirejs/require.js'); } catch (_) { /* Optional browser runner. */ }
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const skip = !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false;
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{margin:0;font:12px Arial,sans-serif;color:#363636}.gp__container{height:100vh;min-width:0}</style>
</head><body><div class="gp__container"><header id="header"><button id="opener">Open fixture policy</button>
<div class="gp__control-actions" style="display:none">Unchanged catalog actions</div></header><main id="catalog">Unchanged catalog</main></div>
<script src="/require.js"></script><script>
window.requests=[];window.saved=[];window.pair=null;window.current=true;window.kind='normal';
function makePolicy(language,kind){
 const ru=language==='ru';const value={kind:'registry',value:{kind:'dword',value:1}};
 return {scope:'computer',policy_id:'fixture',label:ru?'Политика обработки пакетов':'Package processing policy',
  state:kind==='unknown'?'unknown_raw_values':kind==='disabled'?'disabled':'not_configured',
  capabilities:{enable:true,disable:true,clear:true,inspect_parameters:true,edit_parameters:true,edit_comments:true},
  state_actions:{enabled:{available:true,mode:'dynamic_list_values',requires_parameters:true},disabled:{available:kind!=='locked',mode:'clear_list_values'},not_configured:{available:true,mode:'remove_owned_records'}},
  parameters:[
   {id:'limit',label:ru?'Максимальное число записей':'Maximum entries',kind:'decimal',editable:true,min_value:1,max_value:100,value:null,default_value:{kind:'integer',value:20}},
   {id:'mode',label:ru?'Режим обработки':'Processing mode',kind:'enum',editable:true,choices:[{label:ru?'Автоматически':'Automatic',value}],value:null,default_value:value},
   {id:'items',label:ru?'Пакеты':'Packages',kind:'list',editable:true,collection:{mode:'list',unique_keys:false,min_items:1,allow_empty_values:false},value:null,default_value:{kind:'text_list',value:['firefox','chromium']}},
   ...(kind==='unknown'?[{id:'raw',label:'Preserved raw value',kind:'text',editable:false,value:{kind:'unsupported',value:{type:'binary',value:[0,255]}}}]:[])],
  supported_on:(ru?['Система ALT','Клиент групповых политик']:['ALT systems','Group Policy client']).join(String.fromCharCode(10)),
  explain_text:(ru?['Первый абзац.','','Второй абзац.']:['First paragraph.','','Second paragraph.']).join(String.fromCharCode(10)),
  comment:{source:'embedded',text:'Original comment'}};
}
define('util/API',[],()=>({
 policyShow:async(scope,id)=>{
  requests.push({method:'show',scope,id});
  if(window.deferShow)await new Promise(resolve=>window.finishShow=resolve);
  if(window.rejectShow)throw Object.assign(Error('Not available'),{category:'operational'});
  return {policy:structuredClone(policy)};
 },
 policyUpdate:async(scope,id,request)=>{
  requests.push({method:'update',scope,id,request:structuredClone(request)});
  if(window.rejectUpdates)throw Object.assign(Error('Fixture update rejected'),{category:window.rejectUpdates,field:'limit'});
  if(request.state)policy.state=request.state;
  (request.set_parameters||[]).forEach(value=>policy.parameters.find(parameter=>parameter.id===value.parameter_id).value=value.value);
  if(request.comment)policy.comment.text=request.comment.action==='clear'?'':request.comment.text;
  return {policy:structuredClone(policy)};
 },reconcile:async()=>({})
}));
require.config({baseUrl:'/js'});
require(['util/element-creator','components/templates/admx-template','locales/translations'],(elements,template,translations)=>{
 window.openFixture=(language='en',kind='normal')=>{
  if(pair)pair.editor.cleanup();translations.setLanguage(language);window.current=true;window.kind=kind;
  window.policy=makePolicy(language,kind);requests=[];saved=[];
  document.getElementById('opener').focus();
  pair=template.openAdmxDialog({append:node=>document.getElementById('catalog').append(node.getElement())},{
   item:{scope:'computer',policyId:'fixture',title:policy.label},isCurrent:()=>current,
   onSaved:response=>saved.push(structuredClone(response)),restoreFocus:()=>document.getElementById('opener')});
  return pair.editor.ready;
 };
 window.ready=true;
});</script></body></html>`;

async function fixture(run) {
    const server = http.createServer((req, res) => {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
        const filename = req.url === '/require.js' ? requireJs : path.join(root, req.url);
        try {
            res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
            res.end(fs.readFileSync(filename));
        } catch (_) { res.statusCode = 404; res.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        await run(page);
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

for (const language of ['en', 'ru']) {
    test('AT modal uses header-adjacent tabs, defaults and one typed update in ' + language, { skip }, async () => fixture(async page => {
        await page.evaluate(language => openFixture(language), language);
        const modal = page.locator('.gpo-admx-dialog');
        const enabled = language === 'ru' ? 'Включено' : 'Enabled';
        const apply = language === 'ru' ? 'Применить' : 'Apply';
        const explanation = language === 'ru' ? 'Объяснение' : 'Explanation';
        assert.equal(await modal.locator('[data-category-path], .gpo-at-design__path').count(), 0);
        assert.equal(await modal.getByRole('tab', { name: language === 'ru' ? 'Параметры' : 'Parameters', exact: true }).count(), 1);
        const geometry = await modal.evaluate(element => {
            const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
            return { modal: box(element), header: box(element.querySelector('.preference__modal-header')), tabs: box(element.querySelector('.tab-buttons')), footer: box(element.querySelector('.preference__modal-footer')), number: box(element.querySelector('input[type=number]')) };
        });
        assert.ok(Math.abs(geometry.tabs.top - geometry.header.bottom) <= 1, JSON.stringify(geometry));
        assert.equal(Math.round(geometry.modal.width), 642);
        assert.equal(Math.round(geometry.number.width), 190);
        assert.ok((await modal.getByRole('button', { name: apply, exact: true }).boundingBox()).width >= 96);
        assert.equal(await page.locator('.gp__control-actions').evaluate(element => element.style.display), 'none');
        assert.equal(await modal.locator('[data-field-id=limit] input').inputValue(), '20');
        assert.equal(await modal.locator('[data-field-id=limit] input').isDisabled(), true);
        assert.equal(await modal.getByRole('button', { name: language === 'ru' ? 'Изменить: Пакеты' : 'Edit Packages', exact: true }).isDisabled(), true);
        await modal.getByRole('tab', { name: explanation, exact: true }).click();
        const panel = modal.locator('.gpo-admx-dialog__explanation');
        assert.equal(await panel.locator('br').count(), 3);
        assert.equal(await modal.locator('textarea').isVisible(), false);
        await modal.getByRole('tab').first().click();
        await modal.getByRole('radio', { name: enabled, exact: true }).check();
        await modal.locator('[data-field-id=limit] input').fill('42');
        await modal.locator('textarea').fill('Updated comment');
        await modal.getByRole('button', { name: apply, exact: true }).click();
        await modal.waitFor({ state: 'detached' });
        const updates = await page.evaluate(() => requests.filter(request => request.method === 'update'));
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].request, {
            state: 'enabled',
            set_parameters: [
                { parameter_id: 'limit', value: { kind: 'integer', value: 42 } },
                { parameter_id: 'mode', value: { kind: 'registry', value: { kind: 'dword', value: 1 } } },
                { parameter_id: 'items', value: { kind: 'text_list', value: ['firefox', 'chromium'] } }
            ],
            comment: { action: 'set', target: 'embedded', text: 'Updated comment' }
        });
        assert.equal(await page.evaluate(() => saved.length), 1);
        assert.equal(await page.locator('#opener').evaluate(element => element === document.activeElement), true);
    }));
}

test('AT modal retains validation drafts, nests collection edits and reuses discard confirmation', { skip }, async () => fixture(async page => {
    await page.evaluate(() => openFixture());
    const modal = page.locator('.gpo-admx-dialog');
    await modal.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await modal.getByRole('button', { name: 'Edit Packages', exact: true }).click();
    const collection = page.locator('.gpo-collection-dialog');
    await collection.locator('[data-collection-field=value]').first().dblclick();
    await collection.locator('[data-collection-input]').fill('vim');
    await collection.locator('[data-collection-input]').press('Enter');
    assert.equal(await page.evaluate(() => pair.editor.hasUnsavedChanges()), true);
    assert.equal(await page.evaluate(() => pair.editor.applyChanges()), false);
    assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'update').length), 0);
    await collection.getByRole('button', { name: 'OK', exact: true }).click();
    await collection.waitFor({ state: 'detached' });
    await page.evaluate(() => { window.rejectUpdates = 'validation'; });
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await modal.locator('[data-error-category=validation]').waitFor();
    assert.equal(await modal.locator('[data-field-id=items]').textContent(), 'Items: 2vim, chromiumEdit…');
    assert.equal(await page.evaluate(() => saved.length), 0);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.waitFor();
    assert.equal(await modal.evaluate(element => element.inert), true);
    await confirmation.getByRole('button', { name: 'No', exact: true }).click();
    assert.equal(await modal.evaluate(element => element.inert), false);
    assert.equal(await page.evaluate(() => pair.editor.hasUnsavedChanges()), true);
    await page.evaluate(() => { window.rejectUpdates = false; });
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    const updates = await page.evaluate(() => requests.filter(request => request.method === 'update'));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].request, updates[1].request);
    assert.deepEqual(updates[1].request.set_parameters.find(parameter => parameter.parameter_id === 'items').value, { kind: 'text_list', value: ['vim', 'chromium'] });
}));

test('AT modal opens before loading, ignores cancelled/stale results and retries without navigating', { skip }, async () => fixture(async page => {
    await page.evaluate(() => { window.deferShow = true; void openFixture(); });
    const modal = page.locator('.gpo-admx-dialog');
    await modal.locator('[role=status]').waitFor();
    assert.equal(await modal.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(async () => { finishShow(); await pair.editor.ready; });
    assert.equal(await modal.count(), 0);
    await page.evaluate(() => { window.deferShow = true; void openFixture(); });
    await page.evaluate(async () => { window.current = false; finishShow(); await pair.editor.ready; });
    assert.equal(await modal.count(), 0);
    await page.evaluate(() => { window.deferShow = false; window.rejectShow = true; return openFixture(); });
    await modal.locator('[data-error-category=operational]').waitFor();
    await page.evaluate(() => { window.rejectShow = false; });
    await modal.getByRole('button', { name: 'Refresh', exact: true }).click();
    await modal.getByRole('radio', { name: 'Enabled', exact: true }).waitFor();
    assert.equal(await page.locator('#catalog').evaluate(element => element.firstChild.textContent), 'Unchanged catalog');
    assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'show').length), 2);
}));

test('AT capability restrictions and conflict refresh use the shared confirmation without accidental writes', { skip }, async () => fixture(async page => {
    await page.evaluate(() => openFixture('en', 'locked'));
    const modal = page.locator('.gpo-admx-dialog');
    assert.equal(await modal.getByRole('radio', { name: 'Disabled', exact: true }).isDisabled(), true);
    await modal.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await modal.locator('[data-field-id=limit] input').fill('43');
    await page.evaluate(() => { window.rejectUpdates = 'storage_conflict'; });
    await modal.getByRole('button', { name: 'Apply', exact: true }).click();
    await modal.locator('[data-error-category=storage_conflict]').waitFor();
    await modal.getByRole('button', { name: 'Refresh', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: 'No', exact: true }).click();
    assert.equal(await modal.locator('[data-field-id=limit] input').inputValue(), '43');
    assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'show').length), 1);
    await modal.getByRole('button', { name: 'Refresh', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.waitForFunction(() => requests.filter(request => request.method === 'show').length === 2);
    await modal.getByRole('radio', { name: 'Not Configured', exact: true }).waitFor();
    assert.equal(await modal.locator('[data-field-id=limit] input').inputValue(), '20');
    assert.equal(await page.evaluate(() => pair.editor.hasUnsavedChanges()), false);
    await modal.getByRole('radio', { name: 'Enabled', exact: true }).check();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Yes', exact: true }).click();
    await modal.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => saved.length), 0);
    assert.equal(await page.evaluate(() => pair.editor.applyChanges()), false);
    assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'update').length), 1);
}));

test('AT unknown values remain read-only and modal controls fit a narrow viewport', { skip }, async () => fixture(async page => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.evaluate(() => openFixture('en', 'unknown'));
    const modal = page.locator('.gpo-admx-dialog');
    assert.equal(await modal.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
    assert.equal(await modal.getByRole('radio').evaluateAll(inputs => inputs.every(input => input.disabled)), true);
    assert.equal(await modal.locator('textarea').isDisabled(), true);
    assert.equal(await modal.locator('.gpo-editor-unsupported').textContent(), JSON.stringify({ type: 'binary', value: [0, 255] }, null, 2));
    const geometry = await modal.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const footer = element.querySelector('.preference__modal-footer').getBoundingClientRect();
        const header = element.querySelector('.preference__modal-header').getBoundingClientRect();
        const tabs = element.querySelector('.tab-buttons').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, footerBottom: footer.bottom, width: element.clientWidth, scrollWidth: element.scrollWidth, headerBottom: header.bottom, tabsTop: tabs.top };
    });
    assert.ok(geometry.left >= 10 && geometry.right <= 380 && geometry.top >= 10 && geometry.bottom <= 490, JSON.stringify(geometry));
    assert.ok(geometry.footerBottom <= geometry.bottom && geometry.scrollWidth <= geometry.width, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.tabsTop - geometry.headerBottom) <= 1, JSON.stringify(geometry));
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'update').length), 0);
}));
