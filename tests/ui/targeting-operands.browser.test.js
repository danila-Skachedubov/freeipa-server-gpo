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
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css"></head>
<body><main id="content" style="padding:20px;width:700px"></main><script src="/require.js"></script><script>
require.config({baseUrl:'/js'});
require(['util/element-creator','util/editor-dto','components/templates/preference/targeting-presentations','components/templates/preference/targeting-operand-editor'],(elements,dto,presentations,operands)=>{
 const create=elements.createElement;
 function field(id,kind,value,required=false){return {id:'filter.'+id,label:id,control:'text',editable:true,required,value:{kind,value}};}
 function fields(kind){
  const common=[field('bool','filter_combine','and'),field('not','boolean',false),field('hidden','optional_boolean',null)];
  const text=(id,value='',required=true)=>field(id,'text',value,required);
  const opt=(id,value=null)=>field(id,'optional_text',value);
  const bool=(id,value=null)=>field(id,'optional_boolean',value);
  const byte=(id,value=null)=>field(id,'optional_unsigned_byte',value);
  const bounds=()=>[opt('min'),opt('max'),bool('gte'),bool('lte')];
  const specific={
   battery:[],computer:[text('type','NETBIOS'),text('name','host')],cpu:[text('speedMHz','1000')],
   date:[text('period','WEEKLY'),opt('dow','MON'),byte('day'),byte('month'),opt('year')],
   disk:[byte('freeSpace',20),text('drive','System')],domain:[text('name','EXAMPLE'),bool('userContext')],dun:[text('type','')],
   file:[text('path','example.cmd'),opt('type'),bool('folder'),...bounds()],ip_range:[bool('useIPv6'),text('min','10.0.0.1'),text('max','10.0.0.9')],
   language:[Object.assign(text('languageLocale','unknown'),{control:'choice',choices:[{key:'unknown',label:'Unknown'},{key:'en-US',label:'English (United States)'},{key:'ru-RU',label:'Russian (Russia)'}]}),bool('default'),bool('system'),bool('native'),opt('displayName')],
   ldap:[text('binding','LDAP:'),opt('searchFilter'),opt('attribute'),opt('variableName')],mac_range:[text('min','00:00:00:00:00:01'),text('max','00:00:00:00:00:09')],
   msi:[text('type','PRODUCT'),text('subtype','EXISTS'),opt('code'),opt('item'),opt('value'),...bounds()],org_unit:[text('name','OU=Computers,DC=example,DC=test'),bool('userContext'),bool('directMember')],
   pcmcia:[],portable:[bool('unknown'),bool('docked'),bool('undocked')],proc_mode:['synchFore','asynchFore','backRefr','forceRefr','linkTrns','noChg','rsopTrns','safeBoot','slowLink','verbLog','rsopEnbl'].map(id=>bool(id)),
   ram:[text('totalMB','4096')],run_once:[text('id',''),bool('userContext'),opt('comments')],site:[text('name','Headquarters')],
   terminal:[text('type','NE'),text('option','NE'),text('value',''),opt('min'),opt('max')],time:[text('begin','12:00:00'),text('end','13:00:00')],user:[opt('name','ExampleUser'),opt('sid')],variable:[text('variableName','TEMP'),opt('value')],
   os:['version','edition','sp','type','class'].map(id=>opt(id)),registry:[opt('type'),opt('subtype'),opt('valueName'),opt('valueType'),opt('valueData'),opt('variableName'),text('key','Software\\\\Example'),opt('hive'),...bounds(),opt('version')],
   wmi:[text('query','SELECT * FROM Win32_OperatingSystem'),opt('nameSpace'),opt('property'),opt('variableName')],group:[opt('name','ExampleGroup'),opt('sid'),bool('userContext'),bool('primaryGroup'),bool('localGroup')],collection:[opt('name')]
  };
  return common.concat(specific[kind]||[]);
 }
 function fieldControl(field,disabled){
  const envelope=dto.clone(field.value);let input;
  if(field.control==='choice')input=create('select',{children:(field.choices||[]).map(choice=>create('option',{attrs:{value:choice.key},text:choice.label}))});
  else input=create('input',{attrs:{type:envelope.kind==='boolean'||envelope.kind==='optional_boolean'?'checkbox':envelope.kind.indexOf('unsigned')>=0?'number':'text'}});
  const dom=input.getElement();dom.disabled=Boolean(disabled);dom.value=envelope.value==null?'':String(envelope.value);dom.checked=envelope.value===true;
  const error=create('span',{className:'gpo-editor-field__error'});
  const element=create('div',{className:['field','field__input','gpo-editor-field'],attrs:{'data-field-id':field.id},children:[create('span',{text:field.label}),input,error]});
  return {id:field.id,element,read:()=>envelope.kind==='optional_boolean'?{kind:envelope.kind,value:dom.checked}:dto.preferenceValueFromInput(envelope,dom.value,dom.checked),setError:message=>error.setText(message||''),focus:()=>dom.focus()};
 }
 window.mount=(kind,options={})=>{
  window.options=options;
  window.node={kind,available:true,originalPath:options.existing?[0]:null,fields:options.fields||fields(kind)};
  if(!options.existing)node.fields=operands.initialize(node,{language:options.language||'en',scope:options.scope||'user'});
  window.before=dto.clone(node.fields);window.changes=[];
  window.reselect=()=>{
   window.editor=operands.render({node,blocked:options.blocked,scope:options.scope||'user',language:options.language||'en',fieldControl,pt:key=>key,onChange:()=>{node.fields=editor.readFields();changes.push(dto.clone(node.fields));}});
   document.getElementById('content').replaceChildren(editor.element.getElement());
  };
  reselect();
 };
 window.payload=id=>dto.valuePayload(editor.readFields().find(field=>field.id==='filter.'+id).value);
 window.accept=()=>{node.fields=editor.readFields();return editor.validate();};
 window.coverage=()=>presentations.supportedKinds.map(kind=>{mount(kind);return {kind,ids:Array.from(document.querySelectorAll('[data-field-id]')).map(element=>element.dataset.fieldId),envelopes:editor.readFields(),errors:editor.validate()};});
 mount('computer');window.ready=true;
});</script></body></html>`;

async function fixture(run) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
        const filename = request.url === '/require.js' ? requireJs : path.join(root, request.url);
        try { response.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : 'application/javascript'); response.end(fs.readFileSync(filename)); }
        catch (_) { response.statusCode = 404; response.end('Missing'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        page.setDefaultTimeout(4000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        await run(page);
        assert.deepEqual(errors, []);
    } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
const input = (page, id) => page.locator('[data-field-id="filter.' + id + '"] input,[data-field-id="filter.' + id + '"] textarea');
const select = (page, id) => page.locator('[data-field-id="filter.' + id + '"] select');
const payload = (page, id) => page.evaluate(id => window.payload(id), id);
async function fillTyped(page, id, value) {
    const parts = value.split(/[.:-]/);
    const inputs = input(page, id);
    for (let index = 0; index < await inputs.count(); index++) await inputs.nth(index).fill(parts[index] || '');
}

test('All 29 targeting kinds deliberately render without common metadata or incidental normalization', { skip }, async () => fixture(async page => {
    const results = await page.evaluate(() => coverage());
    assert.equal(results.length, 29);
    for (const result of results) {
        assert.equal(result.ids.some(id => ['filter.bool', 'filter.not', 'filter.combine', 'filter.negate', 'filter.hidden', 'filter.displayName'].includes(id)), false, result.kind);
        assert.deepEqual(result.errors, [], result.kind);
    }
    const controls = await page.evaluate(() => {
        const result = [];
        for (const kind of ['domain', 'group', 'os', 'language', 'portable', 'proc_mode', 'file', 'registry', 'collection']) {
            mount(kind, { existing: true }); result.push({ kind, before, after: editor.readFields(), errors: editor.validate() });
        }
        return result;
    });
    for (const control of controls) { assert.deepEqual(control.after, control.before, control.kind); assert.deepEqual(control.errors, [], control.kind); }
}));

test('Date offers weekly/monthly/date, clears incompatible fields, restores mode drafts and supports an annual leap-day calendar', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mount('date', { language: 'ru' }));
    assert.deepEqual(await select(page, 'period').locator('option').allTextContents(), ['Еженедельно', 'Ежемесячно', 'Дата']);
    await select(page, 'dow').selectOption('FRI');
    await select(page, 'period').focus();
    await select(page, 'period').selectOption('MONTHLY');
    assert.equal(await select(page, 'period').evaluate(element => element === document.activeElement), true);
    await select(page, 'day').selectOption('31');
    await select(page, 'period').selectOption('WEEKLY');
    assert.equal(await payload(page, 'day'), null);
    assert.equal(await payload(page, 'dow'), 'FRI');
    await select(page, 'period').selectOption('MONTHLY');
    assert.equal(await payload(page, 'day'), 31);
    await select(page, 'period').selectOption('YEARLY');
    await input(page, 'day').fill('2028-02-29');
    await page.locator('[data-field-id="targeting.everyYear"] input').check();
    assert.equal(await page.locator('[data-field-id="targeting.everyYear"] input').evaluate(element => element === document.activeElement), true);
    assert.equal(await payload(page, 'year'), null);
    assert.equal(await page.locator('input[type="date"]').count(), 0);
    assert.equal(await page.locator('[data-field-id="filter.year"]').count(), 0);
    await select(page, 'month').selectOption('2');
    await page.locator('[data-calendar-day="29"]').click();
    assert.equal(await page.locator('[data-calendar-day="29"]').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.gpo-editor-targeting-calendar__weekday').count(), 0);
    assert.equal(await payload(page, 'day'), 29);
    assert.deepEqual(await page.evaluate(() => accept()), []);
    await page.evaluate(() => reselect());
    assert.equal(await page.locator('[data-calendar-day="29"]').getAttribute('aria-pressed'), 'true');
    await select(page, 'period').selectOption('WEEKLY');
    await select(page, 'period').selectOption('YEARLY');
    assert.equal(await payload(page, 'year'), null);
    assert.equal(await payload(page, 'month'), 2);
    assert.equal(await payload(page, 'day'), 29);
    await page.locator('[data-field-id="targeting.everyYear"] input').uncheck();
    assert.equal(await payload(page, 'year'), '2028');
    assert.equal(await input(page, 'day').inputValue(), '2028-02-29');
}));

test('Computer and Language use deliberate localized selectors and preserve a broken loaded locale until replaced', { skip }, async () => fixture(async page => {
    await select(page, 'type').selectOption('DNS');
    await input(page, 'name').fill('host.example.test');
    assert.equal(await payload(page, 'type'), 'DNS');
    assert.equal(await payload(page, 'name'), 'host.example.test');
    await page.evaluate(() => mount('language', { language: 'ru', scope: 'computer' }));
    assert.equal(await select(page, 'languageLocale').inputValue(), 'ru-RU');
    assert.equal(await select(page, 'languageLocale').locator('option[value="unknown"]').count(), 0);
    assert.equal(await input(page, 'default').isDisabled(), true);
    assert.equal(await page.locator('[data-field-id="filter.default"]').textContent(), 'Пользователь');
    assert.equal(await page.locator('[data-field-id="filter.system"]').textContent(), 'Системный');
    assert.equal(await page.locator('[data-field-id="filter.native"]').textContent(), 'Собственный');
    assert.equal(await page.locator('.gpo-targeting-language__hint').textContent(), 'Язык пользователя доступен только в разделе «Пользователь».');
    assert.equal(await payload(page, 'system'), true);
    assert.equal(await page.locator('[data-field-id="filter.displayName"]').count(), 0);
    assert.match(await payload(page, 'displayName'), /рус/i);
    await select(page, 'languageLocale').selectOption('en-US');
    const shown = await select(page, 'languageLocale').locator('option:checked').textContent();
    assert.equal(await payload(page, 'displayName'), shown);
    await page.evaluate(() => {
        mount('language', { existing: true, language: 'ru' });
        node.fields.find(field => field.id === 'filter.displayName').value.value = 'Legacy broken label';
        reselect();
    });
    assert.equal(await select(page, 'languageLocale').inputValue(), 'unknown');
    assert.equal(await payload(page, 'displayName'), 'Legacy broken label');
    assert.deepEqual(await page.evaluate(() => accept()), []);
    await select(page, 'languageLocale').selectOption('ru-RU');
    assert.notEqual(await payload(page, 'displayName'), 'Legacy broken label');
}));

test('File, Registry, MSI and Terminal expose only active operands while draft values survive reselection', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mount('file', { existing: true }));
    await select(page, 'type').selectOption('VERSION');
    await fillTyped(page, 'min', '1.2.3.4'); await fillTyped(page, 'max', '5.6');
    await select(page, 'gte').selectOption('true');
    assert.equal(await payload(page, 'gte'), true);
    await select(page, 'type').selectOption('FOLDER');
    assert.equal(await input(page, 'min').count(), 0); assert.equal(await payload(page, 'folder'), true);
    await page.evaluate(() => accept()); await page.evaluate(() => reselect());
    await select(page, 'type').selectOption('VERSION');
    assert.equal(await payload(page, 'min'), '1.2.3.4'); assert.equal(await payload(page, 'folder'), false);
    await page.evaluate(() => mount('registry'));
    await select(page, 'type').selectOption('VALUEEXISTS');
    await input(page, 'valueName').fill('OriginalName');
    await page.locator('[data-field-id="targeting.defaultName"] input').check();
    assert.equal(await payload(page, 'valueName'), ''); assert.equal(await input(page, 'valueName').isDisabled(), true);
    await page.locator('[data-field-id="targeting.defaultName"] input').uncheck();
    assert.equal(await input(page, 'valueName').inputValue(), 'OriginalName');
    await select(page, 'type').selectOption('VERSION');
    assert.equal(await payload(page, 'type'), 'MATCHVALUE'); assert.equal(await payload(page, 'subtype'), 'VERSION');
    assert.equal(await input(page, 'valueData').count(), 0);
    await select(page, 'type').selectOption('GETVALUE');
    assert.equal(await input(page, 'min').count(), 0); assert.equal(await input(page, 'variableName').count(), 1);
    await page.evaluate(() => mount('msi'));
    await select(page, 'subtype').selectOption('VERSION'); assert.equal(await input(page, 'min').count(), 4);
    await select(page, 'subtype').selectOption('MATCH_PROPERTY'); assert.equal(await input(page, 'min').count(), 0); assert.equal(await input(page, 'item').count(), 1);
    await select(page, 'subtype').selectOption('GET_PROPERTY'); assert.equal(await input(page, 'value').getAttribute('aria-label'), 'Value');
    await page.evaluate(() => mount('terminal'));
    assert.equal(await input(page, 'value').count(), 0); assert.deepEqual(await page.evaluate(() => accept()), []);
    await select(page, 'option').selectOption('IP'); assert.equal(await input(page, 'value').count(), 0); assert.equal(await input(page, 'min').count(), 4);
    await select(page, 'option').selectOption('PROGRAM'); assert.equal(await input(page, 'min').count(), 0); assert.equal(await input(page, 'value').count(), 1);
}));

test('Name/SID mode clears the competing value without losing drafts, scope restrictions disable controls, and readonly prevents writes', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mount('user'));
    await input(page, 'name').fill('EditedUser');
    await page.locator('[data-field-id="targeting.userMatch"] select').selectOption('sid');
    assert.equal(await payload(page, 'name'), null);
    await input(page, 'sid').fill('S-1-5-21-1-2-3-1000');
    await page.evaluate(() => accept()); await page.evaluate(() => reselect());
    await page.locator('[data-field-id="targeting.userMatch"] select').selectOption('name');
    assert.equal(await payload(page, 'sid'), null); assert.equal(await input(page, 'name').inputValue(), 'EditedUser');
    await page.locator('[data-field-id="targeting.userMatch"] select').selectOption('sid');
    assert.equal(await input(page, 'sid').inputValue(), 'S-1-5-21-1-2-3-1000');
    await page.evaluate(() => mount('group', { scope: 'computer' }));
    assert.equal(await select(page, 'userContext').isDisabled(), true); assert.equal(await input(page, 'primaryGroup').isDisabled(), true);
    await page.evaluate(() => mount('file', { existing: true, blocked: true }));
    assert.equal(await select(page, 'type').isDisabled(), true); assert.equal(await input(page, 'path').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => editor.readFields()), await page.evaluate(() => before));
}));

test('IPv6 switches to address/prefix operands, retains both mode drafts, and validates compressed/mapped addresses and prefix boundaries', { skip }, async () => fixture(async page => {
    await page.evaluate(() => mount('ip_range', { language: 'ru', existing: true }));
    assert.equal(await payload(page, 'useIPv6'), null);
    assert.equal(await input(page, 'min').count(), 4);
    await page.locator('[data-field-id="filter.useIPv6"] input').check();
    assert.equal(await input(page, 'min').count(), 1);
    assert.equal(await input(page, 'min').getAttribute('aria-label'), 'IPv6-адрес');
    assert.equal(await input(page, 'max').getAttribute('aria-label'), 'Длина префикса');
    assert.equal(await input(page, 'max').getAttribute('type'), 'number');
    assert.equal(await input(page, 'max').getAttribute('max'), '128');
    assert.equal(await payload(page, 'max'), '128');
    for (const address of ['::', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '::ffff:192.0.2.1']) {
        await input(page, 'min').fill(address);
        for (const prefix of ['0', '64', '128']) {
            await input(page, 'max').fill(prefix);
            assert.deepEqual(await page.evaluate(() => accept()), [], address + '/' + prefix);
        }
    }
    await input(page, 'min').fill('2001:db8::beef'); await input(page, 'max').fill('73');
    await page.locator('[data-field-id="filter.useIPv6"] input').uncheck();
    assert.equal(await payload(page, 'min'), '10.0.0.1'); assert.equal(await payload(page, 'max'), '10.0.0.9');
    await fillTyped(page, 'min', '192.0.2.1'); await fillTyped(page, 'max', '192.0.2.9');
    await page.evaluate(() => accept()); await page.evaluate(() => reselect());
    await page.locator('[data-field-id="filter.useIPv6"] input').check();
    assert.equal(await payload(page, 'min'), '2001:db8::beef'); assert.equal(await payload(page, 'max'), '73');
    for (const address of ['2001:::1', '2001:db8', '1:2:3:4:5:6:7:8:9', '::ffff:192.0.2.999']) {
        await input(page, 'min').fill(address);
        assert.equal(await page.evaluate(() => accept()[0].code), 'invalid_ipv6', address);
    }
    await input(page, 'min').fill('2001:db8::1'); await input(page, 'max').fill('129');
    assert.equal(await page.evaluate(() => accept()[0].code), 'invalid_number');
    await page.evaluate(() => { node.fields = editor.readFields(); node.fields.find(field => field.id === 'filter.max').value.value = '064'; reselect(); });
    assert.equal(await payload(page, 'max'), '064');
    assert.deepEqual(await page.evaluate(() => accept()), []);
}));

test('Semantic controls preserve exact imported envelopes and validate only deliberately changed GUIDs', { skip }, async () => fixture(async page => {
    for (const [kind, id, value] of [['file', 'min', '1.2.3.4.5'], ['msi', 'code', 'legacy-installer-code'], ['ip_range', 'min', 'invalid imported IP'], ['mac_range', 'min', 'imported-MAC']]) {
        await page.evaluate(({kind,id,value}) => {
            mount(kind, {existing:true});
            if (kind === 'file') node.fields.find(field => field.id === 'filter.type').value.value = 'VERSION';
            node.fields.find(field => field.id === 'filter.' + id).value.value = value;
            delete node._operandState; window.before = structuredClone(node.fields); reselect();
        }, {kind,id,value});
        assert.equal(await input(page, id).count(), 1);
        assert.equal(await input(page, id).inputValue(), value);
        assert.deepEqual(await page.evaluate(() => editor.readFields()), await page.evaluate(() => before));
        assert.deepEqual(await page.evaluate(() => accept()), [], kind);
    }
    await page.evaluate(() => mount('msi'));
    await input(page, 'code').fill('1234');
    assert.equal(await page.evaluate(() => accept()[0].code), 'invalid_guid');
    await input(page, 'code').fill('01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(await payload(page, 'code'), '{01234567-89AB-CDEF-0123-456789ABCDEF}');
    assert.deepEqual(await page.evaluate(() => accept()), []);
    await page.evaluate(() => mount('language', { scope:'user' }));
    assert.equal(await input(page, 'default').isDisabled(), false);
    assert.equal(await input(page, 'default').getAttribute('aria-label'), 'User');
    assert.equal(await input(page, 'system').getAttribute('aria-label'), 'System');
    assert.equal(await input(page, 'native').getAttribute('aria-label'), 'Native');
    await input(page, 'default').check();
    assert.equal(await payload(page, 'default'), true);
    assert.equal(await page.locator('.gpo-targeting-language__hint').count(), 0);
    await page.evaluate(() => { mount('ip_range'); editor.controls.find(control => control.id === 'filter.max').setError('Invalid address'); });
    assert.equal(await input(page, 'max').first().getAttribute('aria-invalid'), 'true');
    await fillTyped(page, 'max', '10.0.0.10');
    assert.equal(await page.locator('[data-field-id="filter.max"].gpo-editor-field--error').count(), 0);
    assert.equal(await page.locator('[data-field-id="filter.max"] [aria-invalid]').count(), 0);
    assert.equal(await page.locator('[data-field-id="filter.max"] .gpo-editor-field__error').textContent(), '');
}));

test('Time preserves untouched seconds/timezone and adapts edited minutes, overnight ranges and range/numeric validation', { skip }, async () => fixture(async page => {
    await page.evaluate(() => {
        mount('time', { existing: true });
        node.fields.find(field => field.id === 'filter.begin').value.value = '23:45:12.3+03:00';
        node.fields.find(field => field.id === 'filter.end').value.value = '01:15:34Z';
        reselect();
    });
    assert.equal(await payload(page, 'begin'), '23:45:12.3+03:00');
    assert.equal(await payload(page, 'end'), '01:15:34Z');
    await input(page, 'begin').fill('22:30');
    assert.equal(await payload(page, 'begin'), '22:30:00');
    assert.deepEqual(await page.evaluate(() => accept()), []);
    await page.evaluate(() => mount('cpu'));
    await input(page, 'speedMHz').fill('65536');
    assert.equal(await page.evaluate(() => editor.validate()[0].code), 'invalid_number');
    await page.evaluate(() => mount('ip_range'));
    await fillTyped(page, 'max', '10.0.0.0');
    assert.equal(await page.evaluate(() => editor.validate()[0].code), 'invalid_range');
    await fillTyped(page, 'max', '10..0.1');
    assert.equal(await page.evaluate(() => editor.validate()[0].code), 'invalid_ip');
    await page.evaluate(() => mount('mac_range'));
    await fillTyped(page, 'min', '00:00:00:00:00:ff');
    assert.equal(await page.evaluate(() => editor.validate()[0].code), 'invalid_range');
}));
