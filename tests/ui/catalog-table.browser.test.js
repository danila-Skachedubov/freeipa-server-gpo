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
} catch (_) { /* Browser dependencies are optional for unit-only environments. */ }

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636}.gp__container{height:100vh}#workspace{width:980px;height:600px}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace"></main></div>
<script src="/require.js"></script><script>
window.calls=[];
function securityResponse(){return {security_catalog:{semantic_revision:'fixture-revision',
 categories:[{namespace:'fixture',id:'category',display_name:'Security Settings'}],
 policies:[{namespace:'fixture',policy_id:'example',display_name:window.longLabel,
  category:['fixture','category'],elements:[{id:'enabled',value_type:'boolean'}]}]},
 security_snapshot:{policies:[]}};}
function auditResponse(){return {advanced_audit:{rows:[],subcategory_catalog:[
 {guid:'0cce9210-69ae-11d9-bed3-505054503030',display_name:window.longLabel}]}};}
function scriptsResponse(scope,event){return {scripts:{scope,event,execution_order:'unspecified',upload_limit_bytes:16777216,
 classic:{editable:true,snapshot:'fixture-classic',entries:[{identity:'fixture-script',command_line:window.longLabel+'.cmd',
  parameters:'/q',kind:'managed_asset',managed_asset_name:window.longLabel+'.cmd'}]},
 powershell:{editable:true,snapshot:'fixture-powershell',entries:[]},
 assets:[{name:window.longLabel+'.cmd',byte_size:3,revision:'fixture-asset',references:[]}]}};}
function preferenceItem(index){return {identity:['files','fixture-'+index],label:window.longLabel+' '+index,has_filters:false};}
define('util/API',[],()=>({
 preferenceItems:async()=>({items:[preferenceItem(0),preferenceItem(1)]}),
 preferenceShow:async(scope,kind,identity)=>({item:preferenceItem(Number(identity[1].slice(-1))),filters:[],filter_fields:[],filter_kinds:[],fields:[
  {id:'properties.action',label:'Action',editable:true,value:{kind:'enum',value:'update'}},
  {id:'properties.fromPath',label:'Source path',editable:true,value:{kind:'text',value:window.longLabel}},
  {id:'properties.targetPath',label:'Target path',editable:true,value:{kind:'text',value:window.longLabel}}]}),
 scriptsShow:async(scope,event)=>scriptsResponse(scope,event),
 securityDefinitionsShow:async()=>securityResponse(),
 advancedAuditShow:async()=>auditResponse(),
 policyIndex:async()=>({policies:[{id:'fixture-at',label:window.longLabel,path:['Administrative Templates','Package Control']}]}),
 policyUpdate:async()=>{calls.push('write');throw Error('Read-only fixture');},
 securityDefinitionsUpdate:async()=>{calls.push('write');throw Error('Read-only fixture');},
 advancedAuditUpdate:async()=>{calls.push('write');throw Error('Read-only fixture');}
}));
require.config({baseUrl:'/js'});
require(['components/header/header','components/templates/preference/preferences-view-template',
 'components/templates/script-template','components/templates/security-template','components/templates/security/model',
 'components/templates/advanced-audit-template','components/templates/all-policies-template','locales/translations'],
 (headerModule,preferences,scripts,security,securityModel,audit,allPolicies,translations)=>{
 window.translations=translations;
 window.header=headerModule.renderHeader(document.getElementById('header'));
 window.render=async(kind,language)=>{
  if(window.currentView)currentView.cleanup();
  translations.setLanguage(language);
  window.longLabel=(language==='ru'?'Очень длинное имя параметра для проверки таблицы ':'A very long policy name for checking catalog tables ').repeat(8);
  const options={header,categoryPath:'Computer / Policies / Example category',isCurrent:()=>true};
  if(kind==='preferences')currentView=await preferences.renderPreferencesTemplate(Object.assign(options,{item:{scope:'computer',preferenceKind:'files',document:{editable:true,label:translations.t('preferences.files')}}}));
  if(kind==='scripts')currentView=scripts.renderScriptsTemplate(Object.assign(options,{item:{scope:'computer'}}));
  if(kind==='security')currentView=await security.renderSecurityTemplate(Object.assign(options,{item:{title:'Security Settings',securityCategory:true,securityModel:securityModel.buildSecurityModel(securityResponse()),children:[{title:longLabel,securityPolicy:{namespace:'fixture',policy_id:'example'}}]}}));
  if(kind==='audit')currentView=await audit.renderAdvancedAuditTemplate(Object.assign(options,{item:{advancedAuditFamilyId:'system_audit_policies',advancedAuditResponse:auditResponse()}}));
  if(kind==='all')currentView=allPolicies.renderAllPoliciesTemplate(Object.assign(options,{item:{scope:'computer'}}));
  document.getElementById('workspace').replaceChildren(currentView.getElement());
 };
 render('preferences','en').then(()=>window.ready=true);
 });
</script></body></html>`;

const browserOptions = {
    skip: !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false
};

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
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        try { await run(page); }
        catch (error) { error.message += '; browser errors: ' + errors.join('; '); throw error; }
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => calls), []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function metrics(table, column = 0) {
    return table.evaluate((element, column) => {
        const header = element.querySelectorAll('th')[column];
        const cell = element.querySelectorAll('tbody tr:first-child td')[column];
        const row = element.querySelector('tbody tr');
        const properties = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'paddingTop', 'paddingBottom',
            'paddingLeft', 'paddingRight', 'verticalAlign', 'whiteSpace', 'textOverflow', 'borderTopWidth', 'borderBottomWidth'];
        const style = node => Object.fromEntries(properties.map(property => [property, getComputedStyle(node)[property]]));
        return { header: style(header), cell: style(cell), rowHeight: row.getBoundingClientRect().height,
            headerSeparator: getComputedStyle(header).borderRight,
            headerBackground: getComputedStyle(element.querySelector('thead')).backgroundColor,
            layout: getComputedStyle(element).tableLayout };
    }, column);
}

async function selectedStyle(table) {
    await table.locator('tbody tr').first().click();
    await table.locator('tbody tr.active').first().waitFor();
    return table.locator('tbody tr.active').first().evaluate(row => ({
        background: getComputedStyle(row).backgroundColor,
        userSelect: getComputedStyle(row).userSelect
    }));
}

async function capture(page, name) {
    if (process.env.CATALOG_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.CATALOG_SCREENSHOT_DIR, name + '.png'), animations: 'disabled' });
    }
}

for (const language of ['en', 'ru']) {
    test('Catalog tables retain Preferences metrics and selection with long ' + language + ' labels', browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => render('preferences', language), language);
            let table = page.locator('.gpo-editor-preferences__table table');
            await table.locator('tbody tr').first().waitFor();
            const reference = await metrics(table);
            const selected = await selectedStyle(table);
            assert.equal(await table.locator('tbody td').first().evaluate(cell => cell.scrollWidth > cell.clientWidth), true);
            assert.equal(await table.locator('tbody td').first().textContent(), await page.evaluate(() => longLabel + ' 0'));
            await capture(page, 'catalog-preferences-' + language);

            for (const kind of ['scripts', 'security', 'audit', 'all']) {
                await page.evaluate(({ kind, language }) => render(kind, language), { kind, language });
                table = page.locator('#workspace table').first();
                await table.locator('tbody tr').first().waitFor();
                assert.deepEqual(await metrics(table), reference, kind + ' should match Preferences metrics');
                assert.deepEqual(await selectedStyle(table), selected, kind + ' should match Preferences selection');
                assert.ok(await table.evaluate(element => element.getBoundingClientRect().right <=
                    document.getElementById('workspace').getBoundingClientRect().right + 1), kind + ' should fit the catalog');
                await capture(page, 'catalog-' + kind + '-' + language);
            }
        });
    });
}

test('Scripts properties, SYSVOL picker and explorer share catalog typography without changing their controls', browserOptions, async () => {
    await withPage(async page => {
        for (const language of ['en', 'ru']) {
            await page.evaluate(language => render('scripts', language), language);
            const overview = page.locator('.gpo-editor-scripts__event-table');
            const reference = await metrics(overview);
            await overview.locator('tbody tr').first().dblclick();
            const entries = page.locator('.gpo-editor-scripts__event-dialog .gpo-editor-scripts__entries table');
            await entries.locator('tbody tr').first().waitFor();
            assert.deepEqual(await metrics(entries), reference);
            assert.equal(await entries.locator('tbody td').first().locator('.gpo-catalog-name > span:last-child')
                .evaluate(label => label.scrollWidth > label.clientWidth), true);
            assert.equal(await entries.locator('tbody td').first().textContent(), await page.evaluate(() => longLabel + '.cmd'));
            await capture(page, 'scripts-properties-' + language);
            const addLabel = await page.evaluate(() => translations.t('systemSettings.add'));
            await page.locator('.gpo-editor-scripts__event-dialog .gpo-editor-scripts__toolbar').getByRole('button', { name: addLabel, exact: true }).click();
            await page.locator('.gpo-editor-scripts__form .gpo-editor-scripts__ellipsis').click();
            const picker = page.locator('.gpo-editor-scripts__picker table');
            await picker.locator('tbody tr').first().waitFor();
            assert.deepEqual(await metrics(picker), reference);
            await picker.locator('tbody tr').first().dblclick();
            assert.equal(await page.locator('.gpo-editor-scripts__form input[type=text]').first().inputValue(), await page.evaluate(() => longLabel + '.cmd'));
            await page.locator('.gpo-editor-scripts__form .btn-cancel').click();
            await page.locator('.policy-changed__modal--discard .btn-yes').click();
            await page.locator('.gpo-editor-scripts__event-dialog > .preference__modal-wrapper > .preference__modal-footer .btn-cancel').click();
            await page.locator('.gpo-editor-scripts__folder-button').click();
            const explorer = page.locator('.gpo-editor-scripts__explorer .gpo-editor-scripts__assets table');
            await explorer.locator('tbody tr').first().waitFor();
            // The selection checkbox keeps its narrow column; compare the actual data column.
            assert.deepEqual(await metrics(explorer, 1), reference);
            await capture(page, 'scripts-folder-' + language);
            await page.locator('.gpo-editor-scripts__explorer > .preference__modal-wrapper > .preference__modal-footer .btn-cancel').click();
        }
    });
});
