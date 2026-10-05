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
<style>body{font:12px Arial,sans-serif;color:#363636;margin:0}.gp__container{min-width:0;height:100vh}#header{padding:12px}#workspace{height:calc(100vh - 50px)}.gp__control-actions{gap:12px}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace"></main></div>
<script src="/require.js"></script><script>
window.requests=[]; window.policy=null; window.view=null;
define('util/API',[],()=>({policyShow:async()=>({policy}),policyUpdate:async(scope,id,request)=>{
 requests.push(request);
 if(window.deferSave)await new Promise(resolve=>window.finishSave=resolve);
 if(request.state)policy.state=request.state;
 (request.set_parameters||[]).forEach(update=>{policy.parameters.find(p=>p.id===update.parameter_id).value=update.value;});
 return {policy};
}}));
require.config({baseUrl:'/js'});
require(['util/element-creator','components/templates/admx-template','locales/translations'],(elements,template,translations)=>{
 window.translations=translations;
 const header=elements.createElement('div',{children:[elements.createElement('div',{className:'gp__control-actions',children:[
 elements.createElement('button',{className:['button','admx__btn-apply'],attrs:{type:'button'},text:'Apply policy'}),
 elements.createElement('button',{className:['button','admx__btn-cancel'],attrs:{type:'button'},text:'Cancel policy'})]})]});
 document.getElementById('header').append(header.getElement());
 window.show=async(mode='list',count=3,language='en',initialEntries)=>{
  if(view)view.cleanup(); translations.setLanguage(language); requests=[];
  const kv=mode==='kv'; const label=kv?(language==='ru'?'Устройства безопасности':'Security Devices'):(language==='ru'?'Пакеты':'Packages');
  const entries=initialEntries||Array.from({length:count},(_,i)=>kv?{key:['OpenSC','CryptoPro'][i]||'Device '+i,value:'C:'+String.fromCharCode(92)+'modules'+String.fromCharCode(92)+'device'+i+'.dll'}:count>3?'item-'+i:['firefox','chromium','thunderbird'][i]);
  policy={policy_id:'fixture',label,state:'enabled',comment:null,capabilities:{inspect_parameters:true,edit_parameters:true,edit_comments:false,enable:true,disable:true,clear:true},
   state_actions:{enabled:{available:true,mode:'dynamic_list_values',requires_parameters:true},disabled:{available:true,mode:'clear_list_values'},not_configured:{available:true,mode:'remove_owned_records'}},
   parameters:[{id:'items',kind:'list',label,collection:{mode:kv?'key_value':'list',unique_keys:mode!=='numbered',key_case_sensitive:false,allow_empty_values:mode!=='list',min_items:1},value:{kind:kv?'key_value_list':'text_list',value:entries}}]};
  view=await template.renderAdmxTemplate({item:{scope:'computer',policyId:'fixture'},header});
  document.getElementById('workspace').replaceChildren(view.getElement());
 };
 show().then(()=>window.ready=true);
});</script></body></html>`;

async function fixture(run) {
    const server = http.createServer((req, res) => {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
        const file = req.url === '/require.js' ? requireJs : path.join(root, req.url);
        try { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript'); res.end(fs.readFileSync(file)); }
        catch (_) { res.statusCode = 404; res.end('Missing'); }
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
            error.message += '\nDialog state: ' + JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog]')).map(node => ({ role: node.getAttribute('role'), className: node.className, inert: node.inert, box: { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height } })))) + '; page errors: ' + errors.join('; ');
            throw error;
        }
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
const rows = page => page.locator('[data-collection-row]');
const cell = (page, index, field = 'value') => rows(page).nth(index).locator('[data-collection-field="' + field + '"]');
const input = page => page.locator('[data-collection-input]');
const values = page => page.locator('[data-collection-field=value] .gpo-collection-cell__text').allTextContents();
const dirty = page => page.evaluate(() => document.querySelector('.admx__btn-apply').classList.contains('active'));
async function openList(page) { await page.getByRole('button', { name: 'Edit Packages', exact: true }).click(); await page.getByRole('dialog').waitFor(); }
async function pasteIntoEditor(page, text) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
    await input(page).press('Control+V');
}
async function compactGeometry(page, width) {
    const geometry = await page.locator('.gpo-collection-control').evaluate(control => {
        const options = control.closest('.gp__admx-options');
        const summary = control.querySelector('.gpo-collection-control__summary');
        const button = control.querySelector('.gpo-collection-control__button');
        const host = control.querySelector('.gpo-collection-control__dialog-host');
        const rect = node => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width, centerY: box.top + box.height / 2 };
        };
        const overflow = node => {
            const style = getComputedStyle(node);
            return { display: style.display, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflowX: style.overflowX, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        };
        const style = getComputedStyle(options), box = rect(options);
        return {
            control: rect(control), summary: rect(summary), button: rect(button),
            options: { left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) },
            summaryFirst: control.firstElementChild === summary,
            hostBoxes: host.getClientRects().length,
            count: overflow(control.querySelector('.gpo-collection-control__count')),
            preview: overflow(control.querySelector('.gpo-collection-control__preview'))
        };
    });
    const detail = JSON.stringify(geometry);
    assert.equal(geometry.summaryFirst, true, detail);
    assert.equal(geometry.hostBoxes, 0, detail);
    assert.ok(Math.abs(geometry.control.left - geometry.options.left) <= 1, detail);
    assert.ok(Math.abs(geometry.control.right - geometry.options.right) <= 1, detail);
    assert.ok(Math.abs(geometry.summary.left - geometry.control.left) <= 1, detail);
    assert.ok(Math.abs(geometry.button.right - geometry.control.right) <= 1, detail);
    assert.ok(Math.abs(geometry.button.left - geometry.summary.right - 12) <= 1, detail);
    assert.ok(Math.abs(geometry.button.centerY - geometry.summary.centerY) <= 1, detail);
    assert.ok(geometry.summary.width > 0 && geometry.button.width >= 80, detail);
    assert.ok(geometry.control.left >= 0 && geometry.control.right <= width + 1, detail);
    assert.equal(geometry.count.whiteSpace, 'nowrap', detail);
    assert.equal(geometry.count.textOverflow, 'ellipsis', detail);
    assert.equal(geometry.count.overflowX, 'hidden', detail);
    if (geometry.preview.display !== 'none') {
        assert.equal(geometry.preview.whiteSpace, 'nowrap', detail);
        assert.equal(geometry.preview.textOverflow, 'ellipsis', detail);
        assert.equal(geometry.preview.overflowX, 'hidden', detail);
        assert.ok(geometry.preview.clientWidth > 0 && geometry.preview.scrollWidth > geometry.preview.clientWidth, detail);
    }
    return geometry;
}
async function centeredRowGeometry(page) {
    const geometry = await rows(page).first().evaluate(row => {
        const center = node => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; };
        const index = row.querySelector('.gpo-collection-table__index');
        let indexCenter = null;
        if (index) { const range = document.createRange(); range.selectNodeContents(index); const box = range.getBoundingClientRect(); indexCenter = box.top + box.height / 2; }
        const key = row.querySelector('[data-collection-field=key] .gpo-collection-cell__text');
        return {
            rowCenter: center(row), handleCenter: center(row.querySelector('.gpo-collection-table__handle')),
            inputCenter: center(row.querySelector('[data-collection-input]')),
            indexCenter, keyCenter: key ? center(key) : null,
            alignments: Array.from(row.closest('tbody').querySelectorAll('td')).map(td => getComputedStyle(td).verticalAlign),
            keyOverflow: key ? { clientWidth: key.clientWidth, scrollWidth: key.scrollWidth, textOverflow: getComputedStyle(key).textOverflow } : null
        };
    });
    const detail = JSON.stringify(geometry);
    assert.ok(geometry.alignments.length > 0 && geometry.alignments.every(value => value === 'middle'), detail);
    for (const position of [geometry.handleCenter, geometry.inputCenter, geometry.indexCenter, geometry.keyCenter].filter(value => value !== null)) {
        assert.ok(Math.abs(position - geometry.rowCenter) <= 2, detail);
    }
    if (geometry.keyOverflow) {
        assert.equal(geometry.keyOverflow.textOverflow, 'ellipsis', detail);
        assert.ok(geometry.keyOverflow.clientWidth > 0 && geometry.keyOverflow.scrollWidth > geometry.keyOverflow.clientWidth, detail);
    }
}

test('List editor implements selection, double-click, append/remove and handle-only reorder without early persistence', { skip }, async () => fixture(async page => {
    await openList(page);
    assert.equal(await page.getByRole('button', { name: 'Paste rows', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('.gpo-collection-table__index').allTextContents(), ['0', '1', '2']);
    await cell(page, 0).click();
    assert.equal(await input(page).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).isEnabled(), true);
    await cell(page, 0).dblclick(); await input(page).fill('cancelled');
    assert.equal(await dirty(page), false);
    assert.equal(await page.evaluate(() => view.hasUnsavedChanges()), true);
    assert.equal(await page.evaluate(() => view.applyChanges()), false);
    assert.equal(await page.evaluate(() => requests.length), 0);
    await input(page).press('Escape');
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await cell(page, 0).textContent(), 'firefox');
    await cell(page, 0).press('F2'); await input(page).fill('vim'); await input(page).press('Enter');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    assert.equal(await rows(page).count(), 4);
    assert.equal(await page.locator('[data-collection-row].active').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).isDisabled(), true);
    await input(page).fill('new-package'); await input(page).press('Enter');
    await cell(page, 3).click(); await page.getByRole('button', { name: 'Remove', exact: true }).click();
    assert.deepEqual(await values(page), ['vim', 'chromium', 'thunderbird']);
    assert.equal(await page.locator('.gpo-collection-cell[draggable]').count(), 0);
    const id = await rows(page).nth(2).getAttribute('data-collection-row');
    await rows(page).nth(2).locator('.gpo-collection-table__handle').dragTo(cell(page, 0), { targetPosition: { x: 30, y: 3 } });
    assert.deepEqual(await values(page), ['thunderbird', 'vim', 'chromium']);
    assert.equal(await rows(page).first().getAttribute('data-collection-row'), id);
    await page.evaluate(() => {
        const source = document.querySelector('.gpo-collection-table__handle');
        const target = document.querySelectorAll('[data-collection-row]')[2];
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: target.getBoundingClientRect().bottom - 1 }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    });
    assert.deepEqual(await values(page), ['thunderbird', 'vim', 'chromium']);
    await rows(page).nth(1).locator('.gpo-collection-table__handle').press('Control+ArrowUp');
    assert.deepEqual(await values(page), ['vim', 'thunderbird', 'chromium']);
    assert.equal(await dirty(page), false);
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await dirty(page), true);
    assert.equal(await page.evaluate(() => requests.length), 0);
    await openList(page); assert.deepEqual(await values(page), ['vim', 'thunderbird', 'chromium']);
    assert.equal(await page.evaluate(() => view.applyChanges()), false);
    assert.equal(await page.evaluate(() => requests.length), 0);
    await cell(page, 0).dblclick(); await input(page).fill('discard-me'); await input(page).press('Enter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Yes', exact: true }).click();
    assert.equal(await dirty(page), true);
    await openList(page); assert.deepEqual(await values(page), ['vim', 'thunderbird', 'chromium']);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.evaluate(() => { window.deferSave = true; });
    await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
    await page.waitForFunction(() => requests.length === 1);
    assert.equal(await page.evaluate(() => view.getElement().inert), true);
    await assert.rejects(() => page.getByRole('button', { name: 'Edit Packages', exact: true }).click({ timeout: 250 }), /Timeout/);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate(() => { window.deferSave = false; window.finishSave(); });
    await page.waitForFunction(() => !view.getElement().inert);
    assert.deepEqual(await page.evaluate(() => requests[0].set_parameters[0].value), { kind: 'text_list', value: ['vim', 'thunderbird', 'chromium'] });
    assert.equal(await dirty(page), false);
}));

test('Key–Value editor validates cells, reuses discard confirmation and preserves drafts through policy state switches', { skip }, async () => fixture(async page => {
    await page.evaluate(() => show('kv', 2));
    await page.getByRole('button', { name: 'Edit Security Devices', exact: true }).click();
    await cell(page, 0, 'key').click(); assert.equal(await input(page).count(), 0);
    await cell(page, 0, 'key').dblclick(); await input(page).fill('CRYPTOPRO'); await input(page).press('Enter');
    assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.gpo-collection-cell__error').count(), 2);
    await cell(page, 0, 'key').dblclick(); await input(page).fill('Custom=Name: device'); await input(page).press('Enter');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    assert.equal(await input(page).inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).isDisabled(), true);
    await input(page).fill('New Device'); await input(page).press('Tab');
    assert.equal(await input(page).getAttribute('data-collection-input'), 'value');
    const longValue = 'C:\\a=path:with\\' + 'long-module-name'.repeat(100) + '.dll';
    await input(page).fill(longValue);
    assert.ok((await input(page).boundingBox()).height <= 130);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
    assert.equal(await page.getByRole('dialog').evaluate(element => element.inert), true);
    await page.getByRole('alertdialog').getByRole('button', { name: 'No', exact: true }).click();
    assert.equal(await page.getByRole('dialog').evaluate(element => element.inert), false);
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    assert.equal(await page.evaluate(() => requests.length), 0);
    await page.getByRole('radio', { name: 'Disabled', exact: true }).check();
    const edit = page.getByRole('button', { name: 'Edit Security Devices', exact: true });
    assert.equal(await edit.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'View Security Devices', exact: true }).count(), 0);
    assert.equal(await edit.evaluate(button => getComputedStyle(button).cursor), 'default');
    await edit.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('radio', { name: 'Not Configured', exact: true }).check();
    assert.equal(await edit.isDisabled(), true);
    await edit.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('radio', { name: 'Enabled', exact: true }).check();
    assert.equal(await edit.isEnabled(), true);
    await page.getByRole('button', { name: 'Edit Security Devices', exact: true }).click();
    await cell(page, 2).dblclick(); assert.equal(await input(page).inputValue(), longValue);
    await input(page).press('Escape');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
    await page.waitForFunction(() => requests.length === 1);
    assert.deepEqual(await page.evaluate(() => requests[0].set_parameters[0].value.value.map(entry => entry.key)), ['Custom=Name: device', 'CryptoPro', 'New Device']);
    assert.equal(await page.evaluate(() => requests[0].set_parameters[0].value.kind), 'key_value_list');
    assert.equal(await page.evaluate(() => requests[0].set_parameters[0].value.value[2].value), longValue);
}));

test('Large collections stay bounded, filtering retains hidden entries and EN/RU dialogs reuse Preferences styling', { skip }, async () => fixture(async page => {
    await page.evaluate(() => show('numbered', 80)); await openList(page);
    assert.ok((await page.getByRole('dialog').boundingBox()).height < 650);
    await page.getByRole('searchbox', { name: 'Search items', exact: true }).fill('item-7');
    assert.equal(await rows(page).count(), 11);
    assert.equal(await page.locator('.gpo-collection-table__index').first().textContent(), '7');
    assert.equal(await rows(page).first().locator('.gpo-collection-table__handle').isDisabled(), true);
    await cell(page, 0).dblclick(); await input(page).fill('edited'); await input(page).press('Enter');
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
    await page.waitForFunction(() => requests.length === 1);
    assert.equal(await page.evaluate(() => requests[0].set_parameters[0].value.value.length), 80);
    assert.equal(await page.evaluate(() => requests[0].set_parameters[0].value.value[7]), 'edited');
    await page.evaluate(() => show('kv', 2)); await page.getByRole('button', { name: 'Edit Security Devices', exact: true }).click();
    const mismatches = await page.evaluate(() => {
        const actual = document.querySelector('.gpo-collection-dialog'); const reference = actual.cloneNode(true);
        reference.style.left = '-2000px'; reference.classList.remove('gpo-collection-dialog');
        reference.querySelectorAll('*').forEach(node => Array.from(node.classList).filter(name => name.startsWith('gpo-collection')).forEach(name => node.classList.remove(name)));
        actual.parentNode.append(reference);
        const failures = [];
        for (const selector of ['.preference__modal-header', '.preference__modal-footer', '.btn-cancel', '.btn-ok', '.preference__table th']) {
            const a = getComputedStyle(actual.querySelector(selector)), b = getComputedStyle(reference.querySelector(selector));
            for (const key of ['backgroundColor', 'color', 'border', 'fontSize', 'height']) if (a[key] !== b[key]) failures.push(selector + '.' + key);
        }
        reference.remove(); return failures;
    });
    assert.deepEqual(mismatches, []);
    if (process.env.COLLECTION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.COLLECTION_SCREENSHOT_DIR, 'collection-kv-en.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 380, height: 680 });
    await page.evaluate(() => show('kv', 2, 'ru'));
    await page.getByRole('button', { name: 'Изменить: Устройства безопасности', exact: true }).click();
    const rect = await page.getByRole('dialog').boundingBox(); assert.ok(rect.x >= 11 && rect.x + rect.width <= 369);
    await cell(page, 0, 'key').dblclick(); await input(page).fill('CryptoPro'); await input(page).press('Enter');
    assert.equal(await page.getByText('Это имя уже используется.', { exact: true }).count(), 2);
    assert.equal(await page.getByRole('button', { name: 'ОК', exact: true }).isDisabled(), true);
    if (process.env.COLLECTION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.COLLECTION_SCREENSHOT_DIR, 'collection-kv-ru-narrow.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('alertdialog').waitFor(); await page.getByRole('alertdialog').getByRole('button', { name: 'Нет', exact: true }).click();
    await cell(page, 0, 'key').dblclick(); await input(page).fill('OpenSC'); await input(page).press('Enter');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.evaluate(() => show('list', 0, 'en')); await openList(page);
    assert.ok((await page.getByRole('dialog').boundingBox()).height < 360);
    if (process.env.COLLECTION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.COLLECTION_SCREENSHOT_DIR, 'collection-empty-narrow.png'), animations: 'disabled' });
}));

test('Registry names use native single-line inputs with duplicate ARIA and no rows from multiline paste', { skip }, async () => fixture(async page => {
    for (const mode of ['kv', 'list']) {
        await page.evaluate(mode => show(mode, mode === 'kv' ? 2 : 3), mode);
        await page.getByRole('button', { name: mode === 'kv' ? 'Edit Security Devices' : 'Edit Packages', exact: true }).click();
        const field = mode === 'kv' ? 'key' : 'value', rowCount = mode === 'kv' ? 2 : 3;
        await cell(page, 0, field).dblclick();
        assert.deepEqual(await input(page).evaluate(element => ({ tag: element.tagName, type: element.type })), { tag: 'INPUT', type: 'text' });
        await input(page).fill(mode === 'kv' ? 'CRYPTOPRO' : 'CHROMIUM');
        assert.equal(await input(page).getAttribute('aria-invalid'), 'true');
        const description = await input(page).evaluate(element => {
            const error = document.getElementById(element.getAttribute('aria-describedby'));
            return { sameCell: Boolean(error && error.parentElement === element.parentElement), text: error && error.textContent };
        });
        assert.equal(description.sameCell, true);
        assert.equal(description.text, 'This name is already used.');
        assert.equal(await page.locator('.gpo-collection-cell--invalid').count(), 2);
        assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).isDisabled(), true);
        await input(page).fill('Single line registry name');
        assert.equal(await input(page).getAttribute('aria-invalid'), null);
        assert.equal(await input(page).getAttribute('aria-describedby'), null);
        assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).isEnabled(), true);
        const height = (await input(page).boundingBox()).height;
        await input(page).press('End'); await input(page).press('Shift+Enter');
        assert.equal(await input(page).inputValue(), 'Single line registry name');
        assert.equal((await input(page).boundingBox()).height, height);
        assert.equal(await rows(page).count(), rowCount);
        await input(page).fill('');
        await pasteIntoEditor(page, 'First\r\nSecond\nThird\rLast');
        const pasted = await input(page).inputValue();
        assert.equal(/[\r\n]/.test(pasted), false);
        for (const part of ['First', 'Second', 'Third', 'Last']) assert.ok(pasted.includes(part));
        assert.equal((await input(page).boundingBox()).height, height);
        assert.equal(await rows(page).count(), rowCount);
        assert.equal(await input(page).getAttribute('aria-invalid'), null);
        await input(page).press('Enter');
        assert.equal(await cell(page, 0, field).textContent(), pasted);
        await page.getByRole('button', { name: 'OK', exact: true }).click();
        await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
        await page.waitForFunction(() => requests.length === 1);
        const saved = await page.evaluate(() => requests[0].set_parameters[0].value);
        assert.equal(saved.kind, mode === 'kv' ? 'key_value_list' : 'text_list');
        assert.equal(saved.value.length, rowCount);
        assert.equal(mode === 'kv' ? saved.value[0].key : saved.value[0], pasted);
    }
}));

test('Numbered list and Key–Value data keep multiline text in one row and preserve untouched CRLF', { skip }, async () => fixture(async page => {
    for (const mode of ['numbered', 'kv']) {
        const initial = mode === 'kv'
            ? [{ key: 'First', value: 'original\r\nvalue' }, { key: 'Second', value: 'before' }, { key: 'Third', value: 'last' }]
            : ['original\r\nvalue', 'before', 'last'];
        await page.evaluate(({ mode, initial }) => show(mode, 3, 'en', initial), { mode, initial });
        await page.getByRole('button', { name: mode === 'kv' ? 'Edit Security Devices' : 'Edit Packages', exact: true }).click();
        await cell(page, 0).dblclick();
        assert.equal(await input(page).evaluate(element => element.tagName), 'TEXTAREA');
        assert.equal(await input(page).inputValue(), 'original\nvalue');
        await input(page).press('Escape');
        await cell(page, 1).dblclick();
        assert.equal(await input(page).evaluate(element => element.tagName), 'TEXTAREA');
        await input(page).fill('line one'); await input(page).press('End'); await input(page).press('Shift+Enter');
        await input(page).pressSequentially('line two');
        assert.equal(await input(page).inputValue(), 'line one\nline two');
        assert.equal(await rows(page).count(), 3);
        await input(page).fill('');
        await pasteIntoEditor(page, 'line one\r\nline two\nline three');
        assert.equal(await input(page).inputValue(), 'line one\nline two\nline three');
        assert.equal(await rows(page).count(), 3);
        assert.equal(await page.locator('.gpo-collection-cell__error').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'OK', exact: true }).isEnabled(), true);
        await input(page).press('Enter');
        assert.equal(await cell(page, 1).textContent(), 'line one\nline two\nline three');
        await page.getByRole('button', { name: 'OK', exact: true }).click();
        await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
        await page.waitForFunction(() => requests.length === 1);
        const saved = await page.evaluate(() => requests[0].set_parameters[0].value);
        assert.equal(saved.kind, mode === 'kv' ? 'key_value_list' : 'text_list');
        assert.deepEqual(mode === 'kv' ? saved.value.map(entry => entry.value) : saved.value, ['original\r\nvalue', 'line one\nline two\nline three', 'last']);
        if (mode === 'kv') assert.deepEqual(saved.value.map(entry => entry.key), ['First', 'Second', 'Third']);
    }
}));

test('Compact summaries fill Options and expanded data centers every table cell at desktop and narrow RU widths', { skip }, async () => fixture(async page => {
    const longName = 'Registry name ' + 'long-name-'.repeat(90);
    const expanded = Array.from({ length: 5 }, (_, index) => 'Line ' + index + ': data value').join('\n');
    for (const viewport of [{ width: 1280, height: 900, language: 'en' }, { width: 380, height: 680, language: 'ru' }]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const mode of ['kv', 'numbered']) {
            const initial = mode === 'kv' ? [{ key: longName, value: 'before' }, { key: 'Second', value: 'other' }] : [longName, 'other'];
            await page.evaluate(({ mode, language, initial }) => show(mode, 2, language, initial), { mode, language: viewport.language, initial });
            const geometry = await compactGeometry(page, viewport.width);
            if (viewport.width === 1280) {
                assert.ok(geometry.control.width > 420, JSON.stringify(geometry));
                assert.notEqual(geometry.preview.display, 'none');
            } else if (mode === 'numbered') {
                assert.ok(geometry.count.scrollWidth > geometry.count.clientWidth, JSON.stringify(geometry));
            }
            const suffix = mode + '-' + viewport.language + '-' + viewport.width;
            if (process.env.COLLECTION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.COLLECTION_SCREENSHOT_DIR, 'collection-summary-' + suffix + '.png'), animations: 'disabled' });
            await page.locator('.gpo-collection-control__button').click();
            await cell(page, 0).dblclick();
            assert.equal(await input(page).evaluate(element => element.tagName), 'TEXTAREA');
            await input(page).fill('before');
            const initialHeight = (await input(page).boundingBox()).height;
            await input(page).fill(expanded);
            const editorHeight = (await input(page).boundingBox()).height;
            assert.ok(editorHeight > initialHeight + 20 && editorHeight <= 130, JSON.stringify({ initialHeight, editorHeight }));
            assert.equal(await rows(page).count(), 2);
            await centeredRowGeometry(page);
            await compactGeometry(page, viewport.width);
            const rect = await page.getByRole('dialog').boundingBox();
            assert.ok(rect.x >= 11 && rect.x + rect.width <= viewport.width - 11, JSON.stringify(rect));
            if (process.env.COLLECTION_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.COLLECTION_SCREENSHOT_DIR, 'collection-expanded-' + suffix + '.png'), animations: 'disabled' });
            await page.getByRole('dialog').locator('.btn-cancel').click();
            await page.getByRole('alertdialog').getByRole('button', { name: viewport.language === 'ru' ? 'Да' : 'Yes', exact: true }).click();
            await page.getByRole('radio', { name: viewport.language === 'ru' ? 'Отключено' : 'Disabled', exact: true }).check();
            assert.equal(await page.locator('.gpo-collection-control__button').textContent(), viewport.language === 'ru' ? 'Изменить…' : 'Edit…');
            assert.equal(await page.locator('.gpo-collection-control__button').isDisabled(), true);
            await compactGeometry(page, viewport.width);
        }
    }
}));
