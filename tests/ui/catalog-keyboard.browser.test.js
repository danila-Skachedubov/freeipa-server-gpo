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
} catch (_) { /* Optional only in environments without the browser dependencies. */ }

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
const browserOptions = {
    skip: !chromium || !requireJs ? 'Set NODE_PATH for Playwright and RequireJS browser checks.' : false
};
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/other.css">
<style>body{font:12px Arial,sans-serif;color:#363636}.gp__container{height:100vh}#workspace{width:1000px;height:700px}</style>
</head><body><div class="gp__container"><div id="header"></div><main id="workspace"></main>
<button id="after-catalog">After catalog</button></div><script src="/require.js"></script><script>
window.calls=[];window.failDelete=false;window.failAsset='';window.allowConfirm=true;window.confirmCalls=0;
window.holdEntryDeletion=false;
window.confirm=()=>{confirmCalls++;return allowConfirm;};window.current=true;window.navigations=[];
const field=(id,label,kind,value)=>({id,label,editable:true,value:{kind,value}});
window.preferenceRows=['one','two','three'].map((id,index)=>({identity:['files',id],label:['Alpha file','Beta file','Gamma file'][index],has_filters:false}));
window.preferenceFields=[field('properties.action','Action','action','update'),field('properties.fromPath','Source','text','source.txt')];
const setValue=(kind,value)=>({state:'set',value:{kind,value}});
window.securityRows=['Alpha','Beta','Gamma'].map(value=>({path:setValue('string',value),sddl:setValue('sddl','D:(A;;GA;;;SY)')}));
function securityResponse(){return {security_catalog:{semantic_revision:'fixture-security',
 categories:[{namespace:'fixture',id:'security',display_name:'Security category'},{namespace:'fixture',id:'registry',display_name:'Registry Security'}],
 policies:[{namespace:'fixture',policy_id:'maximum',display_name:'Maximum password age',category:['fixture','security'],
 elements:[{id:'value',value_type:'integer',initial:{kind:'integer',value:42},ranges:[{min:0,max:999}]}]},
 {namespace:'fixture',policy_id:'minimum',display_name:'Minimum password age',category:['fixture','security'],
 elements:[{id:'value',value_type:'integer',initial:{kind:'integer',value:0},ranges:[{min:0,max:998}]}]},
 {namespace:'fixture',policy_id:'registry',display_name:'Registry Security',category:['fixture','registry'],
 elements:[{id:'rows',value_type:'collection',unique_by:'path',fields:[{id:'path',element:{id:'path',value_type:'string'}},
 {id:'sddl',element:{id:'sddl',value_type:'sddl'}}]}]}]},
 security_snapshot:{policies:[{namespace:'fixture',policy_id:'registry',state:'defined',elements:{rows:setValue('collection',structuredClone(securityRows))}}]}};}
function auditResponse(){return {advanced_audit:{rows:[],subcategory_catalog:[
 {guid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',display_name:'Alpha audit'},
 {guid:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',display_name:'Beta audit'},
 {guid:'cccccccc-cccc-cccc-cccc-cccccccccccc',display_name:'Gamma audit'}]}};}
function makeScripts(scope,event){return {scope,event,execution_order:'unspecified',upload_limit_bytes:16777216,
 classic:{snapshot:'classic-fixture',editable:true,entries:['one','two','three'].map(id=>({identity:id,command_line:id+'.cmd',parameters:'',kind:'managed_asset',managed_asset_name:id+'.cmd'}))},
 powershell:{snapshot:'powershell-fixture',editable:true,entries:[]},
 assets:['a.cmd','b.cmd','c.cmd','d.cmd'].map(name=>({name,byte_size:3,revision:'r-'+name,references:[]}))};}
window.scriptViews={startup:makeScripts('computer','startup'),shutdown:makeScripts('computer','shutdown')};
function scriptsResponse(event){return {scripts:structuredClone(scriptViews[event])};}
function rejectDelete(){if(failDelete){failDelete=false;throw Object.assign(new Error('Fixture rejected deletion'),{category:'validation'});}}
define('util/API',[],()=>({
 preferenceItems:async()=>({items:structuredClone(preferenceRows)}),
 preferenceShow:async(scope,kind,identity)=>({item:structuredClone(preferenceRows.find(row=>JSON.stringify(row.identity)===JSON.stringify(identity))),
 fields:structuredClone(preferenceFields),new_item_fields:structuredClone(preferenceFields),filters:[],filter_fields:[],filter_kinds:[],parent_candidates:[{identity:null,label:'Root',depth:0}]}),
 preferenceDelete:async(scope,kind,identity)=>{calls.push({method:'preferenceDelete',identity});rejectDelete();
 preferenceRows=preferenceRows.filter(row=>JSON.stringify(row.identity)!==JSON.stringify(identity));return {publication:{changed:true}};},
 preferenceUpdate:async()=>{calls.push({method:'preferenceUpdate'});throw Error('Unexpected preference write');},
 securityDefinitionsShow:async()=>securityResponse(),
 securityDefinitionsUpdate:async request=>{calls.push({method:'securityDelete',request:structuredClone(request)});rejectDelete();
 const key=request.policies[0].elements[0].rows[0].key.value;securityRows=securityRows.filter(row=>row.path.value.value!==key);return securityResponse();},
 scriptsShow:async(scope,event)=>scriptsResponse(event),
 scriptEntryRemove:async(scope,event,request)=>{calls.push({method:'entryDelete',event,request:structuredClone(request)});rejectDelete();
 if(holdEntryDeletion)await new Promise(resolve=>window.resolveEntryDeletion=resolve);
 scriptViews[event][request.executable_group].entries=scriptViews[event][request.executable_group].entries.filter(row=>row.identity!==request.identity);return scriptsResponse(event);},
 scriptAssetDelete:async(scope,event,request)=>{calls.push({method:'assetDelete',event,request:structuredClone(request)});
 if(request.name===failAsset)throw Object.assign(new Error('Fixture rejected file '+request.name),{category:'validation'});rejectDelete();
 scriptViews[event].assets=scriptViews[event].assets.filter(row=>row.name!==request.name);return scriptsResponse(event);},
 scriptAssetDownload:async(scope,event,request)=>{calls.push({method:'download',event,request:structuredClone(request)});
 return {asset:{name:request.name,revision:request.revision,byte_size:3,content_base64:'YWJj'}};},
 scriptEntryUpdate:async()=>{calls.push({method:'entryUpdate'});throw Error('Unexpected entry write');},
 advancedAuditShow:async()=>auditResponse(),advancedAuditUpdate:async()=>{calls.push({method:'auditUpdate'});throw Error('Unexpected audit write');},
 policyIndex:async()=>({policies:[]}),reconcile:async()=>({})
}));
require.config({baseUrl:'/js'});
require(['components/header/header','components/templates/preference/preferences-view-template','components/templates/script-template',
 'components/templates/security-template','components/templates/security/model','components/templates/advanced-audit-template',
 'components/templates/all-policies-template','locales/translations'],(headerModule,preferences,scripts,security,securityModel,audit,allPolicies,translations)=>{
 window.translations=translations;window.header=headerModule.renderHeader(document.getElementById('header'));
 window.render=async(kind,language='en',editable=true)=>{
 if(window.view)view.cleanup();translations.setLanguage(language);window.kind=kind;
 const options={header,isCurrent:()=>current,onNavigate:item=>navigations.push(item)};
 if(kind==='preferences')view=await preferences.renderPreferencesTemplate({...options,item:{scope:'computer',preferenceKind:'files',document:{editable,label:'Files'}}});
 if(kind==='security'||kind==='securityCollection'){
 const nodes=securityModel.navigationNodes(securityResponse());const item=nodes.find(node=>Boolean(node.securityCollection)===(kind==='securityCollection'));
 if(!editable){for(const definition of item.securityModel.catalog.policies)definition.controls=[{element_id:'rows',read_only:true}];
 for(const policy of item.securityModel.policies.values())policy.controls=[{element_id:'rows',read_only:true}];}
 view=await security.renderSecurityTemplate({...options,item});}
 if(kind==='scripts'||kind==='scriptEvent'||kind==='assets'){
 scriptViews.startup.classic.editable=editable;
 view=scripts.renderScriptsTemplate({...options,item:{scope:'computer'}});}
 if(kind==='audit')view=await audit.renderAdvancedAuditTemplate({...options,item:{advancedAuditFamilyId:'system_audit_policies',advancedAuditResponse:auditResponse()}});
 if(kind==='all')view=allPolicies.renderAllPoliciesTemplate({...options,item:{scope:'computer',includePreferences:true,preferenceDocuments:[{scope:'computer',kind:'files',label:'Files',category_id:'system_settings',editable:true}]}});
 document.getElementById('workspace').replaceChildren(view.getElement());if(view.onMounted)view.onMounted();
 if(kind==='scriptEvent')view.getElement().querySelector('[data-script-event="startup"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
 if(kind==='assets')document.querySelector('.gpo-editor-scripts__folder-button').click();
 };
 render('preferences').then(()=>window.ready=true);
});</script></body></html>`;

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
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        try { await run(page); }
        catch (error) { error.message += '; browser errors: ' + errors.join('; '); throw error; }
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function selectedAndFocused(rows, identity, attribute) {
    const actual = await rows.evaluateAll((elements, attribute) => elements.filter(row => row.classList.contains('active'))
        .map(row => ({ identity: attribute ? row.getAttribute(attribute) : row.textContent.trim(), focused: row === document.activeElement,
            selected: row.getAttribute('aria-selected'), tabIndex: row.tabIndex })), attribute);
    assert.deepEqual(actual, [{ identity, focused: true, selected: 'true', tabIndex: 0 }]);
    assert.equal(await rows.evaluateAll(elements => elements.filter(row => row.tabIndex === 0).length), 1);
}

async function deleteConfirmation(page, accept = true) {
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.locator(accept ? '.btn-yes' : '.btn-no').click();
    await dialog.waitFor({ state: 'hidden' });
}

for (const language of ['en', 'ru']) {
    test('Preferences catalog has roving Tab, arrows, Enter and double-click in ' + language, browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => render('preferences', language), language);
            const rows = page.locator('[data-preference-identity]');
            await rows.first().focus();
            await selectedAndFocused(rows, '["files","one"]', 'data-preference-identity');
            await page.keyboard.press('ArrowDown');
            await selectedAndFocused(rows, '["files","two"]', 'data-preference-identity');
            assert.equal(await page.getByRole('dialog').count(), 0);
            await page.keyboard.press('End');
            await selectedAndFocused(rows, '["files","three"]', 'data-preference-identity');
            await page.keyboard.press('Home');
            await selectedAndFocused(rows, '["files","one"]', 'data-preference-identity');
            await page.keyboard.press('PageDown');
            await selectedAndFocused(rows, '["files","three"]', 'data-preference-identity');
            await page.keyboard.press('PageUp');
            await selectedAndFocused(rows, '["files","one"]', 'data-preference-identity');
            await page.keyboard.press('Control+Delete');
            assert.equal(await page.evaluate(() => calls.length), 0, 'Modified Delete is not a destructive catalog shortcut');
            await page.keyboard.press('Tab');
            assert.equal(await rows.evaluateAll(elements => elements.some(row => row.contains(document.activeElement))), false);
            await rows.nth(1).focus();
            await page.keyboard.press('Enter');
            const form = page.locator('.gpo-editor-preference-form');
            await form.waitFor();
            assert.equal(await form.locator('[data-field-id="name"] input').inputValue(), 'Beta file');
            const writes = await page.evaluate(() => calls.length);
            await form.locator('[data-field-id="name"] input').press('Delete');
            assert.equal(await page.evaluate(() => calls.length), writes, 'Delete in a text field must not remove a row');
            assert.equal(await rows.count(), 3);
            await form.locator('.btn-cancel').click();
            if (await page.getByRole('alertdialog').count()) await deleteConfirmation(page);
            await form.waitFor({ state: 'hidden' });
            await rows.last().dblclick();
            await form.waitFor();
            assert.equal(await form.locator('[data-field-id="name"] input').inputValue(), 'Gamma file');
            await form.locator('.btn-cancel').click();
            assert.equal(await page.evaluate(() => calls.length), writes);
        });
    });
}

test('Preferences Delete chooses previous, then next, then an empty focus target', browserOptions, async () => {
    await withPage(async page => {
        const rows = page.locator('[data-preference-identity]');
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await page.waitForFunction(() => preferenceRows.length === 2 && document.querySelectorAll('[data-preference-identity]').length === 2);
        await selectedAndFocused(rows, '["files","one"]', 'data-preference-identity');
        assert.deepEqual(await page.evaluate(() => calls[0].identity), ['files', 'two']);
        await page.keyboard.press('Delete');
        await page.waitForFunction(() => document.querySelectorAll('[data-preference-identity]').length === 1);
        await selectedAndFocused(rows, '["files","three"]', 'data-preference-identity');
        await page.keyboard.press('Delete');
        await page.waitForFunction(() => document.querySelectorAll('[data-preference-identity]').length === 0);
        assert.equal(await page.locator('.gpo-editor-preferences__table').evaluate(element => element === document.activeElement && element.tabIndex === 0), true);
        assert.deepEqual(await page.evaluate(() => calls.filter(call => call.method === 'preferenceDelete').map(call => call.identity)),
            [['files', 'two'], ['files', 'one'], ['files', 'three']]);
    });
});

test('Preferences cancelled, failed, readonly and busy deletes preserve selection and do not submit unsafe writes', browserOptions, async () => {
    await withPage(async page => {
        const rows = page.locator('[data-preference-identity]');
        await rows.nth(1).focus();
        await page.evaluate(() => { allowConfirm = false; });
        await page.keyboard.press('Delete');
        await selectedAndFocused(rows, '["files","two"]', 'data-preference-identity');
        assert.equal(await page.evaluate(() => calls.length), 0);
        await page.evaluate(() => { allowConfirm = true; failDelete = true; });
        await page.keyboard.press('Delete');
        await page.locator('.gpo-editor-preferences__error .gpo-editor-status').waitFor();
        await selectedAndFocused(rows, '["files","two"]', 'data-preference-identity');
        assert.equal(await rows.count(), 3);
        assert.equal(await page.evaluate(() => calls.length), 1);
        await page.evaluate(() => render('preferences', 'en', false));
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await selectedAndFocused(rows, '["files","two"]', 'data-preference-identity');
        assert.equal(await page.evaluate(() => calls.length), 1);
        await page.evaluate(() => render('preferences'));
        await rows.nth(1).focus();
        await page.keyboard.press('Enter');
        const form = page.locator('.gpo-editor-preference-form');
        await form.waitFor();
        await page.evaluate(() => document.querySelector('[data-preference-identity]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
        assert.equal(await page.evaluate(() => calls.length), 1, 'The busy family list must ignore deletion behind its item dialog');
        assert.equal(await rows.count(), 3);
    });
});

test('Security collection Delete selects previous/next/empty and retains selection when removal is cancelled or fails', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('securityCollection', 'ru'));
        const rows = page.locator('[data-security-row]');
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        let dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.locator('.btn-cancel').click();
        await selectedAndFocused(rows, 'row:Beta', 'data-list-id');
        assert.equal(await page.evaluate(() => calls.length), 0);
        await page.keyboard.press('Delete');
        await page.evaluate(() => { failDelete = true; });
        await dialog.locator('.btn-ok').click();
        await dialog.locator('.gpo-editor-status').waitFor();
        assert.equal(await rows.count(), 3);
        assert.equal(await rows.filter({ hasText: 'Beta' }).getAttribute('aria-selected'), 'true');
        await dialog.locator('.btn-cancel').click();
        await selectedAndFocused(rows, 'row:Beta', 'data-list-id');
        for (const expected of ['row:Alpha', 'row:Gamma', null]) {
            await page.keyboard.press('Delete');
            await dialog.waitFor();
            await dialog.locator('.btn-ok').click();
            await dialog.waitFor({ state: 'hidden' });
            if (expected) await selectedAndFocused(rows, expected, 'data-list-id');
            else assert.equal(await page.locator('.gpo-security-table').evaluate(element => element === document.activeElement && element.tabIndex === 0), true);
        }
        assert.deepEqual(await page.evaluate(() => calls.map(call => call.request.policies[0].elements[0].rows[0].key.value)), ['Beta', 'Beta', 'Alpha', 'Gamma']);
    });
});

test('Scripts overview, entries and picker support roving navigation and activation without navigation or typing writes', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('scripts', 'ru'));
        const overview = page.locator('[data-script-event]');
        await overview.first().focus();
        await page.keyboard.press('ArrowDown');
        await selectedAndFocused(overview, 'shutdown', 'data-script-event');
        await page.keyboard.press('Enter');
        const event = page.locator('.gpo-editor-scripts__event-dialog');
        const rows = event.locator('[data-script-entry]');
        await rows.first().waitFor();
        await rows.first().focus();
        await page.keyboard.press('ArrowDown');
        await selectedAndFocused(rows, 'two', 'data-script-entry');
        await page.keyboard.press('F2');
        const form = page.locator('.gpo-editor-scripts__form');
        await form.waitFor();
        assert.equal(await form.locator('input[type=text]').first().inputValue(), 'two.cmd');
        await form.locator('input[type=text]').last().press('Delete');
        assert.equal(await page.evaluate(() => calls.length), 0);
        await form.locator('.gpo-editor-scripts__ellipsis').click();
        const picker = page.locator('.gpo-editor-scripts__picker');
        const files = picker.locator('[data-script-asset]');
        await files.first().focus();
        await page.keyboard.press('ArrowDown');
        await selectedAndFocused(files, 'b.cmd', 'data-script-asset');
        await page.keyboard.press('Enter');
        await picker.waitFor({ state: 'hidden' });
        assert.equal(await form.locator('input[type=text]').first().inputValue(), 'b.cmd');
        assert.deepEqual(await page.evaluate(() => navigations), []);
        assert.equal(await page.evaluate(() => calls.length), 0);
    });
});

test('Scripts entry deletion preserves cancelled/failed selection, then chooses previous/next/empty', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('scriptEvent'));
        const rows = page.locator('[data-script-entry]');
        await rows.nth(1).waitFor();
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await deleteConfirmation(page, false);
        await selectedAndFocused(rows, 'two', 'data-script-entry');
        assert.equal(await page.evaluate(() => calls.length), 0);
        await page.keyboard.press('Delete');
        await page.evaluate(() => { failDelete = true; });
        await deleteConfirmation(page);
        await page.locator('.gpo-editor-scripts .gpo-editor-status--error').waitFor();
        await selectedAndFocused(rows, 'two', 'data-script-entry');
        assert.equal(await rows.count(), 3);
        for (const expected of ['one', 'three', null]) {
            await page.keyboard.press('Delete');
            await deleteConfirmation(page);
            if (expected) await selectedAndFocused(rows, expected, 'data-script-entry');
            else assert.equal(await page.locator('[data-script-list="entries"]').evaluate(element => element === document.activeElement && element.tabIndex === 0), true);
        }
        assert.deepEqual(await page.evaluate(() => calls.map(call => call.request.identity)), ['two', 'two', 'one', 'three']);
    });
});

test('A delayed Scripts removal does not move focus from the newly selected PowerShell tab into its table', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => { holdEntryDeletion = true; return render('scriptEvent'); });
        await page.locator('[data-script-entry="two"]').waitFor();
        await page.locator('[data-script-entry="two"]').focus();
        await page.keyboard.press('Delete');
        await deleteConfirmation(page);
        await page.waitForFunction(() => Boolean(window.resolveEntryDeletion));
        const tab = page.getByRole('tab', { name: 'PowerShell scripts', exact: true });
        await tab.click();
        await tab.focus();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.equal(await tab.evaluate(element => element === document.activeElement), true);
        await page.evaluate(() => { holdEntryDeletion = false; resolveEntryDeletion(); });
        await page.waitForFunction(() => scriptViews.startup.classic.entries.length === 2
            && !document.querySelector('.gpo-editor-scripts__save-status')?.textContent.includes('Saving'));
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.equal(await tab.evaluate(element => element === document.activeElement), true,
            'The old classic deletion response must retain focus on the current PowerShell tab');
        assert.equal(await page.locator('[data-script-entry]').count(), 0);
        assert.deepEqual(await page.evaluate(() => calls.map(call => [call.method, call.request.identity])), [['entryDelete', 'two']]);
    });
});

test('Double-clicking a SYSVOL selection checkbox does not download or open a file editor', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('assets'));
        const row = page.locator('[data-script-asset="b.cmd"]');
        await row.waitFor();
        await row.locator('input[type=checkbox]').dblclick();
        assert.equal(await page.locator('.gpo-editor-scripts__form').count(), 0);
        assert.equal(await row.locator('input[type=checkbox]').isChecked(), false,
            'Two native checkbox activations should only toggle its selection twice');
        assert.equal(await page.evaluate(() => calls.length), 0,
            'A native checkbox double-click must not bubble into the row download action');
        assert.equal(await page.locator('[data-script-asset]').count(), 4);
    });
});

test('SYSVOL bulk deletion anchors at the first removed file and handles partial success without selecting a failed file', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('assets'));
        const rows = page.locator('[data-script-asset]');
        await rows.nth(1).waitFor();
        await rows.nth(1).click();
        await rows.nth(2).click();
        assert.deepEqual(await rows.evaluateAll(elements => elements.filter(row => row.classList.contains('active')).map(row => row.getAttribute('data-script-asset'))), ['b.cmd', 'c.cmd']);
        await page.evaluate(() => { failAsset = 'c.cmd'; });
        await page.keyboard.press('Delete');
        await deleteConfirmation(page);
        await page.waitForFunction(() => calls.filter(call => call.method === 'assetDelete').length === 2 && document.querySelectorAll('[data-script-asset]').length === 3);
        await selectedAndFocused(rows, 'a.cmd', 'data-script-asset');
        assert.deepEqual(await rows.evaluateAll(elements => elements.map(row => row.getAttribute('data-script-asset'))), ['a.cmd', 'c.cmd', 'd.cmd']);
        assert.deepEqual(await page.evaluate(() => calls.map(call => call.request.name)), ['b.cmd', 'c.cmd']);
        await page.evaluate(() => { failAsset = ''; });
        await page.keyboard.press('ArrowDown');
        await rows.nth(2).click();
        assert.deepEqual(await rows.evaluateAll(elements => elements.filter(row => row.classList.contains('active')).map(row => row.getAttribute('data-script-asset'))), ['c.cmd', 'd.cmd']);
        await page.keyboard.press('Delete');
        await deleteConfirmation(page);
        await page.waitForFunction(() => document.querySelectorAll('[data-script-asset]').length === 1);
        await selectedAndFocused(rows, 'a.cmd', 'data-script-asset');
        await page.keyboard.press('Delete');
        await deleteConfirmation(page);
        await page.waitForFunction(() => document.querySelectorAll('[data-script-asset]').length === 0);
        assert.equal(await page.locator('[data-script-list="assets"]').evaluate(element => element === document.activeElement && element.tabIndex === 0), true);
    });
});

test('Readonly Scripts and security collections ignore Delete, and Scripts cannot edit readonly entries', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('scriptEvent', 'ru', false));
        let rows = page.locator('[data-script-entry]');
        await rows.nth(1).waitFor();
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await page.keyboard.press('Enter');
        await selectedAndFocused(rows, 'two', 'data-script-entry');
        assert.equal(await page.locator('.gpo-editor-scripts__form').count(), 0);
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        assert.equal(await rows.count(), 3);
        await page.evaluate(() => render('securityCollection', 'en', false));
        rows = page.locator('[data-security-row]');
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await selectedAndFocused(rows, 'row:Beta', 'data-list-id');
        assert.equal(await rows.count(), 3);
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.equal(await page.evaluate(() => calls.length), 0);
    });
});

test('SYSVOL Enter downloads the focused file while Delete protects referenced files and readonly folders', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            scriptViews.startup.assets[0].references = [{ event: 'startup', executable_group: 'classic', index: 0 }];
            return render('assets');
        });
        let rows = page.locator('[data-script-asset]');
        await rows.first().waitFor();
        await rows.first().focus();
        await selectedAndFocused(rows, 'a.cmd', 'data-script-asset');
        await page.keyboard.press('Delete');
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        assert.equal(await page.evaluate(() => calls.length), 0);
        const downloading = page.waitForEvent('download');
        await page.keyboard.press('Enter');
        assert.equal((await downloading).suggestedFilename(), 'a.cmd');
        assert.deepEqual(await page.evaluate(() => calls.map(call => [call.method, call.request.name, call.request.revision])),
            [['download', 'a.cmd', 'r-a.cmd']]);
        await page.evaluate(() => render('assets', 'ru', false));
        rows = page.locator('[data-script-asset]');
        await rows.nth(1).waitFor();
        await rows.nth(1).focus();
        await page.keyboard.press('Delete');
        await selectedAndFocused(rows, 'b.cmd', 'data-script-asset');
        assert.equal(await rows.count(), 4);
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        assert.equal(await page.evaluate(() => calls.length), 1);
    });
});

async function assertTabTrap(page, dialog) {
    const controls = await dialog.evaluate(element => Array.from(element.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]'))
        .filter(control => control.tabIndex >= 0 && !control.disabled && !control.hidden && control.getClientRects().length && !control.closest('[hidden],[inert]'))
        .map((control, index) => { control.setAttribute('data-keyboard-trap-control', String(index)); return String(index); }));
    assert.ok(controls.length > 1, 'The real dialog should contain reachable controls');
    const first = dialog.locator('[data-keyboard-trap-control="0"]');
    const last = dialog.locator('[data-keyboard-trap-control="' + controls.at(-1) + '"]');
    await last.focus();
    await page.keyboard.press('Tab');
    assert.equal(await first.evaluate(element => element === document.activeElement), true, 'Tab at the last control wraps inside the current dialog');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await last.evaluate(element => element === document.activeElement), true, 'Shift+Tab at the first control wraps backwards inside the current dialog');
}

test('Scripts event, item form, file picker and shared security modal trap Tab in both directions', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => render('scripts'));
        await page.locator('[data-script-event]').first().focus();
        await page.keyboard.press('Enter');
        const event = page.locator('.gpo-editor-scripts__event-dialog');
        await event.locator('[data-script-entry]').first().waitFor();
        await assertTabTrap(page, event);
        await event.locator('[data-script-entry]').first().focus();
        await page.keyboard.press('Enter');
        const form = page.locator('.gpo-editor-scripts__form');
        await form.waitFor();
        await assertTabTrap(page, form);
        await form.locator('.gpo-editor-scripts__ellipsis').click();
        const picker = page.locator('.gpo-editor-scripts__picker');
        await picker.locator('[data-script-asset]').first().waitFor();
        await assertTabTrap(page, picker);
        await picker.press('Escape');
        await picker.waitFor({ state: 'hidden' });
        assert.equal(await form.locator('.gpo-editor-scripts__ellipsis').evaluate(element => element === document.activeElement), true);
        await form.press('Escape');
        await form.waitFor({ state: 'hidden' });
        await event.press('Escape');
        await event.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('[data-script-event]').first().evaluate(element => element === document.activeElement), true);

        await page.evaluate(() => render('security'));
        await page.locator('[data-security-row]').first().focus();
        await page.keyboard.press('Enter');
        const dialog = page.locator('.gpo-security-dialog');
        await dialog.waitFor();
        await dialog.focus();
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(element => document.activeElement !== element && element.contains(document.activeElement)), true,
            'The first Tab from the modal root must enter its controls, never the background catalog');
        await assertTabTrap(page, dialog);
        assert.equal(await page.evaluate(() => calls.length), 0);
    });
});

test('Audit and All Policies activation keep the catalog selected, use roving rows and ignore Delete in filters', browserOptions, async () => {
    await withPage(async page => {
        for (const language of ['en', 'ru']) {
            await page.evaluate(language => render('audit', language), language);
            let rows = page.locator('[data-advanced-audit-kind]');
            await rows.first().focus();
            await page.keyboard.press('ArrowDown');
            assert.equal(await rows.nth(1).getAttribute('aria-selected'), 'true');
            assert.equal(await rows.nth(1).evaluate(row => row === document.activeElement && row.tabIndex === 0), true);
            const title = await rows.nth(1).locator('td').first().textContent();
            await page.keyboard.press('Enter');
            let dialog = page.getByRole('dialog');
            await dialog.waitFor();
            assert.equal(await dialog.locator('.preference__modal-header .title').textContent(), title);
            await dialog.locator('.btn-cancel').click();
            assert.equal(await rows.nth(1).evaluate(row => row === document.activeElement), true);
            await rows.first().dblclick();
            await dialog.waitFor();
            assert.equal(await dialog.locator('.preference__modal-header .title').textContent(), await rows.first().locator('td').first().textContent());
            await dialog.locator('.btn-cancel').click();

            await page.evaluate(language => render('all', language), language);
            const query = page.locator('[data-policy-filter]');
            await query.fill('password age');
            rows = page.locator('[data-policy-result-id]');
            await rows.nth(1).waitFor();
            await rows.first().focus();
            await page.keyboard.press('ArrowDown');
            await selectedAndFocused(rows, await rows.nth(1).getAttribute('data-policy-result-id'), 'data-policy-result-id');
            await page.keyboard.press('Enter');
            dialog = page.locator('.gpo-security-dialog');
            await dialog.waitFor();
            assert.equal(await dialog.locator('.preference__modal-header .title').textContent(), 'Minimum password age');
            assert.equal(await query.inputValue(), 'password age');
            assert.deepEqual(await page.evaluate(() => navigations), []);
            await dialog.locator('.btn-cancel').click();
            assert.equal(await rows.nth(1).evaluate(row => row === document.activeElement), true);
            await rows.first().dblclick();
            await dialog.waitFor();
            assert.equal(await dialog.locator('.preference__modal-header .title').textContent(), 'Maximum password age');
            await dialog.locator('.btn-cancel').click();
            await query.focus();
            await page.keyboard.press('Delete');
            assert.equal(await page.evaluate(() => calls.length), 0);
        }
    });
});
