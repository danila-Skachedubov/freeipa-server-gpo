'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
let chromium, requireJs;
try { chromium = require('playwright').chromium; requireJs = require.resolve('requirejs/require.js'); }
catch (_) { /* Browser runner is optional in unit-only environments. */ }
const skip = !chromium || !requireJs ? 'Set NODE_PATH for browser checks.' : false;
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const source = fs.readFileSync(path.join(__dirname, 'admx-navigation.browser.test.js'), 'utf8');
const start = source.indexOf('const html = `');
const end = source.indexOf('\nconst browserOptions', start);
assert.ok(start >= 0 && end > start);
const html = vm.runInNewContext(source.slice(start, end) + '\nhtml;');

async function fixture(run, options = {}) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
        const filename = request.url === '/require.js' ? requireJs
            : request.url === '/js/components/tree-view/tree-view-list.js' && process.env.TREE_SCROLL_ASSET
                ? process.env.TREE_SCROLL_ASSET : path.join(root, request.url);
        try {
            response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
            response.end(fs.readFileSync(filename));
        } catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: options.reducedMotion || 'no-preference' });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        await page.addStyleTag({ content: 'body{margin:0;min-height:2000px}.gp__container{height:700px!important}.gp__container .tree-view{height:180px!important;width:280px!important;flex:0 0 280px;padding:12px!important}' });
        if (!options.originalTree) await page.evaluate(() => {
            const treeList = require('components/tree-view/tree-view-list');
            window.scrollNodes = Array.from({ length: 50 }, (_, index) => ({
                title: 'Scroll ' + (index % 2 ? 'policy ' : 'category ') + index,
                type: index % 2 ? 'file' : 'folder', icon: index % 2 ? 'ico-file' : 'ico-folder', children: [],
            }));
            window.scrollLeaf = { title: 'Deep policy', type: 'file', icon: 'ico-file' };
            let nested = scrollLeaf;
            for (let level = 0; level < 4; level++) nested = { title: 'Deep category ' + level, type: 'folder', icon: 'ico-folder', children: [nested], opened: false };
            scrollNodes.splice(40, 0, nested);
            window.scrollRoot = { title: 'Scroll fixture', type: 'folder', icon: 'ico-folder', opened: true, children: scrollNodes };
            document.getElementById('tree').replaceChildren(treeList.renderTreeViewList([scrollRoot], state.workspace, state).getElement());
        });
        await page.evaluate(() => {
            const input = document.createElement('input'); input.id = 'scroll-focus';
            document.getElementById('header').appendChild(input);
            input.focus({ preventScroll: true }); window.scrollTo(0, 120);
        });
        await run(page);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => requests.some(request => /update|delete|create/i.test(request.method))), false);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

async function settled(page) {
    await page.waitForFunction(() => !document.querySelector('.tree-view .is-expanding'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function visible(page) {
    await page.waitForFunction(() => {
        const pane = document.querySelector('.tree-view'), row = pane.querySelector('.tree-item.active');
        if (!row) return false;
        const view = pane.getBoundingClientRect(), bounds = row.getBoundingClientRect();
        return bounds.height > 0 && bounds.top >= view.top + pane.clientTop + 3
            && bounds.bottom <= view.top + pane.clientTop + pane.clientHeight - 3;
    });
}

async function position(page) {
    return page.evaluate(() => {
        const pane = document.querySelector('.tree-view');
        return { top: pane.scrollTop, left: pane.scrollLeft, pageTop: window.scrollY,
            focus: document.activeElement.id, selected: pane.querySelector('.tree-item.active')?.textContent };
    });
}

for (const index of [45, 46]) {
    test('Off-screen ' + (index % 2 ? 'category' : 'policy') + ' selection scrolls only the tree without taking focus', { skip }, async () => fixture(async page => {
        const before = await position(page);
        await page.evaluate(index => state.navigateToNode(scrollNodes[index]), index);
        await visible(page);
        const after = await position(page);
        assert.ok(after.top > before.top);
        assert.equal(after.pageTop, before.pageTop);
        assert.equal(after.focus, before.focus);
        await page.evaluate(() => state.navigateToNode(scrollNodes[0]));
        await visible(page);
        assert.ok((await position(page)).top < after.top, 'selection above the viewport scrolls upward');
        assert.equal((await position(page)).pageTop, before.pageTop);
    }));
}

test('An already-visible selected row leaves both tree scroll offsets unchanged', { skip }, async () => fixture(async page => {
    await page.evaluate(() => state.navigateToNode(scrollNodes[46]));
    await visible(page);
    const before = await position(page);
    await page.evaluate(() => state.navigateToNode(scrollNodes[46]));
    await settled(page);
    assert.deepEqual(await position(page), before);
}));

test('Mouse selection uses the shared reveal path without a browser-assisted pre-scroll', { skip }, async () => fixture(async page => {
    const before = await position(page);
    await page.evaluate(() => state.treeItemElements.get(scrollNodes[46])
        .querySelector('.tree-item__title').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await visible(page);
    assert.ok((await position(page)).top > before.top);
    assert.equal((await position(page)).pageTop, before.pageTop);
}));

for (const reducedMotion of ['no-preference', 'reduce']) {
    test('Nested selection remains visible after ancestor expansion with motion=' + reducedMotion, { skip }, async () => fixture(async page => {
        await page.evaluate(() => state.navigateToNode(scrollLeaf));
        await settled(page);
        await visible(page);
        assert.equal((await position(page)).selected, 'Deep policy');
        assert.equal((await position(page)).focus, 'scroll-focus');
    }, { reducedMotion }));
}

test('A superseded expansion callback cannot scroll away from a newer selection', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        await state.navigateToNode(scrollLeaf);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await state.navigateToNode(scrollNodes[0]);
    });
    await visible(page);
    const before = await position(page);
    await settled(page);
    assert.deepEqual(await position(page), before);
}));

test('An oversized label reveals its icon and beginning while preserving the document position', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        const row = state.treeItemElements.get(scrollLeaf);
        row.querySelector('.tree-item__title').textContent = 'Long policy label '.repeat(40);
        await state.navigateToNode(scrollLeaf);
    });
    await settled(page);
    await page.evaluate(() => document.querySelector('.tree-view').scrollLeft = 1000);
    const before = await position(page);
    await page.evaluate(() => state.navigateToNode(scrollLeaf));
    await settled(page);
    const after = await position(page);
    assert.ok(after.left < before.left);
    assert.equal(after.pageTop, before.pageTop);
    const startVisible = await page.evaluate(() => {
        const pane = document.querySelector('.tree-view'), row = pane.querySelector('.tree-item.active');
        const view = pane.getBoundingClientRect(), icon = row.querySelector('.icon').getBoundingClientRect();
        return icon.left >= view.left && icon.right <= view.left + pane.clientWidth;
    });
    assert.equal(startVisible, true);
}));

test('Tree keyboard End/Home reveal their selection without scrolling the document', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        await state.navigateToNode(scrollRoot);
        state.treeItemElements.get(scrollRoot).focus({ preventScroll: true });
    });
    const before = await position(page);
    await page.keyboard.press('End');
    await visible(page);
    assert.equal((await position(page)).selected, 'Scroll policy 49');
    assert.equal((await position(page)).pageTop, before.pageTop);
    await page.keyboard.press('Home');
    await visible(page);
    assert.equal((await position(page)).selected, 'Scroll fixture');
    assert.equal((await position(page)).pageTop, before.pageTop);
}));

test('A blocked dirty navigation does not scroll until it is confirmed', { skip }, async () => fixture(async page => {
    await page.evaluate(() => state.navigateToNode(scrollNodes[0]));
    await visible(page);
    const before = await position(page);
    const allowed = await page.evaluate(() => {
        state.setCurrentView({ hasUnsavedChanges: () => true, cancelChanges: () => true });
        return state.navigateToNode(scrollNodes[46]);
    });
    assert.equal(allowed, false);
    await settled(page);
    assert.deepEqual(await position(page), before);
    await page.evaluate(() => {
        state.currentView.hasUnsavedChanges = () => false;
        return state.handlePolicyChangedNo();
    });
    await visible(page);
    assert.ok((await position(page)).top > before.top);
}));

test('Hidden AT policy selection reveals its active parent category without adding a leaf', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        await selectAdmin('computer');
        await state.navigateToNode(category('computer', 'only'));
        const spacer = document.createElement('li'); spacer.style.height = '650px';
        state.treeListItemElements.get(templates.computer).before(spacer);
        document.querySelector('.tree-view').scrollTop = 0;
        window.hiddenTarget = category('computer', 'only').children.find(node => node.type === 'file');
        await state.navigateToNode(hiddenTarget);
    });
    await settled(page);
    await visible(page);
    assert.equal(await page.evaluate(() => state.selectedItem.item === hiddenTarget), true);
    assert.equal(await page.evaluate(() => state.treeItemElements.has(hiddenTarget)), false);
    assert.equal((await position(page)).selected, 'Policy-only category');
}, { originalTree: true }));

test('Opening an All Policies modal does not move the existing tree selection or scroll', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        let all;
        function find(nodes) { nodes.forEach(node => {
            if (node.template === 'all_policies' && node.scope === 'computer') all = node;
            if (node.children) find(node.children);
        }); }
        find(state.treeData);
        await state.navigateToNode(all);
    });
    await settled(page);
    await page.locator('[data-policy-filter]').fill('Rare policy');
    await page.locator('[data-policy-result-id]').waitFor();
    await page.evaluate(() => document.querySelector('.tree-view').scrollTop = 0);
    const before = await position(page);
    await page.locator('[data-policy-result-id]').dblclick();
    await page.locator('.gpo-admx-dialog').waitFor();
    await settled(page);
    const after = await position(page);
    assert.equal(after.top, before.top);
    assert.equal(after.left, before.left);
    assert.equal(after.selected, before.selected);
}, { originalTree: true }));
