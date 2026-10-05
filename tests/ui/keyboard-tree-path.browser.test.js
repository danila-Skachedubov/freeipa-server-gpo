'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
let chromium, requireJs;
try { chromium = require('playwright').chromium; requireJs = require.resolve('requirejs/require.js'); } catch (_) { /* Optional browser runner. */ }
const skip = !chromium || !requireJs ? 'Set NODE_PATH for browser checks.' : false;
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
// Reuse the actual-app mock fixture without registering its historical tests.
const source = fs.readFileSync(path.join(__dirname, 'admx-navigation.browser.test.js'), 'utf8');
const start = source.indexOf('const html = `');
const end = source.indexOf('\nconst browserOptions', start);
assert.ok(start >= 0 && end > start);
const html = vm.runInNewContext(source.slice(start, end) + '\nhtml;');

async function fixture(run) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try { response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript'); response.end(fs.readFileSync(filename)); }
        catch (_) { response.statusCode = 404; response.end('Missing'); }
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
        assert.equal(await page.evaluate(() => requests.some(request => request.method === 'update')), false);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const catalog = page => page.locator('.gp__list-children__list');
const currentRow = page => catalog(page).locator('.workspace-list-item.active');
const currentTree = page => page.locator('.tree-view .tree-item[tabindex="0"]');
const focused = locator => locator.evaluate(node => node === document.activeElement);

for (const language of ['en', 'ru']) {
    test('Catalog mouse/keyboard activation, copy rules and modal Tab ownership in ' + language, { skip }, async () => fixture(async page => {
        await page.evaluate(async language => { require('locales/translations').setLanguage(language); await selectAdmin('computer'); }, language);
        const row = page.getByRole('button', { name: 'Zulu root policy', exact: true });
        await row.click();
        assert.equal(await page.locator('.gpo-admx-dialog').count(), 0, 'single click only selects');
        assert.equal(await row.getAttribute('aria-selected'), 'true');
        assert.equal(await catalog(page).locator('[tabindex="0"]').count(), 1);
        await row.press('Space');
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'show').length), 0);
        await row.press('Enter');
        const modal = page.locator('.gpo-admx-dialog');
        await modal.locator('[data-field-id=value] input').waitFor();
        const buttons = page.locator('.gpo-category-path button');
        assert.equal(await buttons.first().textContent(), 'Example GPO');
        assert.equal(await buttons.last().textContent(), 'Zulu root policy');
        assert.equal(await page.locator('.gpo-category-path button[tabindex="0"]').count(), 1);
        assert.equal(await modal.locator('[data-category-path]').count(), 0);
        await modal.focus();
        await modal.press('Shift+Tab');
        assert.equal(await focused(modal.locator('.btn-ok')), true, 'root Shift+Tab stays inside the dialog');
        await modal.locator('.btn-ok').press('Tab');
        assert.equal(await focused(modal.locator('.gpo-editor-dialog__close')), true);
        await modal.locator('.gpo-editor-dialog__close').press('Shift+Tab');
        assert.equal(await focused(modal.locator('.btn-ok')), true);
        assert.equal(await modal.locator('[data-field-id=value] input').evaluate(node => getComputedStyle(node).userSelect), 'text');
        assert.equal(await modal.locator('.preference__modal-header .title').evaluate(node => getComputedStyle(node).userSelect), 'none');
        await modal.getByRole('tab').last().click();
        assert.equal(await modal.locator('.gpo-admx-dialog__explanation').evaluate(node => getComputedStyle(node).userSelect), 'text');
        const renderId = await page.evaluate(() => state.renderRequestId);
        await modal.press('F6');
        assert.equal(await page.evaluate(() => state.renderRequestId), renderId);
        assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true);
        await modal.locator('.btn-cancel').click();
        await page.evaluate(() => selectAdmin('computer'));
        await row.dblclick();
        await modal.locator('[data-field-id=value] input').waitFor();
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'show').length), 2);
        await modal.locator('.btn-cancel').click();
        await buttons.first().click();
        assert.equal(await page.evaluate(() => state.selectedItem.item === roots[0]), true);
        assert.equal(await page.locator('[data-category-path]').textContent(), 'Example GPO');
    }));
}

test('Tree keys preserve expansion rules and Tab/F6 use single pane entries', { skip }, async () => fixture(async page => {
    // The real app is inside the outer FreeIPA dialog, unlike the bare fixture.
    await page.evaluate(() => {
        var editor = document.querySelector('.gp__container');
        var shell = document.createElement('div');
        shell.className = 'modal-gpui'; shell.setAttribute('role', 'dialog');
        editor.parentNode.insertBefore(shell, editor); shell.appendChild(editor);
    });
    await page.evaluate(async () => {
        await selectAdmin('computer');
        await state.navigateToNode(category('computer', 'mixed'), { openPath: true, openCurrentFolder: true });
    });
    await currentTree(page).focus();
    const renderId = await page.evaluate(() => state.renderRequestId);
    await currentTree(page).press('ArrowLeft');
    assert.equal(await page.evaluate(() => category('computer', 'mixed').opened), false);
    assert.equal(await page.evaluate(() => state.renderRequestId), renderId);
    await currentTree(page).press('ArrowRight');
    assert.equal(await page.evaluate(() => category('computer', 'mixed').opened), true);
    assert.equal(await page.evaluate(() => state.renderRequestId), renderId);
    await currentTree(page).press('ArrowRight');
    await page.waitForFunction(() => state.selectedItem.item.categoryId === 'nested');
    assert.equal(await currentTree(page).getAttribute('aria-label'), 'Nested category');
    await currentTree(page).press('ArrowLeft');
    await page.waitForFunction(() => state.selectedItem.item.categoryId === 'mixed');
    assert.equal(await page.locator('.tree-view .tree-item[tabindex="0"]').count(), 1);
    assert.equal(await page.locator('.tree-view .icon-switcher[tabindex="0"]').count(), 0);
    await currentTree(page).press('Tab');
    assert.equal(await focused(page.locator('.gpo-category-path button[tabindex="0"]')), true);
    await page.keyboard.press('Tab');
    assert.equal(await focused(page.locator('[data-policy-filter]')), true);
    await page.keyboard.press('Tab');
    assert.equal(await focused(currentRow(page)), true);
    await currentRow(page).press('End');
    assert.equal(await currentRow(page).textContent(), 'Zulu policy');
    await currentRow(page).press('Home');
    assert.equal(await currentRow(page).textContent(), 'Nested category');
    await currentRow(page).press('ArrowDown');
    assert.equal(await currentRow(page).textContent(), 'alpha policy');
    await currentRow(page).press('F6');
    assert.equal(await focused(currentTree(page)), true);
    await currentTree(page).press('F6');
    assert.equal(await focused(currentRow(page)), true);
    assert.equal(await currentRow(page).textContent(), 'alpha policy');
    assert.equal(await page.locator('.gpo-admx-dialog').count(), 0);
    await currentRow(page).press('Tab');
    assert.equal(await catalog(page).evaluate(node => node.contains(document.activeElement)), false);
}));

test('Collapsing an ancestor moves the tree Tab stop without changing its selected descendant', { skip }, async () => fixture(async page => {
    await page.evaluate(async () => {
        await selectAdmin('computer');
        await state.navigateToNode(category('computer', 'mixed'), { openPath: true, openCurrentFolder: true });
        await state.navigateToNode(category('computer','mixed').children.find(node => node.categoryId === 'nested'), { openPath: true });
    });
    await currentTree(page).focus();
    const renderId = await page.evaluate(() => state.renderRequestId);
    await page.evaluate(() => state.toggleFolder(category('computer','mixed')));
    assert.equal(await page.evaluate(() => state.selectedItem.item.categoryId), 'nested');
    assert.equal(await page.evaluate(() => state.renderRequestId), renderId);
    assert.equal(await currentTree(page).getAttribute('aria-label'), 'Mixed category');
    assert.equal(await focused(currentTree(page)), true);
    assert.equal(await page.locator('.tree-view .tree-item[tabindex="0"]').count(), 1);
    await currentTree(page).press('ArrowRight');
    assert.equal(await page.evaluate(() => state.selectedItem.item.categoryId), 'nested');
    assert.equal(await currentTree(page).getAttribute('aria-label'), 'Nested category');
}));

test('GPO breadcrumb uses the existing draft guard and horizontal roving navigation', { skip }, async () => fixture(async page => {
    await page.evaluate(() => selectAdmin('computer'));
    await page.getByRole('button', { name: 'Zulu root policy', exact: true }).dblclick();
    const input = page.locator('.gpo-admx-dialog [data-field-id=value] input');
    await input.fill('local draft');
    const path = page.locator('.gpo-category-path');
    await path.locator('button').first().evaluate(node => node.click());
    assert.equal(await page.evaluate(() => state.pendingNavigation.item === roots[0]), true);
    assert.equal(await input.inputValue(), 'local draft');
    await page.locator('#discard').click();
    await page.waitForFunction(() => state.selectedItem.item === roots[0]);
    await page.evaluate(() => selectAdmin('computer'));
    const current = path.locator('button[tabindex="0"]');
    await current.focus();
    await current.press('Home');
    assert.equal(await focused(path.locator('button').first()), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(path.locator('button').nth(1)), true);
    await page.keyboard.press('End');
    assert.equal(await focused(path.locator('button').last()), true);
    assert.equal(await path.locator('button[tabindex="0"]').count(), 1);
}));
