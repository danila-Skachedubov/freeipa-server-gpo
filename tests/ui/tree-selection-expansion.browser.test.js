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
const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif}.gp__container{height:100vh}#confirmation{display:none}#confirmation.active{display:block}</style>
</head><body><div class="gp__container"><div class="gp__main"><nav id="tree" class="tree-view"></nav></div>
<div id="confirmation" role="alertdialog" aria-label="Unsaved policy"><button id="discard">Discard changes</button></div></div>
<script src="/require.js"></script><script>
define('util/API',[],()=>({getDisplayName:()=> 'Example GPO'}));
require.config({baseUrl:'/js'});
require(['app','components/tree-view/tree-view-list','components/workspace/workspace','locales/translations'],
 (app,treeList,workspaceModule,translations)=>{
  translations.setLanguage('en');window.translations=translations;
  const folder=(title,children=[],opened=false)=>({title,type:'folder',icon:'ico-folder',children,opened});
  window.leaf={title:'Nested leaf',type:'file',icon:'ico-file'};
  window.nested=folder('Nested category',[leaf]);
  window.target=folder('Target category',[nested]);
  window.other=folder('Other category',[folder('Other child')]);
  window.lazy=folder('Lazy category');lazy.lazy=true;window.lazyRequests=0;
  lazy.loadChildren=()=>{lazyRequests++;return new Promise((resolve,reject)=>{window.resolveLazy=resolve;window.rejectLazy=reject;});};
  window.rootNode=folder('Example GPO',[target,other,lazy],true);
  window.state=app._test.createTreeViewState();
  window.workspace=workspaceModule.renderWorkspace();document.querySelector('.gp__main').appendChild(workspace.getElement());
  document.getElementById('tree').appendChild(treeList.renderTreeViewList([rootNode],workspace,state).getElement());
  [target,other,lazy,nested].forEach(item=>state.treeItemElements.get(item).setAttribute('data-test-node',item.title));
  state.policyChangedModal=document.getElementById('confirmation');
  document.getElementById('discard').addEventListener('click',state.handlePolicyChangedNo.bind(state));
  Promise.resolve(state.navigateToNode(other,{openPath:true})).then(()=>{window.ready=true;});
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
        const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        try { await run(page); }
        catch (error) {
            error.message += '; page errors: ' + errors.join('; ');
            throw error;
        }
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

const title = (page, name) => page.locator('[data-test-node="' + name + '"] > .tree-item__title');
const arrow = (page, name) => page.locator('[data-test-node="' + name + '"] > .icon-switcher');

async function folderState(page, name) {
    return page.evaluate(name => {
        const item = { target, other, lazy, nested }[name];
        const element = state.treeListItemElements.get(item);
        const list = element.querySelector(':scope > ul.tree-view__list');
        return {
            opened: Boolean(item.opened), selected: state.selectedItem.item === item,
            active: state.treeItemElements.get(item).classList.contains('active'),
            domOpened: element.classList.contains('opened'),
            ariaExpanded: element.querySelector(':scope > .tree-item > .icon-switcher').getAttribute('aria-expanded'),
            nestedVisible: list ? getComputedStyle(list).display !== 'none' : false
        };
    }, name);
}

async function expectFolder(page, name, opened, selected) {
    const actual = await folderState(page, name);
    assert.equal(actual.opened, opened);
    assert.equal(actual.selected, selected);
    assert.equal(actual.domOpened, opened);
    assert.equal(actual.ariaExpanded, String(opened));
    if (name !== 'lazy' || await page.evaluate(() => lazy.loaded)) assert.equal(actual.nestedVisible, opened);
}

test('tree selection preserves a collapsed catalog; repeated titles and other arrows retain the current view and filter', browserOptions, async () => {
    await withPage(async page => {
        await title(page, 'Target category').click();
        await expectFolder(page, 'target', false, true);
        await page.getByRole('button', { name: 'Nested category', exact: true }).waitFor();
        const search = page.locator('.workspace [data-policy-filter]');
        await search.fill('Nested');
        const before = await page.evaluate(() => {
            window.originalView = state.currentView;
            return { render: state.renderRequestId, navigation: state.navigationRequestId };
        });
        await title(page, 'Target category').click();
        await expectFolder(page, 'target', true, true);
        await title(page, 'Target category').click();
        await expectFolder(page, 'target', false, true);
        await arrow(page, 'Other category').click();
        await expectFolder(page, 'other', true, false);
        assert.equal(await search.inputValue(), 'Nested');
        assert.deepEqual(await page.evaluate(() => ({
            render: state.renderRequestId, navigation: state.navigationRequestId,
            sameView: state.currentView === originalView
        })), { ...before, sameView: true });
    });
});

test('arrow expansion bypasses navigation guard without discarding a draft; a category selection remains guarded', browserOptions, async () => {
    await withPage(async page => {
        const search = page.locator('.workspace [data-policy-filter]');
        await search.fill('unsaved draft');
        const before = await page.evaluate(() => {
            state.currentView.hasUnsavedChanges = () => true;
            state.currentView.cancelChanges = () => false;
            window.originalView = state.currentView;
            return state.navigationRequestId;
        });
        await arrow(page, 'Target category').click();
        await expectFolder(page, 'target', true, false);
        assert.equal(await page.evaluate(() => state.pendingNavigation), null);
        assert.equal(await page.getByRole('alertdialog', { name: 'Unsaved policy' }).isVisible(), false);
        assert.equal(await page.evaluate(() => state.navigationRequestId), before);
        assert.equal(await search.inputValue(), 'unsaved draft');
        await title(page, 'Target category').click();
        await page.getByRole('alertdialog', { name: 'Unsaved policy' }).waitFor();
        await expectFolder(page, 'target', true, false);
        assert.equal(await page.evaluate(() => state.pendingNavigation.options.openCurrentFolder), undefined);
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
        assert.equal(await page.evaluate(() => state.pendingNavigation), null);
        assert.equal(await page.evaluate(() => state.currentView === originalView), true);
        assert.equal(await search.inputValue(), 'unsaved draft');
    });
});

for (const language of ['en', 'ru']) {
    test(`tree arrows are keyboard operable and announce expansion in ${language} without selecting`, browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => { translations.setLanguage(language); state.setFolderOpened(target, false); }, language);
            const control = arrow(page, 'Target category');
            const names = language === 'en' ? ['Expand category', 'Collapse category'] : ['Раскрыть категорию', 'Свернуть категорию'];
            assert.equal(await control.getAttribute('aria-label'), names[0] + ': Target category');
            await control.focus();
            await page.keyboard.press('Enter');
            await expectFolder(page, 'target', true, false);
            assert.equal(await control.getAttribute('aria-label'), names[1] + ': Target category');
            await page.keyboard.press('Space');
            await expectFolder(page, 'target', false, false);
            assert.equal(await page.evaluate(() => state.selectedItem.item === other), true);
        });
    });
}

test('selecting a lazy category loads its main catalog while keeping its sidebar folder collapsed', browserOptions, async () => {
    await withPage(async page => {
        await title(page, 'Lazy category').click();
        await page.waitForFunction(() => lazyRequests === 1);
        await expectFolder(page, 'lazy', false, false);
        await page.evaluate(() => resolveLazy([{ title: 'Lazy child', type: 'folder', icon: 'ico-folder', opened: false, children: [] }]));
        await page.getByRole('button', { name: 'Lazy child', exact: true }).waitFor();
        await expectFolder(page, 'lazy', false, true);
        assert.equal(await page.evaluate(() => lazyRequests), 1);
    });
});

test('a lazy arrow can be collapsed before loading completes, without selecting or reopening its folder', browserOptions, async () => {
    await withPage(async page => {
        const before = await page.evaluate(() => {
            window.originalView = state.currentView;
            return state.navigationRequestId;
        });
        await arrow(page, 'Lazy category').click();
        await page.waitForFunction(() => lazyRequests === 1);
        await expectFolder(page, 'lazy', true, false);
        await arrow(page, 'Lazy category').click();
        await expectFolder(page, 'lazy', false, false);
        await page.evaluate(() => resolveLazy([{ title: 'Lazy child', type: 'folder', icon: 'ico-folder', opened: false, children: [] }]));
        await page.waitForFunction(() => lazy.loaded && !lazy.loadingPromise);
        await expectFolder(page, 'lazy', false, false);
        assert.equal(await page.evaluate(() => state.navigationRequestId), before);
        assert.equal(await page.evaluate(() => state.currentView === originalView), true);
    });
});

test('an explicit lazy navigation honors a later collapse instead of replaying its old open request', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => { window.lazyNavigation = state.navigateToNode(lazy, { openPath: true, openCurrentFolder: true }); });
        await page.waitForFunction(() => lazyRequests === 1);
        await arrow(page, 'Lazy category').click();
        await expectFolder(page, 'lazy', false, false);
        await page.evaluate(() => resolveLazy([{ title: 'Lazy child', type: 'folder', icon: 'ico-folder', opened: false, children: [] }]));
        await page.getByRole('button', { name: 'Lazy child', exact: true }).waitFor();
        await expectFolder(page, 'lazy', false, true);
    });
});

test('a failed lazy arrow remains collapsed after an intervening toggle and remains retryable', browserOptions, async () => {
    await withPage(async page => {
        await arrow(page, 'Lazy category').click();
        await page.waitForFunction(() => lazyRequests === 1);
        await arrow(page, 'Lazy category').click();
        await page.evaluate(() => rejectLazy(Error('Fixture load failed')));
        await page.waitForFunction(() => !lazy.loadingPromise);
        await expectFolder(page, 'lazy', false, false);
        await arrow(page, 'Lazy category').click();
        await page.waitForFunction(() => lazyRequests === 2);
        await page.evaluate(() => resolveLazy([{ title: 'Retry child', type: 'folder', icon: 'ico-folder', opened: false, children: [] }]));
        await page.waitForFunction(() => lazy.loaded && !lazy.loadingPromise);
        await expectFolder(page, 'lazy', true, false);
        assert.equal(await page.evaluate(() => state.selectedItem.item === other), true);
    });
});

test('normal navigation to a nested element reveals all ancestors and selects its actual tree row', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            state.setFolderOpened(rootNode, false);
            state.setFolderOpened(target, false);
            state.setFolderOpened(nested, false);
            return state.navigateToNode(leaf, { openPath: true });
        });
        await expectFolder(page, 'target', true, false);
        await expectFolder(page, 'nested', true, false);
        assert.equal(await page.evaluate(() => rootNode.opened), true);
        assert.equal(await page.evaluate(() => state.selectedItem.item === leaf), true);
        assert.equal(await page.locator('.tree-item.active .tree-item__title').textContent(), 'Nested leaf');
        assert.equal(await page.locator('.tree-item.active').count(), 1);
    });
});
