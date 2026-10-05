'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
let chromium;
let requireJs;
try { chromium = require('playwright').chromium; requireJs = require.resolve('requirejs/require.js'); } catch (_) { /* Optional browser tools. */ }
const skip = !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false;
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="before">Before</button><main id="content"></main><button id="after">After</button>
<script src="/require.js"></script><script>
require.config({baseUrl:'/js'});
require(['components/templates/preference/targeting-typed-input'], typed => {
 window.mount = options => {
  window.changes=[];
  window.control=typed.render(Object.assign({type:'ipv4',value:null,disabled:false,language:'en',onChange:value=>changes.push(value)},options));
  document.getElementById('content').replaceChildren(control.element.getElement());
 };
 window.snapshot=()=>({value:control.readValue(),inputs:control.inputs.map(input=>input.value),changes:changes.slice(),active:control.inputs.indexOf(document.activeElement)});
 mount({});window.ready=true;
});</script></body></html>`;

async function fixture(run) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try { response.setHeader('Content-Type', 'application/javascript'); response.end(fs.readFileSync(filename)); }
        catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.setDefaultTimeout(4000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        await run(page);
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const cells = page => page.locator('#content input');
const state = page => page.evaluate(() => snapshot());
async function mount(page, options) { await page.evaluate(options => window.mount(options), options); }
async function paste(page, value, index = 0, select = false) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(value => navigator.clipboard.writeText(value), value);
    await cells(page).nth(index).focus();
    if (select) await cells(page).nth(index).press('Control+A');
    await cells(page).nth(index).press('Control+V');
}

test('Actual AMD controls preserve absence and saved representations through focus and navigation', { skip }, async () => fixture(async page => {
    const ids = new Set();
    for (const [type, count] of [['ipv4', 4], ['mac', 6], ['version', 4], ['guid', 1], ['ipv6', 1]]) {
        await mount(page, { type, value: null });
        assert.equal(await cells(page).count(), count, type);
        assert.deepEqual((await state(page)).inputs, Array(count).fill(''), type);
        await page.evaluate(() => control.focus());
        await page.keyboard.press('Tab');
        assert.equal((await state(page)).value, '', type);
        assert.deepEqual((await state(page)).changes, [], type);
        for (const id of await cells(page).evaluateAll(inputs => inputs.map(input => input.id))) {
            assert.ok(id, type);
            assert.equal(ids.has(id), false, type);
            ids.add(id);
        }
    }
    for (const [type, value, expected] of [
        ['ipv4', '001.02.3.004', ['001', '02', '3', '004']],
        ['mac', 'aa-BB-cc-DD-ee-FF', ['aa', 'BB', 'cc', 'DD', 'ee', 'FF']],
        ['version', '1.2', ['1', '2', '', '']],
        ['guid', '{abcdef01-2345-6789-abcd-ef0123456789}', ['{abcdef01-2345-6789-abcd-ef0123456789}']],
        ['ipv6', '2001:0DB8:0000:0000:0000:0000:0000:0001', ['2001:0DB8:0000:0000:0000:0000:0000:0001']]
    ]) {
        await mount(page, { type, value });
        assert.deepEqual((await state(page)).inputs, expected, type);
        await page.evaluate(() => control.focus());
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Tab');
        assert.equal((await state(page)).value, value, type);
        assert.deepEqual((await state(page)).changes, [], type);
    }
}));

test('IPv4 supports separator typing, empty Backspace navigation, and ordinary Tab order', { skip }, async () => fixture(async page => {
    await page.evaluate(() => control.focus());
    await page.keyboard.type('10.20.30.40');
    assert.deepEqual((await state(page)).inputs, ['10', '20', '30', '40']);
    assert.equal((await state(page)).value, '10.20.30.40');
    await cells(page).nth(2).fill('');
    await cells(page).nth(2).press('Backspace');
    assert.equal((await state(page)).active, 1);
    assert.equal(await cells(page).nth(1).evaluate(input => input.selectionStart), 2);
    await page.keyboard.press('Tab');
    assert.equal((await state(page)).active, 2);
    await page.keyboard.press('Shift+Tab');
    assert.equal((await state(page)).active, 1);
    await cells(page).last().press('Tab');
    assert.equal(await page.locator('#after').evaluate(input => input === document.activeElement), true);
}));

test('IPv4 paste distributes the whole address and rejects invalid characters, ranges, and excess components without truncation', { skip }, async () => fixture(async page => {
    await paste(page, '192.168.0.255');
    assert.deepEqual((await state(page)).inputs, ['192', '168', '0', '255']);
    await paste(page, '10.20.30.40', 2);
    assert.equal((await state(page)).value, '10.20.30.40');
    const before = await state(page);
    for (const invalid of ['1.2.3.256', '1.2.3.4.5', '1.2.x3.4', '1234.2.3.4']) {
        await paste(page, invalid, 1);
        assert.deepEqual(await state(page), Object.assign({}, before, { active: 1 }), invalid);
    }
    await cells(page).first().fill('255');
    const max = await state(page);
    await cells(page).first().fill('256');
    await cells(page).first().fill('1234');
    await cells(page).first().fill('12x');
    assert.deepEqual(await state(page), Object.assign({}, max, { active: 0 }));
    // Cover autofill / input paths that do not supply cancellable beforeinput data.
    await cells(page).first().evaluate(input => { input.value='999'; input.dispatchEvent(new Event('input', {bubbles:true})); });
    assert.equal(await cells(page).first().inputValue(), '255');
    assert.equal((await state(page)).value, max.value);
    await paste(page, '1.2', 0);
    assert.deepEqual((await state(page)).inputs, ['1', '2', '', '']);
    assert.equal((await state(page)).value, '1.2');
}));

test('MAC supports six bytes, hex typing, hyphen and compact paste, and intentional colon canonicalization', { skip }, async () => fixture(async page => {
    await mount(page, { type: 'mac', value: 'aa-bb-cc-dd-ee-ff' });
    await page.evaluate(() => control.focus());
    assert.equal((await state(page)).value, 'aa-bb-cc-dd-ee-ff');
    await cells(page).first().fill('AA');
    assert.equal((await state(page)).value, 'AA:bb:cc:dd:ee:ff');
    await paste(page, '01-23-45-67-89-ab', 3);
    assert.deepEqual((await state(page)).inputs, ['01', '23', '45', '67', '89', 'ab']);
    assert.equal((await state(page)).value, '01:23:45:67:89:ab');
    await paste(page, 'AABBCCDDEEFF');
    assert.equal((await state(page)).value, 'AA:BB:CC:DD:EE:FF');
    const before = await state(page);
    for (const invalid of ['00:11:22:33:44:gg', '00:11:22:33:44:55:66', '00:11-22:33:44:55', '001:22:33:44:55:66']) {
        await paste(page, invalid, 5);
        assert.deepEqual(await state(page), before, invalid);
    }
    await mount(page, { type: 'mac', value: null });
    await page.evaluate(() => control.focus());
    await page.keyboard.type('aA-bB:cC:dD:eE:fF');
    assert.equal((await state(page)).value, 'aA:bB:cC:dD:eE:fF');
    await cells(page).last().fill('fff');
    await cells(page).last().fill('g0');
    assert.equal(await cells(page).last().inputValue(), 'fF');
}));

test('Version uses four 16-bit components and preserves abbreviated values until deliberate edits', { skip }, async () => fixture(async page => {
    await mount(page, { type: 'version', value: '1.2' });
    assert.equal((await state(page)).value, '1.2');
    await cells(page).nth(1).fill('3');
    assert.equal((await state(page)).value, '1.3');
    await cells(page).nth(3).fill('65535');
    assert.equal((await state(page)).value, '1.3..65535');
    await cells(page).nth(3).fill('65536');
    await cells(page).nth(3).fill('123456');
    assert.equal(await cells(page).nth(3).inputValue(), '65535');
    const before = await state(page);
    await paste(page, '1.2.3.65536', 3);
    assert.deepEqual(await state(page), before);
    await paste(page, '1.2.3.65535', 2);
    assert.equal((await state(page)).value, '1.2.3.65535');
    await paste(page, '2.5', 0);
    assert.deepEqual((await state(page)).inputs, ['2', '5', '', '']);
    assert.equal((await state(page)).value, '2.5');
    await cells(page).nth(1).fill('');
    assert.equal((await state(page)).value, '2');
    await cells(page).first().fill('');
    assert.equal((await state(page)).value, '');
}));

test('GUID masks a full input and canonicalizes complete intentional edits to uppercase with braces', { skip }, async () => fixture(async page => {
    const saved = 'abcdef01-2345-6789-abcd-ef0123456789';
    const canonical = '{ABCDEF01-2345-6789-ABCD-EF0123456789}';
    await mount(page, { type: 'guid', value: saved });
    assert.equal(await cells(page).first().inputValue(), saved);
    assert.equal((await state(page)).value, saved);
    await paste(page, '{abcdef01-2345-6789-abcd-ef0123456789}');
    assert.equal((await state(page)).value, canonical);
    assert.equal(await cells(page).first().inputValue(), canonical);
    const before = await state(page);
    for (const invalid of ['abcdef01-2345-6789-abcd-ef012345678g', '{abcdef01-2345-6789-abcd-ef0123456789}x', 'abcdef0-12345-6789-abcd-ef0123456789']) {
        await paste(page, invalid);
        assert.deepEqual(await state(page), before, invalid);
    }
    await mount(page, { type: 'guid', value: null });
    await cells(page).first().pressSequentially('abcdef0123456789abcdef0123456789');
    assert.equal((await state(page)).value, canonical);
    await cells(page).first().press('x');
    assert.equal((await state(page)).value, canonical);
    await mount(page, { type: 'guid', value: null });
    await cells(page).first().fill('abcdef012345');
    assert.equal((await state(page)).value, 'abcdef01-2345');
}));

test('IPv6 accepts full addresses and partial colon forms without normalizing their text', { skip }, async () => fixture(async page => {
    const saved = '2001:0DB8:0000:0000:0000:0000:0000:0001';
    await mount(page, { type: 'ipv6', value: saved });
    assert.equal(await cells(page).count(), 1);
    assert.equal((await state(page)).value, saved);
    assert.deepEqual((await state(page)).changes, []);
    for (const value of ['2001:db8::1', '2001:DB8:0:0:0:0:0:1', '::ffff:192.0.2.1', '::']) {
        await paste(page, value);
        assert.equal(await cells(page).first().inputValue(), value);
        assert.equal((await state(page)).value, value);
    }
    const before = await state(page);
    for (const invalid of ['fe80::1%eth0', '2001:db8::1 ', '2001:db8::g1', '[2001:db8::1]']) {
        await paste(page, invalid);
        assert.deepEqual(await state(page), before, invalid);
    }
    await cells(page).first().fill('2001:');
    assert.equal((await state(page)).value, '2001:');
    await cells(page).first().pressSequentially('db8::');
    assert.equal((await state(page)).value, '2001:db8::');
    await cells(page).first().press('%');
    assert.equal((await state(page)).value, '2001:db8::');
}));

test('GUID Backspace and Delete remove hex digits across braces and separators without trapping the caret', { skip }, async () => fixture(async page => {
    const saved = '{abcdef01-2345-6789-abcd-ef0123456789}';
    await mount(page, { type: 'guid', value: saved });
    await cells(page).first().focus();
    await cells(page).first().press('End');
    await cells(page).first().press('Backspace');
    assert.equal((await state(page)).value, '{abcdef01-2345-6789-abcd-ef012345678');
    await cells(page).first().press('Backspace');
    assert.equal((await state(page)).value, '{abcdef01-2345-6789-abcd-ef01234567');
    await mount(page, { type: 'guid', value: saved });
    await cells(page).first().evaluate(input => { input.focus(); input.setSelectionRange(10, 10); });
    await cells(page).first().press('Backspace');
    assert.equal((await state(page)).value, '{abcdef02-3456-789a-bcde-f0123456789');
    assert.equal(await cells(page).first().evaluate(input => input.selectionStart), 8);
    await mount(page, { type: 'guid', value: saved });
    await cells(page).first().press('Home');
    await cells(page).first().press('Delete');
    assert.equal((await state(page)).value, '{bcdef012-3456-789a-bcde-f0123456789');
    await cells(page).first().press('Control+A');
    await cells(page).first().press('Backspace');
    assert.equal((await state(page)).value, '');
    assert.equal(await cells(page).first().inputValue(), '');
    await cells(page).first().press('{');
    await cells(page).first().press('Backspace');
    assert.equal((await state(page)).value, '');
}));

test('Malformed saved values remain fully visible and unchanged in fallback fields until corrected', { skip }, async () => fixture(async page => {
    for (const [type, value, replacement, expected] of [
        ['ipv4', '999.1.2.3 saved legacy operand', '1.2.3.4', '1.2.3.4'],
        ['mac', 'a malformed legacy MAC value', '00-11-22-33-44-55', '00:11:22:33:44:55'],
        ['version', '1.2.3.4.5 legacy version', '1.2.3.4', '1.2.3.4'],
        ['guid', 'an arbitrary saved run-once identifier', 'abcdef01-2345-6789-abcd-ef0123456789', '{ABCDEF01-2345-6789-ABCD-EF0123456789}'],
        ['ipv6', 'fe80::1%legacy-zone', 'fe80::1', 'fe80::1']
    ]) {
        await mount(page, { type, value });
        assert.equal(await cells(page).count(), 1, type);
        assert.equal(await page.locator('.gpo-targeting-typed-input__fallback').inputValue(), value, type);
        await page.evaluate(() => control.focus());
        await page.keyboard.press('End');
        await page.keyboard.press('Tab');
        assert.equal((await state(page)).value, value, type);
        assert.deepEqual((await state(page)).changes, [], type);
        await paste(page, replacement, 0, true);
        assert.equal(await cells(page).first().inputValue(), expected, type);
        assert.equal((await state(page)).value, expected, type);
    }
    await mount(page, { type: 'ipv4', value: '999.1.2.3' });
    await cells(page).first().focus();
    await cells(page).first().press('Home');
    await cells(page).first().press('Delete');
    assert.equal((await state(page)).value, '99.1.2.3');
}));

test('Disabled controls cannot emit edits, including synthetic input and paste events', { skip }, async () => fixture(async page => {
    for (const [type, value] of [['ipv4', '1.2.3.4'], ['mac', 'AA:BB:CC:DD:EE:FF'], ['version', '1.2'], ['guid', 'legacy GUID value'], ['ipv6', '2001:db8::1']]) {
        await mount(page, { type, value, disabled: true });
        assert.equal(await cells(page).evaluateAll(inputs => inputs.every(input => input.disabled)), true, type);
        await cells(page).first().evaluate(input => {
            input.value='9';input.dispatchEvent(new Event('input', {bubbles:true}));
            const clipboardData=new DataTransfer();clipboardData.setData('text/plain','8');
            input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
        });
        assert.equal((await state(page)).value, value, type);
        assert.deepEqual((await state(page)).changes, [], type);
        await page.locator('#before').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#after').evaluate(input => input === document.activeElement), true, type);
    }
}));

test('Groups and every component have accessible English and Russian names', { skip }, async () => fixture(async page => {
    await mount(page, { type: 'ipv4', label: 'Minimum address', language: 'en' });
    assert.equal(await page.getByRole('group', { name: 'Minimum address', exact: true }).count(), 1);
    for (let i = 0; i < 4; i++) assert.equal(await cells(page).nth(i).getAttribute('aria-label'), 'Minimum address, Octet ' + (i + 1) + ' of 4');
    assert.equal(await page.locator('.gpo-targeting-typed-input__separator').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-hidden') === 'true')), true);
    await mount(page, { type: 'mac', language: 'ru' });
    assert.equal(await page.getByRole('group', { name: 'MAC-адрес', exact: true }).count(), 1);
    for (let i = 0; i < 6; i++) assert.equal(await cells(page).nth(i).getAttribute('aria-label'), 'MAC-адрес, Байт ' + (i + 1) + ' из 6');
    await mount(page, { type: 'version', label: 'Минимальная версия', language: 'ru' });
    assert.equal(await cells(page).nth(2).getAttribute('aria-label'), 'Минимальная версия, Компонент 3 из 4');
    await mount(page, { type: 'guid', label: 'Идентификатор', language: 'ru', value: 'legacy saved value' });
    assert.equal(await cells(page).first().getAttribute('aria-label'), 'Идентификатор, сохранённое значение');
}));
