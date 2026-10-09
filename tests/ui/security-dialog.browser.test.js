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
} catch (_) { /* Browser dependencies are optional for the unit-only runner. */ }

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636}.gp__container{min-width:0;height:100vh}#reference{position:absolute;left:-2000px;top:0}</style>
</head><body><div class="gp__container"><main id="workspace"></main></div>
<script src="/require.js"></script><script>
const ns = 'urn:altlinux:sdmx:policies:account-password';
const response = {security_catalog:{semantic_revision:'review',categories:[{namespace:ns,id:'password',display_name:'Password Policy'}],policies:[
{namespace:ns,policy_id:'account.password.maximum_password_age',category:[ns,'password'],display_name:'Maximum password age',explain_text:'Set the maximum password age in days.',
elements:[{id:'value',value_type:'integer',required:true,ranges:[{min:0,max:999}],input_ranges:[],options:[],initial:{kind:'integer',value:42}}],
controls:[{element_id:'value',label:'Password expires after:'}]},
{namespace:ns,policy_id:'account.password.minimum_password_age',category:[ns,'password'],display_name:'Minimum password age',
elements:[{id:'value',value_type:'integer',required:true,ranges:[{min:0,max:998}],input_ranges:[],options:[],initial:{kind:'integer',value:0}}]},
{namespace:'test',policy_id:'empty',category:[ns,'password'],display_name:'Policy without settings',elements:[]}
]},security_snapshot:{policies:[{namespace:'test',policy_id:'empty',state:'defined',elements:{}}]}};
window.requests=[];
define('util/API',[],()=>({securityDefinitionsShow:async()=>response,securityDefinitionsUpdate:async request=>{requests.push(request);return response;}}));
require.config({baseUrl:'/js'});
require(['components/templates/security/model','components/templates/security-template','locales/translations'],(model,template,translations)=>{
window.translations=translations;
window.show=async()=>{
 const view=await template.renderSecurityTemplate({item:model.navigationNodes(response)[0]});
 document.getElementById('workspace').replaceChildren(view.getElement());
};
show().then(()=>window.ready=true);
});</script></body></html>`;

test('Security dialog reuses Preferences styling, retains draft and supports accessible tabs', {
    skip: !chromium || !requireJs ? 'Set NODE_PATH to installed playwright and requirejs packages for browser checks.' : false
}, async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end(html);
        }
        const file = req.url === '/require.js' ? requireJs : path.join(root, req.url);
        try {
            res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
            res.end(fs.readFileSync(file));
        } catch (_) { res.statusCode = 404; res.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready, null, { timeout: 10000 }).catch(error => {
            throw new Error(error.message + '; browser errors: ' + errors.join('; '));
        });
        assert.equal(await page.locator('[data-security-row="Policy without settings"] td').last().textContent(), '—');
        await page.locator('[data-security-row="Maximum password age"]').dblclick();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await page.getByLabel('Define this policy setting', { exact: true }).check();
        await page.getByLabel('Password expires after:', { exact: true }).fill('42');
        assert.equal(await page.locator('.gpo-security-dialog .field__element input[type=number]').count(), 1);
        const mismatches = await page.evaluate(() => {
            const actual = document.querySelector('.gpo-security-dialog');
            const reference = actual.cloneNode(true);
            reference.id = 'reference';
            reference.querySelectorAll('*').forEach(element => {
                Array.from(element.classList).filter(name => name.startsWith('gpo-security')).forEach(name => element.classList.remove(name));
            });
            reference.classList.remove('gpo-security-dialog');
            actual.parentNode.appendChild(reference);
            const comparisons = [
                ['.preference__modal-header', ['backgroundColor', 'borderBottom', 'height']],
                ['.preference__modal-footer', ['height', 'padding', 'borderTop', 'gap']],
                ['.btn-cancel', ['width', 'height', 'padding', 'border', 'backgroundColor', 'color']],
                ['.btn-ok', ['width', 'height', 'padding', 'border', 'backgroundColor', 'color']],
                ['.preference__tab-button', ['height', 'padding', 'border', 'backgroundColor', 'color']],
                ['.preference__tab-button[aria-selected=false]', ['height', 'padding', 'border', 'backgroundColor', 'color']],
                ['input[type=number]', ['padding', 'border', 'borderRadius', 'fontSize', 'height']]
            ];
            const mismatches = [];
            for (const [selector, properties] of comparisons) {
                const left = getComputedStyle(actual.querySelector(selector));
                const right = getComputedStyle(reference.querySelector(selector));
                for (const property of properties) if (left[property] !== right[property]) mismatches.push(selector + '.' + property + ': ' + left[property] + ' != ' + right[property]);
            }
            reference.remove();
            return mismatches;
        });
        assert.deepEqual(mismatches, []);
        await page.getByRole('tab', { name: 'Security Policy Setting', exact: true }).press('ArrowRight');
        assert.equal(await page.getByRole('tab', { name: 'Explanation', exact: true }).getAttribute('aria-selected'), 'true');
        await page.getByRole('tab', { name: 'Explanation', exact: true }).press('Home');
        await page.keyboard.press('Escape');
        await page.getByRole('alertdialog').waitFor();
        assert.equal(await dialog.evaluate(element => element.inert), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.getByLabel('Password expires after:', { exact: true }).inputValue(), '42');
        assert.equal(await dialog.evaluate(element => element.inert), false);
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await page.getByRole('alertdialog').waitFor();
        assert.equal(await page.getByRole('alertdialog').getByRole('cell', { name: 'Minimum password age' }).count(), 1);
        assert.equal(await dialog.evaluate(element => element.inert), true);
        assert.equal(await page.evaluate(() => requests.length), 0);
        if (process.env.SECURITY_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.SECURITY_SCREENSHOT_DIR, 'security-preferences-dependencies-en.png'), animations: 'disabled' });
        }
        await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await page.getByLabel('Password expires after:', { exact: true }).inputValue(), '42');
        assert.equal(await page.evaluate(() => requests.length), 0);
        assert.equal(await dialog.evaluate(element => element.inert), false);
        assert.equal(await page.locator('.gpo-security-dialog__apply').evaluate(element => element === document.activeElement), true);
        if (process.env.SECURITY_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.SECURITY_SCREENSHOT_DIR, 'security-preferences-dialog-en.png'), animations: 'disabled' });
        }
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Apply changes' }).click();
        await dialog.waitFor({ state: 'hidden' });
        const requests = await page.evaluate(() => window.requests);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].policies.length, 2);
        assert.ok(requests[0].policies.every(policy => policy.transition === 'define'));
        const defaults = { 'account.password.maximum_password_age': 42, 'account.password.minimum_password_age': 0 };
        const settings = Object.fromEntries(requests[0].policies.map(policy => [policy.policy_id,
            policy.elements.length ? policy.elements[0].value.value : defaults[policy.policy_id]]));
        assert.deepEqual(settings, { 'account.password.maximum_password_age': 42, 'account.password.minimum_password_age': 0 });
        await page.evaluate(async () => {
            translations.setLanguage('ru');
            response.security_catalog.policies[0].display_name = 'Максимальный срок действия пароля';
            response.security_catalog.policies[0].controls[0].label = 'Срок действия пароля (дней):';
            response.security_catalog.policies[1].display_name = 'Минимальный срок действия пароля';
            await show();
        });
        await page.locator('[data-security-row="Максимальный срок действия пароля"]').dblclick();
        await page.getByLabel('Определить этот параметр политики', { exact: true }).check();
        assert.equal(await page.getByRole('button', { name: 'Применить', exact: true }).isVisible(), true);
        if (process.env.SECURITY_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.SECURITY_SCREENSHOT_DIR, 'security-preferences-dialog-ru.png'), animations: 'disabled' });
        }
        await page.getByRole('button', { name: 'Применить', exact: true }).click();
        await page.getByRole('alertdialog').waitFor();
        assert.equal(await page.getByRole('alertdialog').getByRole('button', { name: 'Применить изменения', exact: true }).isVisible(), true);
        if (process.env.SECURITY_SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.SECURITY_SCREENSHOT_DIR, 'security-preferences-dependencies-ru.png'), animations: 'disabled' });
        }
        await page.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click();
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
});
