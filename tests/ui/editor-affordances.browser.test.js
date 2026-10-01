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
const source = fs.readFileSync(path.join(__dirname, 'admx-navigation.browser.test.js'), 'utf8');
const start = source.indexOf('const html = `');
const end = source.indexOf('\nconst browserOptions', start);
assert.ok(start >= 0 && end > start);
const html = vm.runInNewContext(source.slice(start, end) + '\nhtml;');

async function fixture(run, reducedMotion = 'no-preference') {
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
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        // The actual app is always inside the FreeIPA GPUI dialog. Its outer
        // ownership must not make the filter look like a nested editor field.
        await page.evaluate(() => {
            const shell = document.createElement('div'); shell.className = 'modal-gpui';
            shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true');
            document.body.appendChild(shell); shell.appendChild(document.querySelector('.gp__container'));
        });
        await run(page);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => requests.some(request => /update|delete|create/i.test(request.method))), false);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const header = page => page.locator('.workspace > .gpo-category-path');
const filter = page => header(page).locator('[data-policy-filter]');
const focused = locator => locator.evaluate(element => element === document.activeElement);

async function expectCompactHeader(page, placeholder) {
    assert.equal(await page.locator('.workspace [data-policy-filter]').count(), 1);
    assert.equal(await filter(page).getAttribute('placeholder'), placeholder);
    assert.equal(await filter(page).getAttribute('aria-label'), placeholder);
    assert.equal(await filter(page).evaluate(element => Boolean(element.closest('.gpo-category-path__filter') || element.matches('.gpo-category-path__filter'))), true);
    assert.equal(await page.locator('.workspace .gpo-security-workbench__toolbar').count(), 0, 'moving the filter must not leave a blank toolbar');
    assert.equal(await header(page).locator('button[aria-current=page]').count(), 1);
    const metrics = await filter(page).evaluate(element => {
        const input = element.getBoundingClientRect(), nav = element.closest('.gpo-category-path').getBoundingClientRect();
        const list = element.closest('.gpo-category-path').querySelector('.gpo-category-path__list').getBoundingClientRect();
        return { rightInset: nav.right - input.right, height: input.height,
            filterTop: input.top, filterBottom: input.bottom, listTop: list.top, listBottom: list.bottom,
            listRight: list.right, inputLeft: input.left };
    });
    assert.equal(metrics.rightInset, 20);
    assert.equal(metrics.height, 28);
    assert.ok(metrics.listRight <= metrics.inputLeft, 'breadcrumb and search occupy separate horizontal space');
    assert.ok(metrics.filterTop <= metrics.listBottom && metrics.filterBottom >= metrics.listTop, 'filter is aligned beside the breadcrumb, not on a second toolbar row');
}

for (const language of ['en', 'ru']) {
    test('Category search stays in the top-right breadcrumb, keeps selection/input and clears with Escape in ' + language, { skip }, async () => fixture(async page => {
        await page.evaluate(async language => { require('locales/translations').setLanguage(language); await selectAdmin('computer'); }, language);
        await expectCompactHeader(page, await page.evaluate(() => require('locales/translations').t('policySearch.categoryPlaceholder')));
        await page.getByRole('button', { name: 'Zulu root policy', exact: true }).click();
        await page.evaluate(() => { window.originalFilter = document.querySelector('.workspace [data-policy-filter]'); });
        await filter(page).fill('Zulu');
        assert.deepEqual(await page.locator('.workspace .gp__list-children__item__title').allTextContents(), ['Zulu root policy']);
        assert.equal(await page.locator('.workspace-list-item.active').textContent(), 'Zulu root policy');
        assert.equal(await focused(filter(page)), true);
        assert.equal(await page.evaluate(() => originalFilter === document.querySelector('.workspace [data-policy-filter]')), true);
        await filter(page).fill('No such policy');
        assert.equal(await page.locator('.workspace-list-item').count(), 0);
        await filter(page).press('Escape');
        assert.equal(await filter(page).inputValue(), '');
        assert.equal(await focused(filter(page)), true);
        assert.equal(await page.locator('.workspace-list-item').count(), 5);
        assert.equal(await page.locator('.workspace-list-item.active').textContent(), 'Zulu root policy');
        await filter(page).fill('Zulu');
        await page.evaluate(async () => { await state.navigateToNode(scopeRoots.computer, { openPath: true }); await selectAdmin('computer'); });
        assert.equal(await filter(page).inputValue(), 'Zulu', 'category query survives leaving and reopening the view');
        await expectCompactHeader(page, await page.evaluate(() => require('locales/translations').t('policySearch.categoryPlaceholder')));
        await filter(page).focus();
        await filter(page).press('Escape');
        assert.equal(await filter(page).inputValue(), '');
        assert.equal(await page.locator('.workspace-list-item').count(), 5);
    }));

    test('All Policies search retains its compact-header input and focus across async catalog/table rerenders in ' + language, { skip }, async () => fixture(async page => {
        await page.evaluate(async language => {
            require('locales/translations').setLanguage(language);
            const api = require('util/API'), original = api.policyIndex;
            api.policyIndex = scope => new Promise(resolve => { window.releaseCatalog = async () => resolve(await original(scope)); });
            window.allNode = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            await state.navigateToNode(allNode, { openPath: true });
        }, language);
        await page.waitForFunction(() => typeof releaseCatalog === 'function');
        await expectCompactHeader(page, await page.evaluate(() => require('locales/translations').t('policySearch.computerPlaceholder')));
        await page.evaluate(() => { window.originalFilter = document.querySelector('.workspace [data-policy-filter]'); });
        await filter(page).fill('Rare policy');
        assert.equal(await focused(filter(page)), true);
        await page.evaluate(() => releaseCatalog());
        await page.locator('[data-policy-result-id]').first().waitFor();
        assert.equal(await page.locator('[data-policy-result-id]').count(), 1);
        assert.match(await page.locator('[data-policy-result-id]').textContent(), /Rare policy beyond first page/);
        assert.equal(await page.evaluate(() => originalFilter === document.querySelector('.workspace [data-policy-filter]')), true);
        assert.equal(await focused(filter(page)), true, 'arrival of async results must not steal input focus');
        assert.equal(await filter(page).inputValue(), 'Rare policy');
        await filter(page).press('Escape');
        assert.equal(await filter(page).inputValue(), '');
        assert.equal(await focused(filter(page)), true);
        assert.equal(await page.locator('[data-policy-result-id]').count(), 100);
        await filter(page).fill('Rare policy');
        await page.evaluate(async () => { await selectAdmin('computer'); await state.navigateToNode(allNode, { openPath: true }); });
        assert.equal(await filter(page).inputValue(), 'Rare policy');
        assert.equal(await page.locator('[data-policy-result-id]').count(), 1);
        await expectCompactHeader(page, await page.evaluate(() => require('locales/translations').t('policySearch.computerPlaceholder')));
    }));
}

test('Compact header wraps search safely when the catalog pane becomes narrow', { skip }, async () => fixture(async page => {
    await page.evaluate(() => selectAdmin('computer'));
    await page.locator('.workspace').evaluate(element => { element.style.flex = '0 0 320px'; });
    const dimensions = await filter(page).evaluate(element => {
        const input = element.getBoundingClientRect(), nav = element.closest('.gpo-category-path').getBoundingClientRect();
        return { inputLeft: input.left, inputRight: input.right, inputWidth: input.width,
            navLeft: nav.left, navRight: nav.right, navScrollWidth: element.closest('.gpo-category-path').scrollWidth,
            navClientWidth: element.closest('.gpo-category-path').clientWidth };
    });
    assert.ok(dimensions.inputLeft >= dimensions.navLeft && dimensions.inputRight <= dimensions.navRight);
    assert.ok(dimensions.inputWidth <= 280);
    assert.equal(dimensions.navScrollWidth, dimensions.navClientWidth);
    await filter(page).fill('Zulu');
    assert.equal(await page.locator('.workspace-list-item').count(), 1);
    assert.equal(await focused(filter(page)), true);
}));

async function prepareMotionTree(page) {
    await page.evaluate(() => {
        const tree = require('components/tree-view/tree-view-list');
        const host = document.createElement('nav'); host.className = 'tree-view'; host.id = 'motion-tree';
        host.style.cssText = 'position:fixed;left:0;top:0;height:500px;width:432px;background:white;z-index:2000';
        document.querySelector('.gp__container').appendChild(host);
        window.motionRoot = { type: 'folder', title: 'Initially open branch', icon: 'ico-folder', opened: true, children: [
            { type: 'file', title: 'Initial child', icon: 'ico-file' },
            { type: 'folder', title: 'Animated branch', icon: 'ico-folder', opened: false, children: [
                { type: 'file', title: 'Animated child', icon: 'ico-file' },
                { type: 'file', title: 'Second animated child', icon: 'ico-file' }
            ] }
        ] };
        host.appendChild(tree.renderTreeViewList([motionRoot], null, null).getElement());
        window.motionBranch = motionRoot.children[1];
        window.motionElement = Array.from(host.querySelectorAll('li.view.folder')).find(element => element.querySelector(':scope > .tree-item').getAttribute('aria-label') === motionBranch.title);
        window.setMotionOpen = value => tree.setFolderOpenedState(motionElement, motionBranch, value);
        window.motionState = () => {
            const group = motionElement.querySelector(':scope > ul'), style = getComputedStyle(group);
            const animations = motionElement.getAnimations().filter(animation => animation.transitionProperty === 'grid-template-rows');
            return { opened: motionBranch.opened, animating: motionElement.classList.contains('is-expanding'),
                display: style.display, overflow: style.overflow, realAnimations: animations.length };
        };
    });
}

test('Initial-open tree groups are stable while real expansion/reversal clips children and final-open outsets survive', { skip }, async () => fixture(async page => {
    await prepareMotionTree(page);
    const initial = await page.locator('#motion-tree > ul > li > ul').evaluate(element => ({ overflow: getComputedStyle(element).overflow, animating: element.parentElement.classList.contains('is-expanding') }));
    assert.deepEqual(initial, { overflow: 'visible', animating: false });
    const opening = await page.evaluate(() => { setMotionOpen(true); return motionState(); });
    assert.equal(opening.opened, true);
    assert.equal(opening.overflow, 'hidden');
    assert.equal(opening.animating, true);
    assert.ok(opening.realAnimations > 0, 'the attached branch has a real grid expansion transition');
    const continuing = await page.evaluate(() => { setMotionOpen(true); return motionState(); });
    assert.equal(continuing.overflow, 'hidden', 'a repeated lazy-state synchronization must not release in-flight clipping');
    assert.equal(continuing.animating, true);
    const clippedHit = await page.evaluate(() => {
        const group = motionElement.querySelector(':scope > ul'), box = group.getBoundingClientRect();
        const child = group.querySelector('.tree-item'), childBox = child.getBoundingClientRect();
        const y = Math.max(box.bottom + 1, childBox.top + 1);
        const hit = document.elementFromPoint(childBox.left + 24, y);
        return { belowClip: y >= box.bottom, childHit: Boolean(hit && child.contains(hit)) };
    });
    assert.equal(clippedHit.belowClip, true);
    assert.equal(clippedHit.childHit, false, 'children outside the animated crop must not receive pointer hits');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const reversed = await page.evaluate(() => { setMotionOpen(false); return motionState(); });
    assert.equal(reversed.opened, false);
    assert.equal(reversed.display, 'none');
    assert.equal(reversed.overflow, 'hidden');
    assert.equal(await page.getByRole('treeitem', { name: 'Animated child', exact: true }).isVisible(), false);
    await page.evaluate(() => setMotionOpen(true));
    const secondOpening = await page.evaluate(() => motionState());
    assert.equal(secondOpening.overflow, 'hidden');
    await page.waitForFunction(() => motionState().opened && !motionState().animating && motionState().overflow === 'visible');
    await page.getByRole('treeitem', { name: 'Animated child', exact: true }).click();
    const final = await page.getByRole('treeitem', { name: 'Animated child', exact: true }).evaluate(element => {
        const style = getComputedStyle(element), pseudo = getComputedStyle(element, '::before');
        return { height: element.getBoundingClientRect().height, padding: style.padding, left: pseudo.left, right: pseudo.right,
            pointerEvents: pseudo.pointerEvents, shadow: style.boxShadow, selected: element.getAttribute('aria-selected') };
    });
    assert.equal(final.height, 16);
    assert.equal(final.padding, '0px 0px 0px 20px');
    assert.equal(final.left, '-4px');
    assert.equal(final.right, '-4px');
    assert.equal(final.pointerEvents, 'none');
    assert.equal(final.shadow, 'none');
    assert.equal(final.selected, 'true');
    await page.evaluate(() => { setMotionOpen(false); setMotionOpen(true); setMotionOpen(false); setMotionOpen(true); });
    await page.waitForFunction(() => motionState().opened && !motionState().animating && motionState().overflow === 'visible');
    assert.equal(await page.getByRole('treeitem', { name: 'Animated child', exact: true }).isVisible(), true);
}));

test('Reduced-motion expansion settles immediately and closing recovers the visible keyboard focus', { skip }, async () => fixture(async page => {
    await prepareMotionTree(page);
    const opening = await page.evaluate(() => { setMotionOpen(true); return motionState(); });
    assert.deepEqual(opening, { opened: true, animating: false, display: 'block', overflow: 'visible', realAnimations: 0 });
    const child = page.getByRole('treeitem', { name: 'Animated child', exact: true });
    await child.click();
    await child.focus();
    await page.evaluate(() => setMotionOpen(false));
    const branch = page.getByRole('treeitem', { name: 'Animated branch', exact: true });
    assert.equal(await focused(branch), true);
    assert.equal(await branch.getAttribute('tabindex'), '0');
    assert.equal(await child.isVisible(), false);
    await branch.press('ArrowRight');
    assert.equal(await page.evaluate(() => motionState().overflow), 'visible');
    assert.equal(await page.evaluate(() => motionState().animating), false);
    assert.equal(await focused(branch), true);
}, 'reduce'));
