'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let chromium, requireJs;
try { chromium = require('playwright').chromium; requireJs = require.resolve('requirejs/require.js'); } catch (_) { /* Optional browser dependencies. */ }
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const skip = !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false;
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial;margin:0}.gp__container{height:100vh}#host{width:780px}.gpo-editor-filters{height:450px}</style>
</head><body><div class="gp__container"><button id="before">Before</button><div id="host"></div><button id="after">After</button></div>
<script src="/require.js"></script><script>
require.config({baseUrl:'/js'});
require(['util/element-creator','components/collection-dialog','components/templates/preference/targeting-editor','locales/translations'],
 (elements,collections,targeting,translations)=>{
 const create=elements.createElement;
 const host={append:child=>document.getElementById('host').append(child.getElement())};
 window.mountCollection=options=>{
  if(window.dialog)dialog.close();if(window.editor)editor.cleanup();document.getElementById('host').replaceChildren();
  options=options||{};translations.setLanguage(options.language||'en');
  const kv=options.kv;const values=options.values||['a','b','c','d'];
  window.dialog=collections.open(host,{parameter:{id:'items',label:'Items',kind:'list',collection:{mode:kv?'key_value':'list',unique_keys:false}},
   value:{kind:kv?'key_value_list':'text_list',value:kv?values.map(value=>({key:value,value:'value-'+value})):values},
   readOnly:!!options.readonly,onAccept:value=>window.accepted=value});
 };
 function field(id,kind,value){return {id,label:id,editable:true,value:{kind,value}};}
 function common(){return [field('filter.bool','filter_combine','and'),field('filter.not','boolean',false)];}
 function file(path){return common().concat(field('filter.path','text',path));}
 function control(field,blocked){
  const input=create('input',{attrs:{type:'text',disabled:blocked?'disabled':null}});input.getElement().value=field.value.value||'';
  const wrapper=create('label',{attrs:{'data-field-id':field.id},children:[input]});
  return {id:field.id,element:wrapper,read:()=>({kind:field.value.kind,value:input.getElement().value}),setError:()=>{},focus:()=>input.getElement().focus()};
 }
 window.mountTargeting=options=>{
  if(window.dialog){dialog.close();window.dialog=null;}if(window.editor)editor.cleanup();document.getElementById('host').replaceChildren();
  options=options||{};translations.setLanguage(options.language||'en');
  const kinds=[{kind:'collection',label:'Collection',supports_children:true,fields:common()},{kind:'file',label:'File match',fields:file('')}];
  const filters=[{path:[0],kind:'collection',label:'Collection',supports_children:true},
   ...['first','middle','last'].map((name,index)=>({path:[0,index],kind:'file',label:'File match',detail:name,supports_children:false})),
   {path:[1],kind:'file',label:'File match',detail:'root',supports_children:false}];
  const filter_fields=filters.map(entry=>({path:entry.path,available:true,fields:entry.kind==='collection'?common():file(entry.detail)}));
  window.formState={busy:!!options.busy};
  window.editor=targeting.render({showResult:{filters:options.empty?[]:filters,filter_fields:options.empty?[]:filter_fields,filter_kinds:kinds},
   formState,readonly:!!options.readonly,language:options.language||'en',scope:'computer',fieldControl:control,
   pt:key=>translations.t('preferences.'+key),validationMessage:key=>key});
  host.append(editor);
 };
 window.ready=true;
});</script></body></html>`;

async function fixture(run) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        const file = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try { response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript'); response.end(fs.readFileSync(file)); }
        catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        try { await run(page); }
        catch (error) { error.message += '; browser errors: ' + errors.join('; '); throw error; }
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const collectionRows = page => page.locator('[data-collection-row]');
const cell = (page, index, field = 'value') => collectionRows(page).nth(index).locator('[data-collection-field="' + field + '"]');
const targetRows = page => page.locator('[data-targeting-id]');
const focused = locator => locator.evaluate(node => node === document.activeElement);
const selectedTarget = page => page.locator('[data-targeting-id].active');

for (const language of ['en', 'ru']) {
    test('Collection deletion retains previous/next/empty focus with a single Tab entry (' + language + ')', { skip }, async () => fixture(async page => {
        await page.evaluate(language => mountCollection({ language }), language);
        const table = page.locator('.gpo-collection-table');
        assert.equal(await table.getAttribute('tabindex'), '-1');
        assert.equal(await table.locator('[tabindex="0"]').count(), 1);
        assert.equal(await table.locator('button[tabindex="0"]').count(), 0);
        await cell(page, 2).click();
        await cell(page, 2).press('Delete');
        assert.equal(await collectionRows(page).count(), 3);
        assert.equal(await collectionRows(page).locator('.active').count(), 0);
        assert.equal(await page.locator('[data-collection-row].active').textContent().then(value => value.includes('b')), true);
        assert.equal(await focused(cell(page, 1)), true);
        await cell(page, 1).press('Delete'); assert.equal(await focused(cell(page, 0)), true);
        await cell(page, 0).press('Delete'); assert.equal(await cell(page, 0).textContent(), 'd');
        assert.equal(await focused(cell(page, 0)), true);
        await cell(page, 0).press('Delete');
        assert.equal(await collectionRows(page).count(), 0);
        assert.equal(await table.getAttribute('tabindex'), '0');
        assert.equal(await focused(table), true);
        await table.press('Tab'); assert.equal(await focused(page.locator('.gpo-collection-dialog .btn-cancel')), true);
    }));

    test('Targeting visible traversal, operand activation and sibling/parent deletion stay local (' + language + ')', { skip }, async () => fixture(async page => {
        await page.evaluate(language => mountTargeting({ language }), language);
        await targetRows(page).first().focus();
        assert.equal(await selectedTarget(page).getAttribute('aria-level'), '1');
        assert.equal(await page.locator('.gpo-editor-filters__tree [tabindex="0"]').count(), 1);
        await targetRows(page).first().press('ArrowLeft');
        assert.equal(await targetRows(page).count(), 2);
        await targetRows(page).first().press('ArrowDown');
        assert.equal(await selectedTarget(page).getAttribute('aria-level'), '1');
        await selectedTarget(page).press('Home');
        await selectedTarget(page).press('ArrowRight'); assert.equal(await targetRows(page).count(), 5);
        await selectedTarget(page).press('ArrowRight');
        assert.equal(await selectedTarget(page).getAttribute('aria-level'), '2');
        await selectedTarget(page).press('ArrowDown');
        assert.equal(await page.locator('.gpo-editor-filters__fields [data-field-id="filter.path"] input').inputValue(), 'middle');
        await selectedTarget(page).press('Enter');
        assert.equal(await page.locator('.gpo-editor-filters__fields').evaluate(node => node.contains(document.activeElement)), true);
        await page.keyboard.press('Delete'); assert.equal(await targetRows(page).count(), 5);
        await selectedTarget(page).focus(); await selectedTarget(page).press('Delete');
        assert.equal(await targetRows(page).count(), 4);
        assert.equal(await page.locator('.gpo-editor-filters__fields [data-field-id="filter.path"] input').inputValue(), 'first');
        assert.equal(await focused(selectedTarget(page)), true);
        await selectedTarget(page).press('Delete');
        assert.equal(await page.locator('.gpo-editor-filters__fields [data-field-id="filter.path"] input').inputValue(), 'last');
        await selectedTarget(page).press('Delete');
        assert.equal(await selectedTarget(page).getAttribute('aria-level'), '1');
        assert.equal(await targetRows(page).count(), 2);
        await selectedTarget(page).press('Tab'); assert.equal(await focused(page.locator('#after')), true);
        assert.equal(await page.evaluate(() => formState.dirty), undefined);
        assert.equal(await page.evaluate(() => formState.acceptFilterDraft()), true);
        const operations = await page.evaluate(() => formState.readFilterResult().operations);
        assert.equal(operations.filter(operation => operation.op === 'remove').length, 3);
    }));
}

test('Filtered collection deletion follows visible order; keyboard paging and toolbar keys do not mutate', { skip }, async () => fixture(async page => {
    const values = Array.from({ length: 25 }, (_, index) => [1, 8, 15].includes(index) ? 'match-' + index : 'other-' + index);
    await page.evaluate(values => mountCollection({ values }), values);
    await page.locator('.gpo-collection-editor input[type="search"]').fill('match');
    await cell(page, 1).click(); await cell(page, 1).press('Delete');
    assert.equal(await focused(cell(page, 0)), true);
    assert.equal(await cell(page, 0).textContent(), 'match-1');
    await cell(page, 0).press('End'); assert.equal(await focused(cell(page, 1)), true);
    await cell(page, 1).press('Home'); assert.equal(await focused(cell(page, 0)), true);
    await cell(page, 0).press('PageDown'); assert.equal(await focused(cell(page, 1)), true);
    await page.locator('[data-collection-remove]').press('Delete'); assert.equal(await collectionRows(page).count(), 2);
    await page.locator('.gpo-collection-editor input[type="search"]').fill('');
    assert.equal(await collectionRows(page).count(), 24);
}));

test('Key–Value cell navigation preserves native editing, Tab commit and append selection reset', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mountCollection({ kv: true }));
    await cell(page, 0, 'key').click(); await cell(page, 0, 'key').press('ArrowRight');
    assert.equal(await focused(cell(page, 0, 'value')), true);
    await cell(page, 0, 'value').press('Enter');
    const input = page.locator('[data-collection-input]');
    await input.fill('edited'); await input.press('Delete');
    assert.equal(await collectionRows(page).count(), 4);
    await input.press('Tab');
    assert.equal(await input.getAttribute('data-collection-input'), 'key');
    assert.equal(await input.inputValue(), 'b');
    await input.press('Escape'); assert.equal(await focused(cell(page, 1, 'key')), true);
    await cell(page, 1, 'key').press('Tab');
    assert.equal(await focused(page.locator('.gpo-collection-dialog .btn-cancel')), true);
    await page.locator('[data-collection-add]').click();
    assert.equal(await collectionRows(page).count(), 5);
    assert.equal(await page.locator('[data-collection-row].active').count(), 0);
    assert.equal(await page.locator('[data-collection-remove]').isDisabled(), true);
    assert.equal(await focused(page.locator('[data-collection-input]')), true);
}));

test('Readonly and busy nested editors never mutate; collapsed descendant selection recovers to its parent', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mountCollection({ readonly: true }));
    await cell(page, 0).click(); await cell(page, 0).press('Delete'); await cell(page, 0).press('F2');
    assert.equal(await collectionRows(page).count(), 4);
    assert.equal(await page.locator('[data-collection-input]').count(), 0);
    await cell(page, 0).press('ArrowDown'); assert.equal(await focused(cell(page, 1)), true);
    await page.evaluate(() => mountTargeting({ readonly: true }));
    await targetRows(page).nth(2).click(); await selectedTarget(page).press('Delete'); await selectedTarget(page).press('Enter');
    assert.equal(await targetRows(page).count(), 5);
    await selectedTarget(page).press('ArrowDown'); assert.equal(await selectedTarget(page).getAttribute('aria-level'), '2');
    await targetRows(page).first().locator('.gpo-editor-filter-arrow').click();
    assert.equal(await targetRows(page).count(), 2);
    assert.equal(await selectedTarget(page).getAttribute('aria-level'), '1');
    assert.equal(await page.locator('.gpo-editor-filters__tree [tabindex="0"]').count(), 1);
    await page.evaluate(() => { formState.busy = true; });
    const id = await selectedTarget(page).getAttribute('data-targeting-id');
    await selectedTarget(page).press('ArrowDown'); await selectedTarget(page).press('Delete');
    assert.equal(await selectedTarget(page).getAttribute('data-targeting-id'), id);
    assert.equal(await targetRows(page).count(), 2);
}));
