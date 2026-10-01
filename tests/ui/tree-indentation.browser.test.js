'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { /* Browser dependencies are optional in unit-only environments. */ }

const cssRoot = path.resolve(__dirname, '../../plugin/ui/grouppolicy/css');

test('folder and leaf icons keep the same indentation at each tree depth', {
    skip: !chromium ? 'Set NODE_PATH for Playwright browser checks.' : false
}, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`<div class="gp__container"><nav class="tree-view"><ul class="tree-view__list">
            <li class="view folder opened"><span class="tree-item"><span class="icon-switcher"></span><span class="icon ico-folder" id="parent"></span>Parent</span>
                <ul class="tree-view__list">
                    <li class="view folder opened"><span class="tree-item"><span class="icon-switcher"></span><span class="icon ico-folder" id="child-folder"></span>Folder</span>
                        <ul class="tree-view__list"><li class="view file"><span class="tree-item"><span class="icon ico-file" id="grandchild-file"></span>File</span></li></ul>
                    </li>
                    <li class="view file"><span class="tree-item"><span class="icon ico-file" id="child-file"></span>File</span></li>
                </ul>
            </li>
        </ul></nav></div>`);
        await page.addStyleTag({ path: path.join(cssRoot, 'main.css') });
        await page.addStyleTag({ path: path.join(cssRoot, 'other.css') });
        const x = await page.evaluate(() => Object.fromEntries(
            ['parent', 'child-folder', 'child-file', 'grandchild-file'].map(id => [
                id, document.getElementById(id).getBoundingClientRect().x
            ])
        ));
        assert.equal(x['child-file'], x['child-folder']);
        assert.equal(x['child-file'] - x.parent, 22);
        assert.equal(x['grandchild-file'] - x['child-folder'], 22);
    } finally {
        await browser.close();
    }
});
