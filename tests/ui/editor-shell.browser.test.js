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
} catch (_) { /* Optional browser dependencies in unit-only environments. */ }
const jquery = '/usr/share/ipa/ui/js/libs/jquery.js';
const skip = !chromium || !requireJs || !fs.existsSync(jquery)
    ? 'Set NODE_PATH and provide the installed FreeIPA jQuery for browser checks.' : false;
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');

// The production action creates the outer window. Only FreeIPA and app init are
// mocked: real gpo.js, shared dialogs, tree renderer, CSS and jQuery are served.
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;font:12px Arial,sans-serif}.modal{position:fixed;inset:0;z-index:1000}
.modal-dialog{margin:24px auto}.modal-content{background:white;border:1px solid #d1d1d1}
.modal-header{height:40px;padding:0 16px;display:flex;align-items:center;justify-content:space-between}
.modal-title{margin:0}.modal-header>.close{order:2}.modal-backdrop{position:fixed;inset:0;background:#777;opacity:.4;z-index:900}
.modal-body{overflow:auto}.fixture-controls{padding:16px;display:flex;gap:12px}
.fixture-controls>.not-visible{visibility:hidden}.fixture-controls>.not-displayed{display:none}
.fixture-tree{height:480px}.fixture-tree .tree-view{box-sizing:border-box}
</style></head><body><button id="launcher">Open editor</button><button id="background">Background action</button>
<script src="/jquery.js"></script><script src="/require.js"></script><script>
window.notifications=[];window.refreshes=0;window.initializations=[];window.mode='normal';window.nav=[];
define('freeipa/ipa',[],function(){return {action:function(spec){return {spec:spec}},notify:function(message,type){notifications.push({message:message,type:type})}}});
define('freeipa/phases',[],function(){return {on:function(){}}});
define('freeipa/reg',[],function(){return {entity:{register:function(){}},action:{register:function(){}}}});
define('freeipa/navigation',[],function(){return {}});
define('freeipa/rpc',[],function(){return {}});
define('js/app',[],function(){return {init:function(options){
    initializations.push(options);var host=document.getElementById(options.containerId);
    if(mode==='loading'){host.textContent='Loading fixture';return;}
    host.innerHTML='<div class="fixture-controls"><button id="outer-first">First action</button><input id="outer-input" aria-label="Input"><button id="outer-last">Last action</button><button id="hidden-attr" hidden>Hidden attribute</button><button id="hidden-css" class="not-displayed">Display none</button><button id="hidden-visibility" class="not-visible">Visibility hidden</button><button id="disabled-control" disabled>Disabled</button></div>';
}}});
require.config({baseUrl:'/'});
require(['gpo','js/locales/translations','js/components/editor-dialog','js/components/confirmation-dialog',
    'js/util/element-creator','js/components/tree-view/tree-view-list'],function(gpo,translations,dialogs,confirmations,elements,tree){
    window.modules={gpo:gpo,translations:translations,dialogs:dialogs,confirmations:confirmations,elements:elements,tree:tree};
    window.facet={get_selected_values:function(){return ['Example GPO']},refresh:function(){refreshes++}};
    window.openEditor=function(language,requestedMode){translations.setLanguage(language);mode=requestedMode||'normal';gpo.gpui_action({}).execute_action(facet)};
    document.getElementById('launcher').onclick=function(){openEditor(translations.getLanguage(),mode)};
    window.openNested=function(dirty){
        var create=elements.createElement;window.nestedDirty=Boolean(dirty);
        var content=create('div',{children:[create('button',{id:'nested-first',attrs:{type:'button'},text:'Nested first'}),create('input',{id:'nested-input',attrs:{'aria-label':'Nested input'}}),create('button',{id:'nested-last',attrs:{type:'button'},text:'Nested last'})]});
        window.nested=dialogs.open(elements.createElement('div'),{title:translations.t('collections.title'),content:content,isDirty:function(){return nestedDirty}});
        document.getElementById('gp__container').appendChild(nested.root.getElement().parentElement);
    };
    window.renderGeometryTree=function(){
        document.getElementById('gp__container').innerHTML='<div class="fixture-tree"><nav class="tree-view" id="geometry-tree"></nav></div>';
        window.rows={root:{type:'folder',title:'Root',icon:'ico-folder',opened:true,children:[
            {type:'folder',title:'Category A',icon:'ico-folder',opened:true,children:[
                {type:'folder',title:'Nested category',icon:'ico-folder',opened:true,children:[{type:'file',title:'Deep policy',icon:'ico-file'}]},
                {type:'file',title:'Nested policy',icon:'ico-file'}]},
            {type:'file',title:'Policy A',icon:'ico-file'},
            {type:'folder',title:'Category B',icon:'ico-folder',opened:false,children:[{type:'file',title:'Policy B',icon:'ico-file'}]}]}};
        window.treeState={selectedItem:null,registerTreeNode:function(item,info){item.fixtureInfo=info},
            navigateToNode:function(item){nav.push(item.title);this.selectedItem={item:item};tree.setTreeItemActive(item.fixtureInfo.treeItemElement);return Promise.resolve(true)},
            toggleFolder:function(item){tree.setFolderOpenedState(item.fixtureInfo.listItemElement,item,!item.opened)}};
        document.getElementById('geometry-tree').appendChild(tree.renderTreeViewList([rows.root],null,treeState).getElement());
    };
    window.ready=true;
});
</script></body></html>`;

async function fixture(run, language = 'en') {
    const server = http.createServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(html); return;
        }
        const pathname = request.url.replace(/^\/js\/plugins\/chain\//, '/');
        const filename = pathname === '/require.js' ? requireJs
            : pathname === '/jquery.js' ? jquery : path.join(root, pathname);
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css'
                : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
            response.end(fs.readFileSync(filename));
        } catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: language === 'ru' ? 'ru-RU' : 'en-US' });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        await page.evaluate(language => modules.translations.setLanguage(language), language);
        await run(page);
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const outer = page => page.locator('.modal-gpui');
const focused = locator => locator.evaluate(element => element === document.activeElement);

async function open(page, language, mode = 'normal') {
    await page.evaluate(mode => { window.mode = mode; }, mode);
    await page.locator('#launcher').click();
    await outer(page).waitFor();
    await page.waitForFunction(() => initializations.length > 0);
    assert.equal(await outer(page).getAttribute('aria-modal'), 'true');
    assert.equal(await outer(page).getAttribute('aria-labelledby'), await outer(page).locator('.modal-title').getAttribute('id'));
    assert.equal(await outer(page).locator('.modal-header .close').getAttribute('aria-label'), await page.evaluate(() => modules.translations.t('collections.close')));
    assert.equal(await modulesLanguage(page), language);
}
const modulesLanguage = page => page.evaluate(() => modules.translations.getLanguage());

for (const language of ['en', 'ru']) {
    test('Real GPUI outer action contains initial/root and first/last Tab in ' + language, { skip }, async () => fixture(async page => {
        await open(page, language);
        assert.equal(await focused(outer(page)), true, 'outer editor owns the initial focus');
        await page.keyboard.press('Tab');
        assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await focused(page.locator('#outer-last')), true, 'hidden and disabled controls do not become the wrap boundary');
        await page.keyboard.press('Tab');
        assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
        await outer(page).focus();
        await page.keyboard.press('Shift+Tab');
        assert.equal(await focused(page.locator('#outer-last')), true);
        await page.locator('#outer-first').focus();
        await page.keyboard.press('Tab');
        assert.equal(await focused(page.locator('#outer-input')), true);
        assert.equal(await page.evaluate(() => initializations[0].policyName), 'Example GPO');
        assert.equal(await page.locator('#background').evaluate(element => element === document.activeElement), false);
    }, language));

    test('Loading and failed module initialization keep the real outer dialog contained in ' + language, { skip }, async () => fixture(async page => {
        await open(page, language, 'loading');
        const close = outer(page).locator('.modal-header .close');
        await outer(page).press('Shift+Tab');
        assert.equal(await focused(close), true);
        await close.press('Tab');
        assert.equal(await focused(close), true);
        await close.click();
        await outer(page).waitFor({ state: 'detached' });
        // Return an invalid app export through the production require callback.
        await page.evaluate(() => { requirejs.undef('js/app'); define('js/app', [], function() { return {}; }); });
        await page.locator('#launcher').click();
        await page.waitForFunction(() => notifications.length === 1);
        assert.equal(await page.evaluate(() => notifications[0].message), await page.evaluate(() => modules.translations.t('gpo.gpuiInitializeFailed')));
        await outer(page).press('Tab');
        assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
    }, language));

    test('Nested real editor and discard confirmation retain exclusive Tab ownership in ' + language, { skip }, async () => fixture(async page => {
        await open(page, language);
        await page.locator('#outer-last').focus();
        await page.evaluate(() => openNested(true));
        const nested = page.locator('.gpo-editor-dialog');
        await nested.waitFor();
        await nested.press('Shift+Tab');
        assert.equal(await focused(nested.locator('.btn-ok')), true);
        await nested.locator('.btn-ok').press('Tab');
        assert.equal(await focused(nested.locator('.gpo-editor-dialog__close')), true);
        await nested.locator('.btn-cancel').click();
        const confirmation = page.locator('[role=alertdialog]');
        await confirmation.waitFor();
        await confirmation.locator('.btn-no').press('Shift+Tab');
        assert.equal(await focused(confirmation.locator('.btn-yes')), true);
        await confirmation.locator('.btn-yes').press('Tab');
        assert.equal(await focused(confirmation.locator('.btn-no')), true);
        await confirmation.locator('.btn-no').click();
        await confirmation.waitFor({ state: 'detached' });
        assert.equal(await focused(nested.locator('.btn-cancel')), true);
        await page.evaluate(() => { nestedDirty = false; });
        await nested.locator('.btn-cancel').click();
        await nested.waitFor({ state: 'detached' });
        assert.equal(await focused(page.locator('#outer-last')), true);
        await page.keyboard.press('Tab');
        assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
    }, language));
}

test('Closing the real action restores its launcher, removes keyboard ownership and safely reopens', { skip }, async () => fixture(async page => {
    await open(page, 'en');
    await page.evaluate(() => { window.retiredModal = document.querySelector('.modal-gpui'); window.retiredLast = document.getElementById('outer-last'); });
    await outer(page).locator('.modal-header .close').click();
    await outer(page).waitFor({ state: 'detached' });
    assert.equal(await focused(page.locator('#launcher')), true);
    assert.equal(await page.evaluate(() => refreshes), 1);
    await page.evaluate(() => {
        window.retiredTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        retiredLast.dispatchEvent(retiredTab);
    });
    assert.equal(await page.evaluate(() => retiredTab.defaultPrevented), false, 'the removed instance has no active trap');
    assert.equal(await focused(page.locator('#launcher')), true);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page.locator('#background')), true, 'no document-wide trap remains');
    await page.locator('#launcher').click();
    await page.waitForFunction(() => initializations.length === 2);
    assert.equal(await page.locator('.modal-gpui').count(), 1);
    assert.equal(await page.locator('.modal-gpui-backdrop').count(), 1);
    await page.locator('#outer-last').focus();
    await page.keyboard.press('Tab');
    assert.equal(await focused(outer(page).locator('.modal-header .close')), true);
    // Closing more than once cannot duplicate refresh/focus restoration.
    await outer(page).locator('.modal-header .close').evaluate(element => { element.click(); element.click(); });
    await outer(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => refreshes), 2);
    assert.equal(await focused(page.locator('#launcher')), true);
}));

async function treeMetrics(page) {
    return page.locator('#geometry-tree .tree-item').evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        const icon = element.querySelector('.icon').getBoundingClientRect();
        const arrow = element.querySelector('.icon-switcher');
        return { title: element.getAttribute('aria-label'), rect: [box.x, box.y, box.width, box.height],
            padding: style.padding, margin: style.margin, border: style.borderWidth,
            icon: [icon.x, icon.y, icon.width, icon.height],
            arrow: arrow ? [arrow.getBoundingClientRect().x, arrow.getBoundingClientRect().y] : null };
    }));
}

test('Tree selection/focus outsets preserve geometry and leave expansion arrows inset', { skip }, async () => fixture(async page => {
    await open(page, 'en');
    await page.evaluate(() => renderGeometryTree());
    // Geometry is measured after the production outer window's entrance
    // transform, not halfway through its 0.5s opening animation.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal-gpui .modal-dialog')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
    const before = await treeMetrics(page);
    const viewport = await page.locator('#geometry-tree').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert.equal(viewport.scrollWidth, viewport.clientWidth, 'the paint gutter must not create a horizontal scrollbar for short labels');
    const byTitle = title => page.getByRole('treeitem', { name: title, exact: true });
    await byTitle('Category A').click();
    await byTitle('Category A').focus();
    assert.deepEqual(await treeMetrics(page), before, 'selection does not change heights, padding, margins, border or icon positions');
    const selected = await byTitle('Category A').evaluate(element => {
        const style = getComputedStyle(element), pseudo = getComputedStyle(element, '::before');
        const box = element.getBoundingClientRect(), arrow = element.querySelector('.icon-switcher').getBoundingClientRect();
        return { rowShadow: style.boxShadow, rowOutline: style.outlineStyle, pseudoPosition: pseudo.position,
            pseudoContent: pseudo.content, pointerEvents: pseudo.pointerEvents, left: pseudo.left, right: pseudo.right,
            top: pseudo.top, bottom: pseudo.bottom, background: pseudo.backgroundColor,
            arrowInset: arrow.left - box.left - parseFloat(pseudo.left) };
    });
    assert.equal(selected.rowShadow, 'none', 'tree-only stripe is removed');
    assert.equal(selected.rowOutline, 'none', 'focus paint does not remain on the narrower row box');
    assert.equal(selected.pseudoPosition, 'absolute');
    assert.notEqual(selected.pseudoContent, 'none');
    assert.equal(selected.pointerEvents, 'none');
    assert.ok(parseFloat(selected.left) < 0 && parseFloat(selected.right) < 0);
    assert.ok(parseFloat(selected.top) < 0 && parseFloat(selected.bottom) < 0);
    assert.ok(selected.arrowInset > 0, 'an expandable category has paint before its arrow');
    assert.notEqual(selected.background, 'rgba(0, 0, 0, 0)');
    const paintCoordinates = await byTitle('Category A').evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: [box.left - 2, box.top + box.height / 2], right: [box.right + 2, box.top + box.height / 2] };
    });
    const screenshot = await page.screenshot();
    const paintPixels = await page.evaluate(async ({ png, coordinates }) => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return Object.fromEntries(Object.entries(coordinates).map(([side, [x, y]]) => [side, Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data)]));
    }, { png: screenshot.toString('base64'), coordinates: paintCoordinates });
    assert.deepEqual(paintPixels.left, [245, 245, 245, 255], 'the left selection outset is actually painted');
    assert.deepEqual(paintPixels.right, [245, 245, 245, 255], 'nested group overflow must not clip the right selection outset');
    const rootRow = before.find(row => row.title === 'Root');
    const folderRow = before.find(row => row.title === 'Category A');
    const leafRow = before.find(row => row.title === 'Policy A');
    const nestedRow = before.find(row => row.title === 'Nested category');
    assert.equal(folderRow.rect[0] - rootRow.rect[0], 22);
    assert.equal(nestedRow.rect[0] - folderRow.rect[0], 22);
    assert.equal(folderRow.icon[0], leafRow.icon[0], 'leaf and folder icons align at the same depth');
    assert.equal(folderRow.rect[3], 16);
    const paintHit = await byTitle('Category A').evaluate(element => {
        const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.left - 2, box.top + box.height / 2) === element;
    });
    assert.equal(paintHit, false, 'pointer-transparent paint does not enlarge the selection hitbox');
    const navigations = await page.evaluate(() => nav.length);
    await byTitle('Category A').locator('.icon-switcher').click();
    assert.equal(await page.evaluate(() => nav.length), navigations, 'arrow changes expansion without navigation');
    assert.equal(await page.evaluate(() => rows.root.children[0].opened), false);
    await byTitle('Category A').locator('.icon-switcher').click();
    await byTitle('Policy A').click();
    assert.deepEqual(await treeMetrics(page), before);
    assert.equal(await byTitle('Policy A').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => nav[nav.length - 1]), 'Policy A');
}));
