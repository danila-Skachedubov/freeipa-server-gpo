'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

let chromium;
let requireJs;
try {
    chromium = require('playwright').chromium;
    requireJs = require.resolve('requirejs/require.js');
} catch (_) { /* Optional browser dependencies. */ }

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const skip = !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false;
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636;margin:0}.gp__container{height:100vh;min-width:0}#header{padding:12px}#workspace{height:calc(100vh - 50px)}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace"></main></div>
<script src="/require.js"></script><script>
window.calls=[];window.writes=[];window.dragEvents=[];
for(const name of ['dragstart','dragover','drop','dragend'])document.addEventListener(name,event=>dragEvents.push({name,target:event.target.className,y:event.clientY}),true);
function field(id,label,kind,value,required=false){return {id,label,value:{kind,value},editable:true,required};}
function commonFields(){return [field('filter.bool','Operator','filter_combine','and'),field('filter.not','Not','boolean',false)];}
function fileFields(value){return commonFields().concat(field('filter.path','Path','text',value,true));}
function detail(options={}){
 const item={identity:['files','opaque-item'],label:'Example file',has_filters:!options.empty};
 const fields=[field('properties.action','Action','action','update'),field('properties.fromPath','Source','text','source.txt'),field('metadata.desc','Description','text','Example')];
 const filter_kinds=[{kind:'collection',label:'Collection',supports_children:true,fields:commonFields()},
  {kind:'file',label:'File match',supports_children:false,fields:fileFields('')}];
 if(options.filterKinds)filter_kinds.splice(0,filter_kinds.length,...options.filterKinds);
 const filters=options.empty?[]:[
  {path:[0],kind:'collection',label:'Primary Collection',supports_children:true,child_count:1},
  {path:[0,0],kind:'file',label:'File match',detail:'alpha.cmd',supports_children:false,child_count:0},
  {path:[1],kind:'collection',label:'Other Collection',supports_children:true,child_count:1},
  {path:[1,0],kind:null,element_name:'VendorMatcher',label:'Vendor Matcher',supports_children:false,child_count:0},
  {path:[2],kind:'file',label:'File match',detail:'root.cmd',supports_children:false,child_count:0}];
 const filter_fields=options.empty?[]:[
  {path:[0],fields:commonFields(),available:true},
  {path:[0,0],fields:fileFields('alpha.cmd'),available:true},
  {path:[1],fields:commonFields(),available:true},
  {path:[1,0],fields:[],available:false,error_category:'unsupported'},
  {path:[2],fields:fileFields('root.cmd'),available:true}];
 if(options.negatedRoot){filters[4].negate=true;filter_fields[4].fields.find(field=>field.id==='filter.not').value.value=true;}
 if(options.large){
  filters.length=0;filter_fields.length=0;
  for(let i=0;i<30;i++){filters.push({path:[i],kind:'file',label:'File match',detail:'file-'+i+'.cmd',supports_children:false});filter_fields.push({path:[i],fields:fileFields('file-'+i+'.cmd'),available:true});}
 }
 return {item,fields,new_item_fields:fields,filters,filter_fields,filter_kinds,parent_candidates:[{identity:null,label:'Root',depth:0}]};
}
define('util/API',[],()=>({
 preferenceItems:async(scope,kind)=>{calls.push({method:'list',scope,kind});return {items:[structuredClone(source.item)]};},
 preferenceShow:async(scope,kind,identity)=>{calls.push({method:'show',scope,kind,identity});const result=structuredClone(source);if(identity==null)result.item=null;return result;},
 preferenceCreate:async(scope,kind,request)=>{writes.push({method:'create',scope,kind,request:structuredClone(request)});return {item:source.item,publication:{changed:true}};},
 preferenceUpdate:async(scope,kind,request)=>{writes.push({method:'update',scope,kind,request:structuredClone(request)});return {item:source.item,publication:{changed:true}};},
 reconcile:async()=>({})
}));
require.config({baseUrl:'/js'});
require(['util/element-creator','components/templates/preference/preferences-view-template','locales/translations'],(elements,template,translations)=>{
 const header=elements.createElement('div',{children:[elements.createElement('div',{className:'gp__control',children:[
  elements.createElement('button',{className:['button','preferences__btn-create'],attrs:{type:'button'},text:'Add'}),
  elements.createElement('button',{className:['button','preferences__btn-edit'],attrs:{type:'button'},text:'Edit'}),
  elements.createElement('button',{className:['button','preferences__btn-delete'],attrs:{type:'button'},text:'Remove'})]}),
  elements.createElement('div',{className:'gp__control-actions'})]});
 document.getElementById('header').append(header.getElement());
 window.render=async(options={})=>{
  if(window.view)view.cleanup();translations.setLanguage(options.language||'en');
  window.source=detail(options);calls=[];writes=[];
  window.view=await template.renderPreferencesTemplate({item:{scope:options.scope||'computer',preferenceKind:'files',document:{editable:!options.readonly,label:'Files'}},header,isCurrent:()=>true});
  document.getElementById('workspace').replaceChildren(view.getElement());
 };
 render().then(()=>window.ready=true);
});
</script></body></html>`;

async function fixture(run) {
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
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready, null, { timeout: 10000 });
        try { await run(page); }
        catch (error) {
            error.message += '\nBrowser errors: ' + errors.join('; ') + '; drag events: ' + JSON.stringify(await page.evaluate(() => dragEvents.slice(-12))) + '; targeting state: ' + JSON.stringify(await page.evaluate(() => {
                const modal = document.querySelector('.targetting__modal');
                return modal ? { className: modal.className, text: modal.textContent, tree: Array.from(modal.querySelectorAll('[data-targeting-id]')).map(row => ({ id: row.dataset.targetingId, level: row.getAttribute('aria-level'), text: row.textContent })) } : null;
            }));
            throw error;
        }
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const parentForm = page => page.locator('.gpo-editor-preference-form.active');
const targeting = page => page.locator('.targetting__modal.active');
const rows = page => targeting(page).locator('[data-targeting-id]');
const pathInput = page => targeting(page).locator('[data-field-id="filter.path"] input');
const labels = page => rows(page).locator('.gpo-editor-filter-label > span:first-child').allTextContents();
const levels = page => rows(page).evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('aria-level'))));
const writeCount = page => page.evaluate(() => writes.length);
async function openParent(page, creating = false) {
    if (creating) await page.locator('.preferences__btn-create').click();
    else await page.locator('.gpo-editor-preferences__table tbody tr').first().dblclick();
    await parentForm(page).waitFor();
}
async function openTargeting(page) {
    const form = parentForm(page);
    await form.locator('.preference__tab-button[data-tab="tab-general"]').click();
    await form.locator('.preference__tab-targetting-btn').click();
    await targeting(page).waitFor();
    await targeting(page).locator('.preference__modal-footer > button').last().hover();
}
async function addFile(page, value) {
    await targeting(page).locator('.gpo-editor-filter-add').click();
    await targeting(page).getByRole('menuitem', { name: 'File match', exact: true }).click();
    if (value !== undefined) await pathInput(page).fill(value);
}
async function drag(page, sourceIndex, targetIndex, position = 'inside') {
    const target = rows(page).nth(targetIndex);
    const bounds = await target.boundingBox();
    await rows(page).nth(sourceIndex).locator('.gpo-editor-filter-handle').dragTo(target, {
        targetPosition: { x: Math.min(140, bounds.width - 5), y: position === 'before' ? 2 : position === 'after' ? bounds.height - 2 : bounds.height / 2 }
    });
}

test('Targeting supports repeated nested adds, validation and removal before one parent Save', { skip }, async () => fixture(async page => {
    await page.evaluate(() => render({ empty: true }));
    await openParent(page); await openTargeting(page);
    assert.equal(await parentForm(page).evaluate(form => form.inert), true);
    assert.equal(await rows(page).count(), 0);
    assert.equal(await targeting(page).getByText('Use Create Item or Add Collection to begin.', { exact: true }).isVisible(), true);
    await targeting(page).locator('.gpo-editor-filter-add').click();
    await targeting(page).getByRole('menuitem', { name: 'File match', exact: true }).press('Escape');
    assert.equal(await targeting(page).isVisible(), true);
    assert.equal(await targeting(page).getByRole('menu').isVisible(), false);
    await targeting(page).getByRole('button', { name: 'Add Collection', exact: true }).click();
    await targeting(page).getByRole('button', { name: 'Add Collection', exact: true }).click();
    await addFile(page);
    assert.deepEqual(await levels(page), [1, 2, 3]);
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await targeting(page).isVisible(), true);
    assert.equal(await targeting(page).getByText('This field is required.', { exact: true }).isVisible(), true);
    assert.equal(await rows(page).filter({ has: page.locator('.gpo-editor-filter-label') }).count(), 3);
    assert.equal(await pathInput(page).evaluate(input => input === document.activeElement), true);
    await pathInput(page).fill('one.cmd');
    await addFile(page, 'two.cmd');
    assert.equal(await rows(page).nth(2).locator('.gpo-editor-filter-detail').textContent(), 'one.cmd');
    await addFile(page); // Invalid temporary node is removed without ever reaching persistence.
    await targeting(page).getByRole('button', { name: 'Remove filter', exact: true }).click();
    assert.equal(await rows(page).count(), 4);
    assert.deepEqual(await levels(page), [1, 2, 3, 3]);
    assert.equal(await writeCount(page), 0);
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    await targeting(page).waitFor({ state: 'hidden' });
    assert.equal(await writeCount(page), 0);
    await openTargeting(page);
    assert.equal(await rows(page).count(), 4);
    await targeting(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await parentForm(page).evaluate(form => form.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('preference__tab-targetting-btn')), true);
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const write = await page.evaluate(() => writes[0]);
    assert.equal(write.method, 'update');
    assert.deepEqual(write.request.identity, ['files', 'opaque-item']);
    assert.deepEqual(write.request.filters.map(operation => operation.op), ['insert', 'insert', 'insert', 'insert']);
    assert.deepEqual(write.request.filters.map(operation => operation.collection_path), [[], [0], [0, 0], [0, 0]]);
    assert.deepEqual(write.request.filters.slice(2).map(operation => operation.fields.find(field => field.id === 'filter.path').value.value), ['one.cmd', 'two.cmd']);
}));

test('Handle-only D&D moves collections and opaque filters, rejects cycles and supports keyboard movement', { skip }, async () => fixture(async page => {
    await openParent(page); await openTargeting(page);
    await rows(page).nth(1).click();
    if (process.env.TARGETING_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TARGETING_SCREENSHOT_DIR, 'gpo-targeting-en.png'), animations: 'disabled' });
    assert.equal(await targeting(page).locator('[draggable="true"]:not(.gpo-editor-filter-handle)').count(), 0);
    assert.deepEqual(await levels(page), [1, 2, 1, 2, 1]);
    await drag(page, 0, 2); // Entire primary collection moves into the other one.
    assert.deepEqual(await labels(page), ['Other Collection', 'Vendor Matcher', 'AND Primary Collection', 'File match', 'AND File match']);
    assert.deepEqual(await levels(page), [1, 2, 2, 3, 1]);
    const before = await rows(page).allTextContents();
    await drag(page, 0, 2); // A collection cannot become its own descendant.
    assert.deepEqual(await rows(page).allTextContents(), before);
    const cycleRejected = await page.evaluate(() => {
        const treeRows = document.querySelectorAll('.targetting__modal.active [data-targeting-id]');
        const source = treeRows[0].querySelector('.gpo-editor-filter-handle');
        const target = treeRows[2];
        const box = target.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: box.top + box.height / 2 }));
        const rejected = target.classList.contains('targeting-drop-invalid');
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: box.top + box.height / 2 }));
        return rejected;
    });
    assert.equal(cycleRejected, true);
    assert.equal(await targeting(page).getByText('An item cannot be moved into itself or its descendants.', { exact: true }).isVisible(), true);
    await rows(page).nth(1).click();
    assert.equal(await targeting(page).getByText("This item's fields are not supported. Its data is preserved when moved.", { exact: true }).isVisible(), true);
    assert.equal(await targeting(page).getByRole('button', { name: 'Move', exact: true }).count(), 0);
    await rows(page).nth(1).press('Control+ArrowLeft'); // Outdent the opaque filter without a Move panel.
    await rows(page).nth(3).press('Control+ArrowUp'); // Place it first at root.
    assert.deepEqual(await levels(page), [1, 1, 2, 3, 1]);
    assert.equal(await labels(page).then(values => values[0]), 'Vendor Matcher');
    await rows(page).nth(4).locator('.gpo-editor-filter-handle').press('Control+ArrowUp');
    assert.deepEqual(await labels(page), ['Vendor Matcher', 'AND File match', 'AND Other Collection', 'Primary Collection', 'File match']);
    assert.equal(await writeCount(page), 0);
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const operations = await page.evaluate(() => writes[0].request.filters);
    assert.ok(operations.length > 0);
    assert.ok(operations.every(operation => operation.op === 'move'));
    assert.equal(operations.some(operation => operation.op === 'insert' || operation.fields), false);
}));

test('Targeting Cancel discards only modal edits while accepted targeting remains local until parent Save', { skip }, async () => fixture(async page => {
    await openParent(page); await openTargeting(page);
    const modal = targeting(page);
    await modal.locator('.preference__modal-footer .btn-ok').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.targetting__modal.active') !== null), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.targetting__modal.active') !== null), true);
    const original = await rows(page).allTextContents();
    await rows(page).nth(1).click(); await pathInput(page).fill('discarded.cmd');
    await targeting(page).getByRole('button', { name: 'Add Collection', exact: true }).click();
    await targeting(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => view.hasUnsavedChanges()), false);
    await openTargeting(page); assert.deepEqual(await rows(page).allTextContents(), original);
    await rows(page).nth(1).click(); await pathInput(page).fill('accepted.cmd');
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await page.evaluate(() => view.hasUnsavedChanges()), true);
    await openTargeting(page); await rows(page).nth(1).click();
    assert.equal(await pathInput(page).inputValue(), 'accepted.cmd');
    await pathInput(page).fill('discard-again.cmd');
    await targeting(page).press('Escape');
    await openTargeting(page); await rows(page).nth(1).click();
    assert.equal(await pathInput(page).inputValue(), 'accepted.cmd');
    await targeting(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await writeCount(page), 0);
    await parentForm(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'No', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const filters = await page.evaluate(() => writes[0].request.filters);
    assert.deepEqual(filters, [{ op: 'edit', path: [0, 0], fields: [{ id: 'filter.path', value: { kind: 'text', value: 'accepted.cmd' } }] }]);
}));

test('Dragging an unselected condition does not copy the selected condition fields into it', { skip }, async () => fixture(async page => {
    await openParent(page); await openTargeting(page);
    await rows(page).nth(1).click();
    assert.equal(await pathInput(page).inputValue(), 'alpha.cmd');
    await drag(page, 4, 0);
    assert.deepEqual(await levels(page), [1, 2, 2, 1, 2]);
    await rows(page).nth(2).click();
    assert.equal(await pathInput(page).inputValue(), 'root.cmd');
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const operations = await page.evaluate(() => writes[0].request.filters);
    assert.ok(operations.every(operation => operation.op === 'move'));
}));

test('First siblings hide combine prefixes at every depth without rewriting imported operators or locking NOT', { skip }, async () => fixture(async page => {
    for (const language of ['en', 'ru']) {
        await page.evaluate(language => render({ language }), language);
        await page.evaluate(() => {
            const firstLeaf = source.filters[1];
            const firstLeafFields = source.filter_fields[1];
            source.filters.splice(1, 1,
                { path: [0, 0], kind: 'collection', label: 'Nested Collection', supports_children: true, child_count: 1 },
                { ...firstLeaf, path: [0, 0, 0] },
                { path: [0, 1], kind: 'file', label: 'File match', detail: 'second.cmd', supports_children: false, child_count: 0 });
            source.filter_fields.splice(1, 1,
                { path: [0, 0], fields: commonFields(), available: true },
                { ...firstLeafFields, path: [0, 0, 0] },
                { path: [0, 1], fields: fileFields('second.cmd'), available: true });
            for (const index of [0, 1, 2]) {
                source.filter_fields[index].fields.find(field => field.id === 'filter.bool').value = {
                    kind: 'filter_combine', value: 'or', preserved: { imported: index }
                };
            }
            for (const index of [0, 2]) source.filter_fields[index].fields.find(field => field.id === 'filter.not').value.value = true;
            source.filters[5].combine = 'or'; source.filters[5].negate = true;
        });
        await openParent(page); await openTargeting(page);
        const modal = targeting(page);
        const combine = modal.locator('[data-field-id="filter.bool"] select');
        const negate = modal.locator('[data-field-id="filter.not"] input');
        const and = language === 'ru' ? 'И' : 'AND';
        const not = language === 'ru' ? 'НЕ' : 'NOT';
        const file = language === 'ru' ? 'Соответствие файлов' : 'File match';
        assert.deepEqual(await labels(page), [not + ' Primary Collection', 'Nested Collection', not + ' ' + file,
            and + ' ' + file, and + ' Other Collection', not + ' Vendor Matcher', and + ' ' + file]);
        for (const index of [0, 1, 2]) {
            await rows(page).nth(index).click();
            assert.equal(await combine.isDisabled(), true);
            assert.equal(await combine.inputValue(), 'or');
            assert.equal(await negate.isEnabled(), true);
        }
        await rows(page).nth(1).click();
        await negate.check();
        assert.equal((await labels(page))[1], not + ' Nested Collection');
        await negate.uncheck();
        await combine.evaluate(select => { select.value = 'and'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await rows(page).nth(3).click();
        assert.equal(await combine.isEnabled(), true);
        await rows(page).nth(1).click();
        assert.equal(await combine.inputValue(), 'or');
        await modal.locator('.preference__modal-footer .btn-ok').click();
        assert.equal(await page.evaluate(() => view.hasUnsavedChanges()), false);
        await parentForm(page).locator('.preference__modal-footer .btn-ok').click();
        await parentForm(page).waitFor({ state: 'hidden' });
        assert.equal(await writeCount(page), 0);
    }
}));

test('Root and nested reorder transfer the first-sibling role while only explicit NOT edits are published', { skip }, async () => fixture(async page => {
    await page.evaluate(() => {
        source.filter_fields.filter(entry => entry.available).forEach(entry => {
            entry.fields.find(field => field.id === 'filter.bool').value = {
                kind: 'filter_combine', value: 'or', preserved: { path: entry.path }
            };
        });
    });
    await openParent(page); await openTargeting(page);
    const modal = targeting(page);
    const combine = modal.locator('[data-field-id="filter.bool"] select');
    const negate = modal.locator('[data-field-id="filter.not"] input');
    await rows(page).nth(4).click();
    assert.equal(await combine.isEnabled(), true);
    await rows(page).nth(4).press('Control+ArrowUp');
    await rows(page).nth(2).press('Control+ArrowUp');
    assert.deepEqual(await labels(page), ['File match', 'OR Primary Collection', 'File match', 'OR Other Collection', 'Vendor Matcher']);
    assert.equal(await combine.isDisabled(), true);
    assert.equal(await combine.inputValue(), 'or');
    await rows(page).nth(1).click();
    assert.equal(await combine.isEnabled(), true);
    await rows(page).nth(2).press('Control+ArrowLeft');
    assert.equal(await combine.isEnabled(), true);
    assert.equal((await labels(page))[2], 'OR File match');
    await rows(page).nth(2).press('Control+ArrowRight');
    assert.equal(await combine.isDisabled(), true);
    assert.equal((await labels(page))[2], 'File match');
    await rows(page).first().press('Control+ArrowDown');
    assert.equal(await combine.isEnabled(), true);
    await rows(page).nth(2).press('Control+ArrowRight');
    assert.deepEqual(await levels(page), [1, 2, 2, 1, 2]);
    assert.equal(await combine.isEnabled(), true);
    await rows(page).nth(2).press('Control+ArrowUp');
    assert.equal(await combine.isDisabled(), true);
    assert.equal(await combine.inputValue(), 'or');
    assert.equal(await negate.isEnabled(), true);
    await negate.check();
    assert.deepEqual(await labels(page), ['Primary Collection', 'NOT File match', 'OR File match', 'OR Other Collection', 'Vendor Matcher']);
    await rows(page).nth(2).click();
    assert.equal(await combine.isEnabled(), true);
    assert.equal(await combine.inputValue(), 'or');
    await modal.getByRole('button', { name: 'OK', exact: true }).click();
    await openTargeting(page); await rows(page).nth(1).click();
    assert.equal(await combine.isDisabled(), true);
    assert.equal(await combine.inputValue(), 'or');
    assert.equal(await negate.isChecked(), true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const operations = await page.evaluate(() => writes[0].request.filters);
    assert.ok(operations.some(operation => operation.op === 'move'));
    assert.deepEqual(operations.filter(operation => operation.op !== 'move'), [{
        op: 'edit', path: [0, 0], fields: [{ id: 'filter.not', value: { kind: 'boolean', value: true } }]
    }]);
}));

test('Native filter.bool, filter.not and filter.path drive row logic and operand summaries without stale NOT', { skip }, async () => fixture(async page => {
    await page.evaluate(() => render({ negatedRoot: true }));
    await openParent(page); await openTargeting(page);
    assert.equal((await labels(page))[4], 'AND NOT File match');
    async function editRoot() {
        await rows(page).nth(4).click();
        await targeting(page).locator('[data-field-id="filter.not"] input').uncheck();
        await targeting(page).locator('[data-field-id="filter.bool"] select').selectOption('or');
        await pathInput(page).fill('edited-root.cmd');
        await rows(page).first().click(); // Capture the selected condition before changing selection.
        assert.equal((await labels(page))[4], 'OR File match');
        assert.equal(await rows(page).nth(4).locator('.gpo-editor-filter-detail').textContent(), 'edited-root.cmd');
    }
    await editRoot();
    await targeting(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await writeCount(page), 0);
    await openTargeting(page);
    assert.equal((await labels(page))[4], 'AND NOT File match');
    assert.equal(await rows(page).nth(4).locator('.gpo-editor-filter-detail').textContent(), 'root.cmd');
    await editRoot();
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await writeCount(page), 0);
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const filters = await page.evaluate(() => writes[0].request.filters);
    assert.deepEqual(filters, [{
        op: 'edit', path: [2], fields: [
            { id: 'filter.bool', value: { kind: 'filter_combine', value: 'or' } },
            { id: 'filter.not', value: { kind: 'boolean', value: false } },
            { id: 'filter.path', value: { kind: 'text', value: 'edited-root.cmd' } }
        ]
    }]);
}));

test('Operators are toolbar-only, creation entries have icons, Remove is icon-only and keyboard nesting is reversible', { skip }, async () => fixture(async page => {
    await openParent(page); await openTargeting(page);
    const modal = targeting(page);
    await rows(page).nth(1).click();
    const fields = modal.locator('.gpo-editor-filters__fields');
    assert.equal(await fields.locator('[data-field-id="filter.bool"], [data-field-id="filter.not"], [data-field-id="filter.hidden"]').count(), 0);
    assert.equal(await modal.locator('.gpo-editor-filters__toolbar [data-field-id="filter.bool"] select').isDisabled(), true);
    assert.equal((await modal.getByRole('button', { name: 'Remove filter', exact: true }).textContent()).trim(), '');
    assert.equal(await modal.locator('.gpo-editor-filters__move').count(), 0);
    await rows(page).first().click();
    await modal.locator('.gpo-editor-filters__toolbar [data-field-id="filter.not"] input').check();
    assert.equal((await labels(page))[0], 'NOT Primary Collection');
    await modal.locator('.gpo-editor-filters__toolbar [data-field-id="filter.not"] input').uncheck();
    await modal.locator('.gpo-editor-filter-add').click();
    assert.equal(await modal.getByRole('menuitem').count(), await modal.getByRole('menuitem').locator('.gpo-editor-filter-icon[aria-hidden="true"]').count());
    await modal.getByRole('menuitem').first().press('Escape');
    await rows(page).nth(4).press('Control+ArrowRight');
    assert.deepEqual(await levels(page), [1, 2, 1, 2, 2]);
    await rows(page).nth(4).press('Control+ArrowLeft');
    assert.deepEqual(await levels(page), [1, 2, 1, 2, 1]);
    await modal.getByRole('button', { name: 'OK', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await parentForm(page).waitFor({ state: 'hidden' });
    assert.equal(await writeCount(page), 0); // A fully reversed local edit must not issue a no-op publication.
}));

test('Toolbar operators survive movement and later operand capture without restoring an old snapshot', { skip }, async () => fixture(async page => {
    await openParent(page); await openTargeting(page);
    const modal = targeting(page);
    await rows(page).nth(4).click();
    await modal.locator('[data-field-id="filter.bool"] select').selectOption('or');
    await modal.locator('[data-field-id="filter.not"] input').check();
    await rows(page).nth(4).press('Control+ArrowRight');
    await pathInput(page).fill('operator-preserved.cmd');
    await rows(page).first().click();
    assert.equal((await labels(page))[4], 'OR NOT File match');
    await modal.getByRole('button', { name: 'OK', exact: true }).click();
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const operations = await page.evaluate(() => writes[0].request.filters);
    assert.equal(operations.some(operation => operation.op === 'move'), true);
    const edit = operations.find(operation => operation.op === 'edit');
    assert.deepEqual(edit.fields.map(field => [field.id, field.value.value]), [
        ['filter.bool', 'or'], ['filter.not', true], ['filter.path', 'operator-preserved.cmd']
    ]);
}));

test('Targeting uses bounded stacked panes, visible Preferences footer and EN/RU controls, including read-only', { skip }, async () => fixture(async page => {
    for (const scenario of [{ width: 1280, height: 560, language: 'en' }, { width: 380, height: 680, language: 'ru' }]) {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await page.evaluate(language => render({ large: true, language }), scenario.language);
        await openParent(page); await openTargeting(page);
        const modal = targeting(page);
        assert.equal(await modal.getAttribute('role'), 'dialog');
        assert.equal(await modal.getAttribute('aria-modal'), 'true');
        assert.equal(await modal.getAttribute('aria-label'), scenario.language === 'ru' ? 'Редактор нацеливания' : 'Targeting Editor');
        const geometry = await modal.evaluate(element => {
            const rect = selector => {
                const box = element.querySelector(selector).getBoundingClientRect();
                return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            };
            const tree = element.querySelector('.gpo-editor-filters__tree');
            return { wrapper: rect('.preference__modal-wrapper'), toolbar: rect('.gpo-editor-filters__toolbar'), tree: rect('.gpo-editor-filters__tree'), fields: rect('.gpo-editor-filters__fields'), footer: rect('.preference__modal-footer'), scrollable: tree.scrollHeight > tree.clientHeight };
        });
        const detail = JSON.stringify(geometry);
        assert.ok(geometry.wrapper.width <= 700 && geometry.wrapper.left >= 12 && geometry.wrapper.right <= scenario.width - 12, detail);
        assert.ok(geometry.wrapper.height <= scenario.height - 78, detail);
        assert.ok(geometry.tree.bottom <= geometry.fields.top + 1 && Math.abs(geometry.tree.left - geometry.fields.left) <= 1, detail);
        assert.ok(geometry.toolbar.bottom <= geometry.tree.top + 1 && geometry.fields.bottom <= geometry.footer.top + 1, detail);
        assert.ok(geometry.footer.top >= 0 && geometry.footer.bottom <= scenario.height - 12, detail);
        assert.equal(geometry.scrollable, true, detail);
        await modal.locator('.gpo-editor-filters__tree').evaluate(tree => { tree.scrollTop = tree.scrollHeight; });
        const footerAfter = await modal.locator('.preference__modal-footer').boundingBox();
        assert.ok(Math.abs(footerAfter.y - geometry.footer.top) <= 1);
        const toolbarNames = scenario.language === 'ru' ? ['Создать элемент ▾', 'Добавить коллекцию', 'Удалить фильтр'] : ['Create Item ▾', 'Add Collection', 'Remove filter'];
        for (const name of toolbarNames) assert.equal(await modal.locator('.gpo-editor-filters__toolbar').getByRole('button', { name, exact: true }).isVisible(), true);
        await rows(page).last().click();
        if (process.env.TARGETING_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TARGETING_SCREENSHOT_DIR, 'gpo-targeting-' + scenario.language + '-bounded.png'), animations: 'disabled' });
        await modal.locator('.btn-cancel').click();
        await parentForm(page).locator('.btn-cancel').click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => render({ readonly: true }));
    await openParent(page); await openTargeting(page);
    assert.equal(await targeting(page).locator('.gpo-editor-filters__toolbar button:enabled:visible').count(), 0);
    await rows(page).nth(1).click();
    assert.equal(await pathInput(page).isDisabled(), true);
    assert.equal(await targeting(page).locator('[draggable="true"]').count(), 0);
    await targeting(page).locator('.preference__modal-footer').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await writeCount(page), 0);
}));

test('New Preference targeting is drafted locally and is sent with one Create request', { skip }, async () => fixture(async page => {
    await page.evaluate(() => render({ empty: true }));
    await openParent(page, true); await openTargeting(page);
    await addFile(page, 'first.cmd'); await addFile(page, 'second.cmd');
    await targeting(page).getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await writeCount(page), 0);
    await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => writes.length === 1);
    const request = await page.evaluate(() => writes[0]);
    assert.equal(request.method, 'create');
    assert.equal(Object.prototype.hasOwnProperty.call(request.request, 'identity'), false);
    assert.deepEqual(request.request.filters.map(operation => operation.op), ['insert', 'insert']);
    assert.deepEqual(request.request.filters.map(operation => operation.index), [0, 1]);
}));

test('Short operand forms return unused space to the tree and toolbar/drag icons share centered metrics', { skip }, async () => fixture(async page => {
    await page.evaluate(() => render({ empty: true, filterKinds: [
        { kind: 'battery', label: 'Battery', fields: commonFields() },
        { kind: 'proc_mode', label: 'Processing mode', fields: commonFields().concat(
            ['synchFore', 'asynchFore', 'backRefr', 'forceRefr', 'linkTrns', 'noChg', 'rsopTrns', 'safeBoot', 'slowLink', 'verbLog', 'rsopEnbl'].map(id => field('filter.' + id, id, 'optional_boolean', null))) },
        { kind: 'collection', label: 'Collection', supports_children: true, fields: commonFields() }
    ] }));
    await openParent(page); await openTargeting(page);
    const modal = targeting(page);
    await modal.locator('.gpo-editor-filter-add').click();
    await modal.getByRole('menuitem', { name: 'Battery', exact: true }).click();
    const metrics = async () => modal.evaluate(element => {
        const box = selector => {
            const rect = element.querySelector(selector).getBoundingClientRect();
            return { x: rect.x, y: rect.y, height: rect.height, width: rect.width, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 };
        };
        return {
            layout: box('.gpo-editor-filters__layout'), tree: box('.gpo-editor-filters__tree'), fields: box('.gpo-editor-filters__fields'),
            controls: ['.gpo-editor-filter-add', '.gpo-editor-filters__toolbar > button', '.gpo-editor-filter-operator select', '.gpo-editor-filter-negation', '.gpo-editor-filter-remove'].map(box),
            trash: box('.gpo-editor-filter-remove'), trashIcon: box('.gpo-editor-filter-remove svg'),
            handle: box('.gpo-editor-filter-handle'), handleIcon: box('.gpo-editor-filter-handle svg')
        };
    });
    const short = await metrics();
    assert.equal(short.layout.height, 420);
    assert.ok(short.fields.height >= 50 && short.fields.height <= 100, JSON.stringify(short));
    assert.ok(short.tree.height >= 310, JSON.stringify(short));
    for (const control of short.controls) {
        assert.equal(control.height, 28, JSON.stringify(short));
        assert.ok(Math.abs(control.centerY - short.controls[0].centerY) <= 1, JSON.stringify(short));
    }
    for (const [container, icon] of [[short.trash, short.trashIcon], [short.handle, short.handleIcon]]) {
        assert.ok(Math.abs(container.centerX - icon.centerX) <= 1 && Math.abs(container.centerY - icon.centerY) <= 1, JSON.stringify(short));
    }
    if (process.env.TARGETING_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TARGETING_SCREENSHOT_DIR, 'gpo-targeting-content-sized-battery.png'), animations: 'disabled' });
    await modal.locator('.gpo-editor-filter-add').click();
    await modal.getByRole('menuitem', { name: 'Processing mode', exact: true }).click();
    const long = await metrics();
    assert.ok(long.fields.height <= 280 && long.tree.height >= 140, JSON.stringify(long));
    assert.equal(await modal.locator('.gpo-editor-filters__fields').evaluate(element => element.scrollHeight > element.clientHeight), true);
    await rows(page).first().click();
    assert.equal((await metrics()).fields.height, short.fields.height);
    for (const viewport of [{width:800,height:900},{width:380,height:680},{width:1280,height:560}]) {
        await page.setViewportSize(viewport);
        const sized = await metrics();
        assert.ok(Math.abs(sized.fields.y + sized.fields.height - sized.layout.y - sized.layout.height) <= 1, JSON.stringify(sized));
        assert.ok(sized.fields.height <= 110 && sized.tree.height >= 200, JSON.stringify(sized));
    }
    assert.equal(await writeCount(page), 0);
}));

test('Real native Date/Computer/Language/Terminal/IPv6 descriptors work through Preferences controls and one parent publication', { skip }, async context => {
    const probe = spawnSync('python3', ['-c', `import json,tempfile
from admix import GroupPolicyWorkspace
with tempfile.TemporaryDirectory(prefix='targeting-form-contract-') as directory:
    workspace=GroupPolicyWorkspace(directory,load_preferences=False)
    selected=('date','computer','language','terminal','ip_range')
    kinds=[dict(kind) for kind in workspace.preference_filter_kinds() if kind['kind'] in selected]
    for kind in kinds: kind['fields']=workspace.get_new_preference_filter_fields(kind['kind'])
    print(json.dumps(kinds))`], { encoding: 'utf8' });
    if (/ModuleNotFoundError/.test(probe.stderr || '')) return context.skip('Optional installed admix binding is unavailable.');
    assert.equal(probe.status, 0, probe.stderr);
    const filterKinds = JSON.parse(probe.stdout);
    await fixture(async page => {
        await page.evaluate(filterKinds => render({ empty: true, scope: 'user', filterKinds }), filterKinds);
        await openParent(page); await openTargeting(page);
        const modal = targeting(page);
        async function addKind(kind) {
            await modal.locator('.gpo-editor-filter-add').click();
            await modal.locator('[role="menuitem"][data-kind="' + kind + '"]').click();
        }
        await addKind('computer');
        await modal.locator('[data-field-id="filter.type"] select').selectOption('DNS');
        await modal.locator('[data-field-id="filter.name"] input').fill('host.example.test');
        await addKind('date');
        await modal.locator('[data-field-id="filter.period"] select').selectOption('YEARLY');
        await modal.locator('input[type="date"]').fill('2028-02-29');
        await modal.locator('[data-field-id="targeting.everyYear"] input').check();
        await modal.locator('[data-field-id="filter.month"] select').selectOption('2');
        await modal.locator('[data-calendar-day="29"]').click();
        await modal.locator('[data-calendar-day="29"]').hover();
        assert.notEqual(await modal.locator('[data-calendar-day="29"]').evaluate(button => getComputedStyle(button).color),
            await modal.locator('[data-calendar-day="29"]').evaluate(button => getComputedStyle(button).backgroundColor));
        assert.equal(await modal.locator('input[type="date"]').count(), 0);
        if (process.env.TARGETING_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TARGETING_SCREENSHOT_DIR, 'gpo-targeting-annual-calendar.png'), animations: 'disabled' });
        await addKind('language');
        assert.equal(await modal.locator('[data-field-id="filter.languageLocale"] select').inputValue(), 'en-US');
        await modal.locator('[data-field-id="filter.languageLocale"] select').selectOption('ru-RU');
        const displayName = await modal.locator('[data-field-id="filter.languageLocale"] option:checked').textContent();
        await addKind('terminal');
        await modal.locator('[data-field-id="filter.option"] select').selectOption('IP');
        for (const [id, value] of [['min', '10.0.0.1'], ['max', '10.0.0.9']]) {
            for (const [index, part] of value.split('.').entries()) await modal.locator('[data-field-id="filter.' + id + '"] input').nth(index).fill(part);
        }
        await addKind('ip_range');
        await modal.locator('[data-field-id="filter.useIPv6"] input').check();
        await modal.locator('[data-field-id="filter.min"] input').fill('2001:db8::beef');
        await modal.locator('[data-field-id="filter.max"] input').fill('129');
        await modal.getByRole('button', { name: 'OK', exact: true }).click();
        assert.equal(await modal.isVisible(), true);
        assert.equal(await modal.getByText('Enter a valid number.', { exact: true }).isVisible(), true);
        await modal.locator('[data-field-id="filter.max"] input').fill('64');
        if (process.env.TARGETING_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TARGETING_SCREENSHOT_DIR, 'gpo-targeting-ipv6.png'), animations: 'disabled' });
        await modal.getByRole('button', { name: 'OK', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        assert.equal(await writeCount(page), 0);
        await parentForm(page).getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => writes.length === 1);
        const operations = await page.evaluate(() => writes[0].request.filters);
        assert.deepEqual(operations.map(operation => [operation.op, operation.filter_kind]), [
            ['insert', 'computer'], ['insert', 'date'], ['insert', 'language'], ['insert', 'terminal'], ['insert', 'ip_range']
        ]);
        const value = (operation, id) => operation.fields.find(field => field.id === 'filter.' + id).value.value;
        assert.equal(value(operations[0], 'type'), 'DNS');
        assert.equal(value(operations[1], 'period'), 'YEARLY');
        assert.equal(value(operations[1], 'year'), null);
        assert.equal(value(operations[1], 'day'), 29);
        assert.equal(value(operations[1], 'month'), 2);
        assert.equal(value(operations[2], 'languageLocale'), 'ru-RU');
        assert.equal(value(operations[2], 'displayName'), displayName);
        assert.equal(value(operations[2], 'system'), true);
        assert.equal(value(operations[3], 'option'), 'IP');
        assert.equal(value(operations[3], 'value'), ''); // Inactive native-required operand is intentionally empty.
        assert.equal(value(operations[4], 'useIPv6'), true);
        assert.equal(value(operations[4], 'min'), '2001:db8::beef');
        assert.equal(value(operations[4], 'max'), '64');
        // Pass exactly the browser-produced edits to the actual native API and
        // commit only inside a fresh temporary workspace, never live SYSVOL.
        const roundtrip = spawnSync('python3', ['-c', `import json,sys,tempfile,xml.etree.ElementTree as ET
from pathlib import Path
from admix import GroupPolicyWorkspace
request=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='targeting-browser-native-') as directory:
    root=Path(directory)
    (root/'User/Preferences/IniFiles').mkdir(parents=True)
    (root/'Machine').mkdir()
    (root/'GPT.INI').write_text('[General]\\nVersion=0\\n')
    path=root/'User/Preferences/IniFiles/IniFiles.xml'
    path.write_text('<IniFiles><Ini name="Browser" uid="{11111111-1111-1111-1111-111111111111}"><Properties action="U" path="example.ini" section="Test" property="Key" value="Value"/></Ini></IniFiles>')
    workspace=GroupPolicyWorkspace(directory,state_directory=str(root/'state'),state_key='isolated-browser')
    identity=workspace.list_preference_items('user','ini_files')[0]['identity']
    for operation in request:
        workspace.insert_preference_filter('user','ini_files',identity,operation['collection_path'],operation['index'],operation['filter_kind'],operation['fields'])
    assert 'FilterIpRange' not in path.read_text()
    workspace.commit_offline()
    reopened=GroupPolicyWorkspace(directory,state_directory=str(root/'state'),state_key='isolated-browser')
    fields=reopened.get_preference_filter_fields('user','ini_files',identity,[4])
    attrs=ET.parse(path).getroot().find('Ini/Filters/FilterIpRange').attrib
    print(json.dumps({'fields':fields,'attrs':attrs,'gpt':(root/'GPT.INI').read_text()}))`], { encoding: 'utf8', input: JSON.stringify(operations), timeout: 30000 });
        assert.equal(roundtrip.status, 0, roundtrip.stderr);
        const reopened = JSON.parse(roundtrip.stdout);
        assert.equal(reopened.attrs.useIPv6, '1');
        assert.equal(reopened.attrs.min, '2001:db8::beef');
        assert.equal(reopened.attrs.max, '64');
        assert.match(reopened.gpt, /Version=65536\b/);
    });
});
