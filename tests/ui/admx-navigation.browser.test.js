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
<style>body{font:12px Arial,sans-serif}.gp__container{height:100vh}#confirmation{display:none;position:fixed;inset:0;z-index:10000;background:white}#confirmation.active{display:block}</style>
</head><body><div class="gp__container"><div id="header"></div><div id="main" class="gp__main">
<nav id="tree" class="tree-view"></nav></div>
<div id="confirmation" role="alertdialog" aria-label="Unsaved policy">
<button id="discard">Discard changes</button><button id="save">Save changes</button></div></div>
<script src="/require.js"></script><script>
window.requests=[];window.retryAttempts={computer:0,user:0};window.savedPolicies={};window.rejectUpdates=false;
window.failSecurityIndex=false;
window.securitySnapshots={};window.securityCollectionFixture=null;
function policyNode(id,label){return {kind:'policy',id,label};}
function categoryNode(id,label){return {kind:'category',id,label};}
function children(scope,categoryId){
 requests.push({method:'children',scope,categoryId});
 if(categoryId===null)return Promise.resolve({children:[
  policyNode('orphan','Zulu root policy'),categoryNode('retry','Retry category'),
  categoryNode('only','Policy-only category'),categoryNode('mixed','Mixed category'),
  categoryNode('empty','Empty category')]});
 if(categoryId==='retry' && !(retryAttempts[scope]++))return Promise.reject(Error('Temporary catalog failure'));
 const nodes={
  only:[policyNode('only-z','Zulu only policy'),policyNode('only-a','alpha only policy')],
  mixed:[policyNode('mixed-z','Zulu policy'),categoryNode('nested','Nested category'),policyNode('mixed-a','alpha policy')],
  nested:[policyNode('nested-policy','Nested policy')],
  empty:[],retry:[policyNode('retry-policy','Retry policy')]
 };
 return Promise.resolve(nodes[categoryId]||[]);
}
function policy(scope,id){
 const labels={orphan:'Zulu root policy','only-a':'alpha only policy','only-z':'Zulu only policy',
  'mixed-a':'alpha policy','mixed-z':'Zulu policy','nested-policy':'Nested policy','retry-policy':'Retry policy',
  'late-policy':'Rare policy beyond first page'};
 return structuredClone(savedPolicies[scope+':'+id]||{
  scope,policy_id:id,label:labels[id],state:'enabled',comment:null,
  capabilities:{enable:true,disable:true,clear:true,inspect_parameters:true,edit_parameters:true,edit_comments:true},
 parameters:[{id:'value',label:'Value',kind:'text',editable:true,value:{kind:'text',value:'original'}}]
 });
}
function policyIndex(scope){
 requests.push({method:'policyIndex',scope});
 return Promise.resolve({policies:[
  ...Array.from({length:1201},(_,index)=>({id:'bulk-'+index,label:'Bulk policy '+String(index).padStart(4,'0'),path:['Nested category '+index]})),
  {id:'late-policy',label:'Rare policy beyond first page',path:['Deep category','Nested category']}
 ]});
}
function securityDefinitionsShow(){
 requests.push({method:'securityIndex'});
 if(failSecurityIndex)return Promise.reject(Error('Security catalog unavailable'));
 return Promise.resolve(securityResult());
}
function securityResult(){return {security_catalog:{semantic_revision:'fixture-revision',
  categories:[{namespace:'fixture',id:'security',display_name:'Fixture security'}],
  policies:Array.from({length:185},(_,index)=>({namespace:'fixture',policy_id:'security-'+index,
   display_name:'Security item '+String(index).padStart(3,'0'),category:['fixture','security'],
   elements:[{id:'enabled',value_type:'boolean'}]})).concat(securityCollectionFixture?[securityCollectionFixture]:[])
 },security_snapshot:{policies:Object.values(securitySnapshots)}};
}
function advancedAuditShow(){
 requests.push({method:'auditIndex'});
 return Promise.resolve({advanced_audit:{rows:[],subcategory_catalog:[
  {guid:'0cce9210-69ae-11d9-bed3-505054503030',display_name:'Account Logon'}
 ]}});
}
function scriptsShow(scope,event){
 requests.push({method:'scriptsShow',scope,event});
 return Promise.resolve({scripts:{scope,event,execution_order:'unspecified',assets:[],
  classic:{editable:true,entries:[],snapshot:{}},powershell:{editable:true,entries:[],snapshot:{}}}});
}
define('util/API',[],()=>({getDisplayName:()=> 'Example GPO',children,
 policyIndex,securityDefinitionsShow,advancedAuditShow,scriptsShow,
 preferenceItems:async()=>({items:[]}),
 securityDefinitionsUpdate:async request=>{
  requests.push({method:'securityUpdate',request:structuredClone(request)});
  if(rejectUpdates)throw Object.assign(Error('Fixture update rejected'),{category:'validation'});
  request.policies.forEach(update=>{
   const before=securitySnapshots[update.policy_id]||{namespace:update.namespace,policy_id:update.policy_id,state:'defined',elements:{}};
   if(update.transition)before.state=update.transition==='define'?'defined':'undefined';
   (update.elements||[]).forEach(element=>{
    if(element.action==='rows'){
     const definition=securityResult().security_catalog.policies.find(policy=>policy.policy_id===update.policy_id).elements.find(field=>field.id===element.element_id);
     const rows=before.elements[element.element_id].value.value;
     element.rows.forEach(action=>{
      const index=rows.findIndex(row=>JSON.stringify(row[definition.unique_by]?.value)===JSON.stringify(action.key));
      if(action.action==='delete'){if(index>=0)rows.splice(index,1);}
      else if(index>=0)rows[index]=action.fields;else rows.push(action.fields);
     });
    }else before.elements[element.element_id]=element.action==='unset'?{state:'unset'}:{state:'set',value:element.value};
   });
   securitySnapshots[update.policy_id]=before;
  });return structuredClone(securityResult());
 },
 policyShow:async(scope,id)=>{requests.push({method:'show',scope,id});return {policy:policy(scope,id)};},
 policyUpdate:async(scope,id,request)=>{
  requests.push({method:'update',scope,id,request:structuredClone(request)});
  if(rejectUpdates)throw Object.assign(Error('Fixture update rejected'),{category:'validation'});
  const updated=policy(scope,id);
  if(request.state)updated.state=request.state;
  (request.set_parameters||[]).forEach(value=>updated.parameters.find(parameter=>parameter.id===value.parameter_id).value=value.value);
  savedPolicies[scope+':'+id]=updated;return {policy:updated};
 }
}));
require.config({baseUrl:'/js'});
require(['app','components/tree-view/tree-view-list','components/tree-view/tree-view-list-data',
 'components/header/header','components/workspace/workspace','locales/translations'],
 (app,treeList,treeData,headerModule,workspaceModule,translations)=>{
  translations.setLanguage('en');
  window.state=app._test.createTreeViewState();
  state.setHeader(headerModule.renderHeader(document.getElementById('header')));
  const workspace=workspaceModule.renderWorkspace();document.getElementById('main').appendChild(workspace.getElement());
  window.roots=treeData.buildTreeViewList({preference_documents:[
   {scope:'computer',kind:'registry',label:'Registry preferences',editable:true},
   {scope:'user',kind:'registry',label:'Registry preferences',editable:true}
  ]});
  document.getElementById('tree').appendChild(treeList.renderTreeViewList(roots,workspace,state).getElement());
  window.scopeRoots={computer:roots[0].children.find(node=>node.title===translations.t('policies.machine')),
   user:roots[0].children.find(node=>node.title===translations.t('policies.user'))};
  window.templates={};window.preferenceRoots={};
  ['computer','user'].forEach(scope=>{
   const policies=scopeRoots[scope].children.find(node=>node.title===translations.t('policies.title'));
   templates[scope]=policies.children.find(node=>node.title===translations.t('policies.adminTemplates'));
   preferenceRoots[scope]=scopeRoots[scope].children.find(node=>node.title===translations.t('preferences.title'));
  });
  window.category=(scope,id)=>templates[scope].children.find(node=>node.categoryId===id);
  window.selectAdmin=scope=>state.navigateToNode(templates[scope],{openPath:true,openCurrentFolder:true});
  state.policyChangedModal=document.getElementById('confirmation');
  document.getElementById('discard').addEventListener('click',state.handlePolicyChangedNo.bind(state));
  document.getElementById('save').addEventListener('click',state.handlePolicyChangedYes.bind(state));
  window.ready=true;
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

async function switcher(page, scope, categoryId = null) {
    return page.evaluate(({ scope, categoryId }) => {
        const node = categoryId === null ? templates[scope] : category(scope, categoryId);
        const icon = state.treeListItemElements.get(node).querySelector(':scope > .tree-item > .icon-switcher');
        return { empty: icon.classList.contains('icon-switcher--empty'), visibility: getComputedStyle(icon).visibility };
    }, { scope, categoryId });
}

const contentTitles = page => page.locator('.workspace .gp__list-children__item__title').allTextContents();
const activeTitle = page => page.locator('.tree-view .tree-item.active .tree-item__title').textContent();
const catalogFilter = page => page.locator('.workspace > .gpo-category-path [data-policy-filter]');

async function folderState(page) {
    return page.evaluate(() => {
        const element = state.treeListItemElements.get(targetFolder);
        const nested = element.querySelector(':scope > ul.tree-view__list');
        return {
            opened: targetFolder.opened,
            selected: state.selectedItem.item === targetFolder,
            active: state.treeItemElements.get(targetFolder).classList.contains('active'),
            domOpened: element.classList.contains('opened'),
            domClosed: element.classList.contains('closed'),
            nestedDisplay: nested ? getComputedStyle(nested).display : null
        };
    });
}

async function expectFolder(page, opened, selected = true) {
    const actual = await folderState(page);
    assert.equal(actual.opened, opened);
    assert.equal(actual.selected, selected);
    assert.equal(actual.domOpened, opened);
    assert.equal(actual.domClosed, !opened);
    assert.equal(actual.nestedDisplay === 'none', !opened);
}

async function selectOtherFolder(page) {
    await page.evaluate(() => state.navigateToNode(otherFolder, { openPath: true, openCurrentFolder: true }));
}

async function expectPolicy(page, scope, id, title, parentTitle) {
    await page.getByRole('dialog', { name: title, exact: true }).waitFor();
    await page.locator('.gpo-admx-dialog [data-field-id="value"] input').waitFor();
    const selected = await page.evaluate(() => ({
        scope: state.selectedItem.item.scope, id: state.selectedItem.item.policyId,
        template: state.selectedItem.item.template, hidden: state.selectedItem.item.showInTree === false,
        path: state.selectedPath.map(node => node.title),
        hasTreeElement: state.treeItemElements.has(state.selectedItem.item)
    }));
    assert.equal(selected.scope, scope);
    assert.equal(selected.id, id);
    assert.equal(selected.template, 'admx');
    assert.equal(selected.hidden, true);
    assert.equal(selected.hasTreeElement, false);
    assert.deepEqual(selected.path.slice(-2), [parentTitle, title]);
    assert.equal(await activeTitle(page), parentTitle);
    assert.equal(await page.locator('.tree-view .tree-item__title').filter({ hasText: title }).count(), 0);
    assert.equal(await page.evaluate(({ scope, id }) => requests.some(request => request.method === 'show' && request.scope === scope && request.id === id), { scope, id }), true);
}

test('Administrative Templates lazy loads category-only trees and refreshes empty expanders while failed loads remain retryable', browserOptions, async () => {
    await withPage(async page => {
        for (const scope of ['computer', 'user']) {
            assert.equal((await switcher(page, scope)).empty, false);
            await page.evaluate(scope => selectAdmin(scope), scope);
            assert.deepEqual(await contentTitles(page), ['Empty category', 'Mixed category', 'Policy-only category', 'Retry category', 'Zulu root policy']);
            assert.equal((await switcher(page, scope)).empty, false);
            for (const [id, title, expected, empty] of [
                ['only', 'Policy-only category', ['alpha only policy', 'Zulu only policy'], true],
                ['mixed', 'Mixed category', ['Nested category', 'alpha policy', 'Zulu policy'], false],
                ['empty', 'Empty category', [], true]
            ]) {
                assert.equal((await switcher(page, scope, id)).empty, false);
                await page.getByRole('button', { name: title, exact: true }).click();
                await page.waitForFunction(({ scope, id }) => state.selectedItem.item === category(scope, id), { scope, id });
                assert.deepEqual(await contentTitles(page), expected);
                const icon = await switcher(page, scope, id);
                assert.equal(icon.empty, empty);
                assert.equal(icon.visibility, empty ? 'hidden' : 'visible');
                assert.equal(await page.evaluate(({ scope, id }) => category(scope, id).children.length, { scope, id }), expected.length);
                await page.evaluate(scope => selectAdmin(scope), scope);
            }
            await page.getByRole('button', { name: 'Retry category', exact: true }).click();
            await page.locator('.tree-view__lazy-error').last().waitFor();
            await page.waitForFunction(scope => {
                const node = category(scope, 'retry');
                return node.loadingPromise === null
                    && !state.treeListItemElements.get(node).classList.contains('loading');
            }, scope);
            assert.equal((await switcher(page, scope, 'retry')).empty, false);
            assert.equal(await page.evaluate(scope => Boolean(category(scope, 'retry').loaded), scope), false);
            assert.equal(await page.evaluate(scope => retryAttempts[scope], scope), 1);
            await page.getByRole('button', { name: 'Retry category', exact: true }).click();
            await page.waitForFunction(scope => {
                const node = category(scope, 'retry');
                return node.loaded && node.loadingPromise === null && state.selectedItem.item === node;
            }, scope);
            await page.getByRole('button', { name: 'Retry policy', exact: true }).waitFor();
            assert.equal(await page.evaluate(scope => retryAttempts[scope], scope), 2);
            assert.equal((await switcher(page, scope, 'retry')).empty, true);
            assert.equal(await page.locator('.tree-view .tree-item__title').filter({ hasText: /policy$/i }).count(), 0);
            await page.evaluate(scope => selectAdmin(scope), scope);
        }
        // Scripts and Preferences keep their normal file nodes in the tree.
        assert.equal(await page.locator('.tree-view .view.file').count(), 4);
    });
});

for (const scope of ['computer', 'user']) {
    test(`Hidden ${scope} Administrative Templates policies open from content by double-click and keyboard and retain guarded parent navigation`, browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(scope => selectAdmin(scope), scope);
            // A different active tree node makes ancestor activation observable.
            await page.evaluate(() => state.activateTreeItem(roots[0]));
            await page.getByRole('button', { name: 'Zulu root policy', exact: true }).dblclick();
            await expectPolicy(page, scope, 'orphan', 'Zulu root policy', 'Administrative Templates');
            assert.equal(await page.evaluate(() => state.parentItems.get(state.selectedItem.item).opened), true);
            await page.locator('.workspace [data-field-id="value"] input').fill('discard this draft');
            assert.equal(await page.evaluate(() => state.currentView.hasUnsavedChanges()), true);
            await page.evaluate(() => state.treeItemElements.get(state.parentItems.get(state.selectedItem.item)).click());
            await page.getByRole('alertdialog', { name: 'Unsaved policy' }).waitFor();
            assert.equal(await page.locator('.workspace [data-field-id="value"] input').inputValue(), 'discard this draft');
            assert.equal(await page.evaluate(() => state.selectedItem.item.policyId), 'orphan');
            assert.equal(await page.evaluate(() => state.pendingNavigation.item === state.parentItems.get(state.selectedItem.item)), true);
            assert.equal(await page.evaluate(() => state.parentItems.get(state.selectedItem.item).opened), true);
            await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
            await page.getByRole('button', { name: 'Policy-only category', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => state.selectedItem.item.opened), true);
            assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'update').length), 0);

            await page.getByRole('button', { name: 'Policy-only category', exact: true }).click();
            const enterPolicy = page.getByRole('button', { name: 'alpha only policy', exact: true });
            await enterPolicy.waitFor();
            await page.evaluate(() => state.activateTreeItem(roots[0]));
            await enterPolicy.press('Enter');
            await expectPolicy(page, scope, 'only-a', 'alpha only policy', 'Policy-only category');
            await page.locator('.workspace [data-field-id="value"] input').fill('save this draft');
            await page.evaluate(() => state.treeItemElements.get(state.parentItems.get(state.selectedItem.item)).click());
            await page.getByRole('alertdialog', { name: 'Unsaved policy' }).waitFor();
            await page.getByRole('button', { name: 'Save changes', exact: true }).click();
            await page.getByRole('button', { name: 'alpha only policy', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => state.selectedItem.item.opened), true);
            const updates = await page.evaluate(() => requests.filter(request => request.method === 'update'));
            assert.equal(updates.length, 1);
            assert.equal(updates[0].scope, scope);
            assert.equal(updates[0].id, 'only-a');
            assert.deepEqual(updates[0].request.set_parameters, [{ parameter_id: 'value', value: { kind: 'text', value: 'save this draft' } }]);

            await page.evaluate(scope => selectAdmin(scope), scope);
            await page.getByRole('button', { name: 'Mixed category', exact: true }).click();
            await page.getByRole('button', { name: 'Nested category', exact: true }).press('Enter');
            const spacePolicy = page.getByRole('button', { name: 'Nested policy', exact: true });
            await spacePolicy.waitFor();
            await page.evaluate(() => state.activateTreeItem(roots[0]));
            await spacePolicy.press('Space');
            assert.equal(await page.locator('.gpo-admx-dialog').count(), 0, 'Space only selects the row');
            await spacePolicy.press('Enter');
            await expectPolicy(page, scope, 'nested-policy', 'Nested policy', 'Nested category');
            await page.evaluate(() => state.treeItemElements.get(state.parentItems.get(state.selectedItem.item)).querySelector('.tree-item__title').click());
            await page.getByRole('button', { name: 'Nested policy', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => state.selectedItem.item.type), 'folder');
            assert.equal(await page.evaluate(() => state.selectedItem.item.opened), true);

            const securityActivation = await page.evaluate(scope => {
                state.activateTreeItem(roots[0]);
                const security = { type: 'file', template: 'security', showInTree: false };
                state.registerTreeNode(security, { parentItem: templates[scope] });
                return state.activateTreeItem(security);
            }, scope);
            assert.equal(securityActivation, null);
            assert.equal(await activeTitle(page), 'Example GPO');
        });
    });
}

for (const area of ['Administrative Templates', 'Preferences']) {
    test(`${area} folder titles preserve expansion on selection, toggle only the actual selection, and arrows do not select`, browserOptions, async () => {
        await withPage(async page => {
            if (area === 'Administrative Templates') {
                await page.evaluate(() => selectAdmin('computer'));
                await page.getByRole('button', { name: 'Mixed category', exact: true }).click();
                await page.getByRole('button', { name: 'Nested category', exact: true }).waitFor();
                await page.evaluate(() => {
                    window.targetFolder = category('computer', 'mixed');
                    window.otherFolder = templates.computer;
                });
            } else {
                await page.evaluate(async () => {
                    window.otherFolder = preferenceRoots.computer;
                    window.targetFolder = otherFolder.children.find(node => node.preferenceCategoryId === 'other_settings');
                    await state.navigateToNode(targetFolder, { openPath: true, openCurrentFolder: true });
                });
                await page.getByRole('button', { name: 'Registry preferences', exact: true }).waitFor();
            }
            await page.evaluate(() => state.treeItemElements.get(targetFolder).setAttribute('data-test-folder', 'target'));
            const title = page.locator('[data-test-folder="target"] > .tree-item__title');
            const arrow = page.locator('[data-test-folder="target"] > .icon-switcher');
            await expectFolder(page, true);

            await selectOtherFolder(page);
            // An active CSS class is not the current folder selection.
            await page.evaluate(() => state.activateTreeItem(targetFolder));
            await expectFolder(page, true, false);
            assert.equal((await folderState(page)).active, true);
            await title.click();
            await expectFolder(page, true);
            await title.click();
            await expectFolder(page, false);

            await arrow.click();
            await expectFolder(page, true);
            await arrow.click();
            await expectFolder(page, false);

            await selectOtherFolder(page);
            await title.click();
            await expectFolder(page, false);
            await selectOtherFolder(page);
            await arrow.click();
            await expectFolder(page, true, false);
            await selectOtherFolder(page);
            await arrow.click();
            await expectFolder(page, false, false);
        });
    });
}

test('Hidden policy parent selection remains guarded while its arrows preserve the dirty editor without navigating', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => selectAdmin('computer'));
        await page.getByRole('button', { name: 'Mixed category', exact: true }).click();
        await page.getByRole('button', { name: 'alpha policy', exact: true }).dblclick();
        await expectPolicy(page, 'computer', 'mixed-a', 'alpha policy', 'Mixed category');
        await page.evaluate(() => {
            window.targetFolder = category('computer', 'mixed');
            state.treeItemElements.get(targetFolder).setAttribute('data-test-folder', 'target');
        });
        const title = page.locator('[data-test-folder="target"] > .tree-item__title');
        const arrow = page.locator('[data-test-folder="target"] > .icon-switcher');
        const dialog = page.getByRole('alertdialog', { name: 'Unsaved policy' });
        const input = page.locator('.workspace [data-field-id="value"] input');
        await input.fill('keep this draft');
        await expectFolder(page, true, false);
        assert.equal((await folderState(page)).active, true);

        await title.evaluate(element => element.click());
        await dialog.waitFor();
        await expectFolder(page, true, false);
        assert.equal(await page.evaluate(() => state.pendingNavigation.options.openCurrentFolder), undefined);
        // The guard supports views that cancel a discard by returning false.
        await page.evaluate(() => {
            window.cancelPolicyChanges = state.currentView.cancelChanges;
            state.currentView.cancelChanges = () => false;
        });
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
        assert.equal(await page.evaluate(() => state.pendingNavigation), null);
        await expectFolder(page, true, false);
        assert.equal(await input.inputValue(), 'keep this draft');
        await page.evaluate(() => { state.currentView.cancelChanges = cancelPolicyChanges; window.rejectUpdates = true; });

        await title.evaluate(element => element.click());
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.locator('.workspace .gpo-editor-form__error [role="alert"]').waitFor();
        await page.waitForFunction(() => state.pendingNavigation === null);
        await expectFolder(page, true, false);
        assert.equal(await input.inputValue(), 'keep this draft');
        assert.equal(await page.evaluate(() => state.currentView.hasUnsavedChanges()), true);

        const renderRequestId = await page.evaluate(() => state.renderRequestId);
        await arrow.evaluate(element => element.click());
        await expectFolder(page, false, false);
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await page.evaluate(() => state.pendingNavigation), null);
        assert.equal(await input.inputValue(), 'keep this draft');

        await arrow.evaluate(element => element.click());
        await expectFolder(page, true, false);
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await page.evaluate(() => state.renderRequestId), renderRequestId);
        assert.equal(await input.inputValue(), 'keep this draft');

        await title.evaluate(element => element.click());
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
        await page.getByRole('button', { name: 'Nested category', exact: true }).waitFor();
        await expectFolder(page, true);
    });
});

test('All Policies searches the full scoped inventory before paging and edits AT in place with guarded discard', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            window.allUser = scopeRoots.user.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        await page.waitForFunction(() => ['admx', 'security', 'audit'].every(name =>
            allComputer.policySearchSources[name]?.status === 'ready'));
        const computer = page.locator('[data-all-policies-scope="computer"]');
        assert.equal(await computer.locator('[data-policy-refresh]').count(), 0);
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 100);
        assert.equal(await computer.locator('[data-policy-page-next]').isVisible(), true);
        const initialCounts = await page.evaluate(() => ({
            admx: allComputer.policySearchSources.admx.rows.length,
            security: allComputer.policySearchSources.security.rows.length,
            audit: allComputer.policySearchSources.audit.rows.length,
            scripts: allComputer.policySearchSources.scripts.rows.length,
            preferences: allComputer.policySearchSources.preferences.rows.length
        }));
        assert.deepEqual(initialCounts, { admx: 1202, security: 185, audit: 7, scripts: 2, preferences: 1 });
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'policyIndex' && request.scope === 'computer').length), 1);
        assert.equal(await page.evaluate(() => allComputer.children.length), 0);

        const query = catalogFilter(page);
        await query.fill('NESTED CATEGORY 1200');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        assert.match(await computer.locator('[data-policy-result-id]').first().textContent(), /Bulk policy 1200/);
        await query.fill('Security item 184');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        await query.fill('Registry preferences');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        await query.fill('Startup scripts');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        await query.fill('Rare policy');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        await computer.locator('[data-policy-result-id]').dblclick();
        const modal = page.getByRole('dialog', { name: 'Rare policy beyond first page', exact: true });
        await modal.locator('[data-field-id="value"] input').waitFor();
        assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
        assert.equal(await activeTitle(page), 'All Policies');
        assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
        await modal.locator('[data-field-id="value"] input').fill('draft from search');
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        const discard = page.locator('.policy-changed__modal--discard');
        await discard.waitFor();
        assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
        await discard.getByRole('button', { name: 'Yes', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        await computer.waitFor();
        assert.equal(await catalogFilter(page).inputValue(), 'Rare policy');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        assert.equal(await computer.locator('[data-policy-result-id][aria-selected="true"]').count(), 1);
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'policyIndex' && request.scope === 'computer').length), 1);

        await page.evaluate(() => state.navigateToNode(allUser, { openPath: true, openCurrentFolder: true }));
        await page.waitForFunction(() => allUser.policySearchSources.admx?.status === 'ready');
        assert.equal(await page.evaluate(() => allUser.policySearchSources.scripts.rows.length), 2);
        assert.equal(await page.evaluate(() => allUser.policySearchSources.preferences.rows.length), 1);
        assert.equal(await page.evaluate(() => Boolean(allUser.policySearchSources.security || allUser.policySearchSources.audit)), false);
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'policyIndex' && request.scope === 'user').length), 1);
        assert.equal(await page.evaluate(() => requests.some(request => request.method === 'update')), false);
    });
});

test('All Policies reports failed sources as incomplete and retries without repeating healthy index requests', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            window.failSecurityIndex = true;
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        await page.waitForFunction(() => allComputer.policySearchSources.security?.status === 'error'
            && allComputer.policySearchSources.admx?.status === 'ready');
        const computer = page.locator('[data-all-policies-scope="computer"]');
        await computer.locator('[data-policy-retry]').waitFor();
        assert.match(await computer.textContent(), /incomplete/i);
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 100,
            'healthy AT rows stay available while security is incomplete');
        await page.evaluate(() => { window.failSecurityIndex = false; });
        await computer.locator('[data-policy-retry]').click();
        await page.waitForFunction(() => allComputer.policySearchSources.security?.status === 'ready');
        assert.equal(await computer.locator('[data-policy-retry]').count(), 0);
        assert.equal(await page.evaluate(() => allComputer.policySearchSources.security.rows.length), 185);
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'policyIndex').length), 1);
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'securityIndex').length), 2);
    });
});

test('All Policies provides localized Russian search for individual script events and path labels', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            const translate = require('locales/translations');
            translate.setLanguage('ru');
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        const computer = page.locator('[data-all-policies-scope="computer"]');
        await catalogFilter(page).fill('СЦЕНАРИИ ЗАПУСКА');
        await page.waitForFunction(() => allComputer.policySearchSources.admx?.status === 'ready');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 1);
        assert.match(await computer.locator('[data-policy-result-id]').first().textContent(), /Сценарии запуска/);
        assert.equal(await catalogFilter(page).getAttribute('placeholder'),
            'Поиск политик компьютера');
        await catalogFilter(page).fill('ПАРАМЕТРЫ БЕЗОПАСНОСТИ');
        assert.equal(await computer.locator('[data-policy-result-id]').count(), 100,
            'all 185 Security Settings entries are searched before paging');
        assert.equal(await page.evaluate(() => allComputer.policySearchSources.security.rows.length), 185);
    });
});

test('All Policies aliases open the existing Security, Advanced Audit and Scripts contextual editors', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        await page.waitForFunction(() => ['admx', 'security', 'audit'].every(name =>
            allComputer.policySearchSources[name]?.status === 'ready'));
        async function findAndOpen(query) {
            const list = page.locator('[data-all-policies-scope="computer"]');
            await catalogFilter(page).fill(query);
            assert.equal(await list.locator('[data-policy-result-id]').count(), 1);
            await list.locator('[data-policy-result-id]').dblclick();
        }

        await findAndOpen('Security item 184');
        await page.locator('.gpo-security-dialog').waitFor();
        assert.equal(await page.evaluate(() => state.selectedItem.item.template), 'all_policies');
        assert.equal(await page.locator('[data-security-policy="security-184"]').count(), 1);
        assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
        await page.locator('.gpo-security-dialog__close').click();
        assert.equal(await catalogFilter(page).inputValue(), 'Security item 184');
        await findAndOpen('File global SACL');
        await page.locator('.gpo-security-dialog [data-advanced-audit-form]').waitFor();
        assert.equal(await page.evaluate(() => state.selectedItem.item.template), 'all_policies');
        assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
        assert.equal(await page.locator('[data-advanced-audit-view]').count(), 0);
        await page.locator('.gpo-security-dialog__close').click();
        assert.equal(await catalogFilter(page).inputValue(), 'File global SACL');
        await findAndOpen('Startup scripts');
        await page.locator('.gpo-editor-scripts__event-dialog').waitFor();
        assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
        assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
        await page.locator('.gpo-editor-scripts__event-dialog').press('Escape');
        assert.equal(await catalogFilter(page).inputValue(), 'Startup scripts');
        assert.equal(await page.evaluate(() => requests.some(request => request.method === 'update')), false);
    });
});

for (const language of ['en', 'ru']) {
    test(`All Policies security applies, cancels and retries in place while preserving paged context in ${language}`, browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => {
                require('locales/translations').setLanguage(language);
                window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
                return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
            }, language);
            await page.waitForFunction(() => allComputer.policySearchSources.security?.status === 'ready');
            const list = page.locator('[data-all-policies-scope="computer"]');
            await catalogFilter(page).fill('Security item');
            await list.locator('[data-policy-page-next]').click();
            const row = list.locator('[data-policy-result-id]').filter({ hasText: 'Security item 184' });
            await row.click();
            await page.evaluate(() => document.querySelector('.gpo-security-workbench__panel').scrollTop = 80);
            const before = await page.evaluate(() => ({
                ...allComputer.policySearchState,
                scrollTop: document.querySelector('.gpo-security-workbench__panel').scrollTop,
                renderRequestId: state.renderRequestId,
                indices: requests.filter(request => ['policyIndex', 'securityIndex', 'auditIndex'].includes(request.method)).length
            }));
            // The main Edit action must open exactly the selected security result.
            await page.locator('#header .preferences__btn-edit').click();
            const dialog = page.locator('.gpo-security-dialog');
            await dialog.waitFor();
            assert.equal(await page.locator('[data-security-policy="security-184"]').count(), 1);
            assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
            assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
            await dialog.locator('[data-security-define]').check();
            await dialog.locator('.btn-cancel').click();
            const confirmation = page.getByRole('alertdialog');
            await confirmation.waitFor();
            await confirmation.locator('.btn-no').click();
            assert.equal(await dialog.locator('[data-security-define]').isChecked(), true);
            await page.evaluate(() => window.rejectUpdates = true);
            await dialog.locator('.btn-ok').click();
            await dialog.locator('[data-error-category="validation"]').waitFor();
            assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'securityUpdate').length), 1);
            assert.equal(await dialog.locator('[data-security-define]').isChecked(), true);
            await page.evaluate(() => window.rejectUpdates = false);
            await dialog.locator('.btn-ok').click();
            await dialog.waitFor({ state: 'hidden' });
            const after = await page.evaluate(() => ({
                ...allComputer.policySearchState,
                scrollTop: document.querySelector('.gpo-security-workbench__panel').scrollTop,
                renderRequestId: state.renderRequestId,
                indices: requests.filter(request => ['policyIndex', 'securityIndex', 'auditIndex'].includes(request.method)).length
            }));
            assert.deepEqual(after, before);
            assert.equal(await list.locator('[aria-selected="true"]').textContent(), await row.textContent());
            assert.equal(await page.evaluate(() => allComputer.policySearchSources.security.response.security_snapshot.policies[0].state), 'defined');
            assert.equal(await list.locator('[data-policy-refresh]').count(), 0);
            await row.dblclick();
            await dialog.waitFor();
            await dialog.locator('[data-security-define]').uncheck();
            await dialog.press('Escape');
            await confirmation.waitFor();
            await confirmation.locator('.btn-yes').click();
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(await page.evaluate(() => securitySnapshots['security-184'].state), 'defined');
            assert.equal(await catalogFilter(page).inputValue(), 'Security item');
            await row.dblclick();
            await dialog.locator('[data-security-define]').uncheck();
            await dialog.locator('.btn-ok').click();
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(await list.locator('[aria-selected="true"]').evaluate(element => element === document.activeElement), true,
                'Apply restores focus on the new row after replacing the detached opener');
        });
    });
}

test('All Policies collection security results browse existing items in a dialog and keep nested focus in its row editor', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            window.securityCollectionFixture = {namespace:'fixture',policy_id:'groups',display_name:'Restricted Groups fixture',
                category:['fixture','security'],elements:[{id:'entries',value_type:'collection',unique_by:'name',
                    fields:[{id:'name',required:true,element:{value_type:'text'}}]}],
                controls:[{element_id:'entries',children:[{element_id:'name',label:'Name'}]}]};
            window.securitySnapshots.groups = {namespace:'fixture',policy_id:'groups',state:'defined',elements:{entries:{state:'set',value:{kind:'collection',value:[
                {name:{state:'set',value:{kind:'text',value:'Example group'}}}
            ]}}}};
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        const list = page.locator('[data-all-policies-scope="computer"]');
        await page.waitForFunction(() => allComputer.policySearchSources.security?.status === 'ready');
        await catalogFilter(page).fill('Restricted Groups fixture');
        await list.locator('[data-policy-result-id]').dblclick();
        const collection = page.locator('.gpo-security-dialog').first();
        await collection.locator('[data-security-row="Example group"]').waitFor();
        assert.equal(await collection.locator('h2').count(), 0, 'the modal title replaces the duplicate toolbar heading');
        const toolbarFits = await collection.locator('.gpo-security-workbench__toolbar').evaluate(toolbar => {
            const bounds = toolbar.getBoundingClientRect();
            return Array.from(toolbar.querySelectorAll('button,input')).every(control => {
                const rect = control.getBoundingClientRect();
                return rect.left >= bounds.left && rect.right <= bounds.right + 1;
            });
        });
        assert.equal(toolbarFits, true);
        assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
        assert.equal(await page.locator('[data-policy-search-back]').count(), 0);
        await collection.locator('[data-security-row="Example group"]').dblclick();
        const rowEditor = page.locator('.gpo-security-dialog').last();
        await rowEditor.locator('input[type="text"]').waitFor();
        assert.equal(await page.locator('.gpo-security-dialog').count(), 2);
        await rowEditor.locator('.btn-ok').focus();
        await page.keyboard.press('Tab');
        assert.equal(await rowEditor.locator('.close').evaluate(button => document.activeElement === button), true);
        await rowEditor.press('Escape');
        assert.equal(await page.locator('.gpo-security-dialog').count(), 1);
        await collection.locator('[data-security-row="Example group"]').dblclick();
        await rowEditor.locator('input[type="text"]').fill('Edited group');
        await rowEditor.locator('.btn-ok').click();
        await page.waitForFunction(() => document.querySelectorAll('.gpo-security-dialog').length === 1);
        assert.equal(await collection.locator('[data-security-row="Edited group"]').evaluate(element => element === document.activeElement), true,
            'nested Apply restores focus to the updated collection row');
        await collection.locator('.close').click();
        await collection.waitFor({ state: 'hidden' });
        assert.equal(await catalogFilter(page).inputValue(), 'Restricted Groups fixture');
        assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'securityUpdate').length), 1);
    });
});

for (const language of ['en', 'ru']) {
    test(`All Policies Advanced Audit applies and cancels in place while preserving paged context in ${language}`, browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => {
                require('locales/translations').setLanguage(language);
                window.auditFixture = { advanced_audit: { rows: Array.from({ length: 125 }, (_, index) => ({
                    kind: 'option', option: 'fixture-' + index, editable: true, enabled: false,
                    display_name: 'Audit fixture ' + String(index).padStart(3, '0')
                })), subcategory_catalog: [] } };
                const API = require('util/API');
                API.advancedAuditShow = async () => {
                    requests.push({ method: 'auditIndex' }); return structuredClone(auditFixture);
                };
                API.advancedAuditUpdate = async request => {
                    requests.push({ method: 'auditUpdate', request: structuredClone(request) });
                    if (rejectUpdates) throw Object.assign(Error('Fixture audit update rejected'), { category: 'validation' });
                    request.set_options.forEach(update => Object.assign(auditFixture.advanced_audit.rows.find(row => row.option === update.option), update));
                    return structuredClone(auditFixture);
                };
                window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
                return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
            }, language);
            await page.waitForFunction(() => ['admx', 'security', 'audit'].every(name => allComputer.policySearchSources[name]?.status === 'ready'));
            const list = page.locator('[data-all-policies-scope="computer"]');
            await catalogFilter(page).fill('Audit fixture');
            await list.locator('[data-policy-page-next]').click();
            const row = list.locator('[data-policy-result-id]').filter({ hasText: 'Audit fixture 124' });
            await row.click();
            await page.evaluate(() => {
                window.originalSecurityRows = allComputer.policySearchSources.security.rows;
                window.originalAdmxRows = allComputer.policySearchSources.admx.rows;
                window.originalAuditRows = allComputer.policySearchSources.audit.rows;
                document.querySelector('.gpo-security-workbench__panel').scrollTop = 80;
            });
            const context = () => page.evaluate(() => ({
                ...allComputer.policySearchState,
                scrollTop: document.querySelector('.gpo-security-workbench__panel').scrollTop,
                renderRequestId: state.renderRequestId,
                indices: requests.filter(request => ['policyIndex', 'securityIndex', 'auditIndex'].includes(request.method)).length
            }));
            const before = await context();
            // The row is already focused. Dispatch the user's key without
            // Playwright refocusing (and scrolling) the off-screen selection.
            await row.dispatchEvent('keydown', { key: 'Enter' });
            const dialog = page.locator('.gpo-security-dialog');
            await dialog.locator('[data-advanced-audit-form]').waitFor();
            assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
            assert.equal(await page.locator('[data-policy-search-back], [data-advanced-audit-view]').count(), 0);
            await dialog.locator('[data-advanced-audit-enabled]').check();
            await dialog.locator('.btn-cancel').click();
            const confirmation = page.getByRole('alertdialog');
            await confirmation.locator('.btn-no').click();
            assert.equal(await dialog.locator('[data-advanced-audit-enabled]').isChecked(), true);
            await page.evaluate(() => window.rejectUpdates = true);
            await dialog.locator('.btn-ok').click();
            await dialog.locator('[data-error-category="validation"]').waitFor();
            assert.equal(await dialog.locator('[data-advanced-audit-enabled]').isChecked(), true);
            await page.evaluate(() => window.rejectUpdates = false);
            await dialog.locator('.btn-ok').click();
            await dialog.waitFor({ state: 'hidden' });
            assert.deepEqual(await context(), before);
            assert.equal(await row.evaluate(element => element === document.activeElement), true);
            assert.equal(await page.evaluate(() => allComputer.policySearchSources.security.rows === originalSecurityRows
                && allComputer.policySearchSources.admx.rows === originalAdmxRows
                && allComputer.policySearchSources.audit.rows !== originalAuditRows), true);
            const update = await page.evaluate(() => requests.filter(request => request.method === 'auditUpdate').at(-1).request);
            assert.deepEqual(update.set_options, [{ machine_name: '', option: 'fixture-124', enabled: true }]);
            assert.equal(await page.evaluate(() => allComputer.policySearchSources.audit.response.advanced_audit.rows.find(row => row.option === 'fixture-124').enabled), true);
            await page.locator('#header .preferences__btn-edit').click();
            await dialog.locator('[data-advanced-audit-form]').waitFor();
            await dialog.locator('[data-advanced-audit-enabled]').uncheck();
            await dialog.press('Escape');
            await confirmation.locator('.btn-yes').click();
            await dialog.waitFor({ state: 'hidden' });
            assert.deepEqual(await context(), before);
            assert.equal(await page.evaluate(() => auditFixture.advanced_audit.rows.find(row => row.option === 'fixture-124').enabled), true);
            assert.equal(await page.evaluate(() => requests.filter(request => request.method === 'auditUpdate').length), 2);
        });
    });
}

test('All Policies Advanced Audit keeps readonly and duplicate preserved rows in place and cancels stale opens', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => {
            const response = { advanced_audit: { rows: [
                { kind: 'option', option: 'readonly-fixture', display_name: 'Read-only audit fixture', editable: false, enabled: true },
                { kind: 'preserved', raw: 'duplicate fixture', fields: ['same'], reason: 'same', sddl: 'First preserved descriptor' },
                { kind: 'preserved', raw: 'duplicate fixture', fields: ['same'], reason: 'same', sddl: 'Second preserved descriptor' }
            ], subcategory_catalog: [] } };
            require('util/API').advancedAuditShow = async () => response;
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        await page.waitForFunction(() => allComputer.policySearchSources.audit?.status === 'ready');
        const list = page.locator('[data-all-policies-scope="computer"]');
        await catalogFilter(page).fill('Read-only audit fixture');
        await list.locator('[data-policy-result-id]').dblclick();
        const dialog = page.locator('.gpo-security-dialog');
        await dialog.waitFor();
        assert.equal(await dialog.locator('.btn-ok').count(), 0);
        assert.equal(await page.evaluate(() => state.selectedItem.item === allComputer), true);
        await dialog.locator('.btn-cancel').click();
        await catalogFilter(page).fill('Preserved source row');
        assert.equal(await list.locator('[data-policy-result-id]').count(), 2);
        const duplicateId = await page.evaluate(() => allComputer.policySearchSources.audit.rows.find(row => row.target.advancedAuditOccurrence === 1).id);
        const duplicateIndex = await list.locator('[data-policy-result-id]').evaluateAll((rows, id) => rows.findIndex(row => row.getAttribute('data-policy-result-id') === id), duplicateId);
        await list.locator('[data-policy-result-id]').nth(duplicateIndex).dblclick();
        await dialog.locator('.gpo-security-preserved-value').waitFor();
        assert.equal(await dialog.locator('.gpo-security-preserved-value').textContent(), 'Second preserved descriptor');
        assert.equal(await dialog.locator('.btn-ok').count(), 0);
        assert.equal(await page.locator('[data-policy-search-back], [data-advanced-audit-view]').count(), 0);
        await dialog.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await catalogFilter(page).inputValue(), 'Preserved source row');
        await page.evaluate(async () => {
            document.querySelectorAll('[data-policy-result-id]')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await selectAdmin('computer');
        });
        assert.equal(await page.locator('.gpo-security-dialog').count(), 0);
        assert.equal(await page.evaluate(() => state.selectedItem.item === templates.computer), true);
        assert.equal(await page.evaluate(() => requests.some(request => request.method === 'auditUpdate')), false);
    });
});

test('Tree security and audit saves update only their cached All Policies source and All Policies audit saves update tree snapshots', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(async () => {
            window.auditFixture = { advanced_audit: { rows: [{ kind: 'option', option: 'fixture-option',
                editable: true, enabled: false, display_name: 'Audit fixture option' }], subcategory_catalog: [] } };
            const API = require('util/API');
            API.advancedAuditShow = async () => {
                requests.push({ method: 'auditIndex' }); return structuredClone(auditFixture);
            };
            API.advancedAuditUpdate = async request => {
                request.set_options.forEach(update => Object.assign(auditFixture.advanced_audit.rows[0], update));
                return structuredClone(auditFixture);
            };
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            await state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true });
        });
        await page.waitForFunction(() => ['admx', 'security', 'audit'].every(name => allComputer.policySearchSources[name]?.status === 'ready'));
        await catalogFilter(page).fill('Security item');
        await page.locator('[data-policy-page-next]').click();
        const context = await page.evaluate(() => {
            window.originalSearchSources = { ...allComputer.policySearchSources };
            return { ...allComputer.policySearchState };
        });
        await page.evaluate(async () => {
            const policies = scopeRoots.computer.children.find(node => node.title === require('locales/translations').t('policies.title'));
            window.securityRoot = policies.children[0].children.find(node => node.lazy);
            await state.navigateToNode(securityRoot, { openPath: true, openCurrentFolder: true });
            window.securityCategory = securityRoot.children.find(node => node.securityCategory);
            window.auditCategory = securityRoot.children.find(node => node.children?.some(child => child.advancedAuditFamilyId))
                .children.find(node => node.advancedAuditFamilyId === 'audit_options');
            await state.navigateToNode(securityCategory, { openPath: true, openCurrentFolder: true });
        });
        await page.locator('[data-security-row="Security item 184"]').dblclick();
        const dialog = page.locator('.gpo-security-dialog');
        await dialog.locator('[data-security-define]').check();
        await dialog.locator('.btn-ok').click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => allComputer.policySearchSources.security.response.security_snapshot.policies[0].state), 'defined');
        assert.equal(await page.evaluate(() => allComputer.policySearchSources.security !== originalSearchSources.security
            && allComputer.policySearchSources.admx === originalSearchSources.admx
            && allComputer.policySearchSources.audit === originalSearchSources.audit), true);
        await page.evaluate(() => state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true }));
        assert.deepEqual(await page.evaluate(() => ({ ...allComputer.policySearchState })), context);
        await page.locator('[data-policy-result-id]').filter({ hasText: 'Security item 184' }).dblclick();
        assert.equal(await dialog.locator('[data-security-define]').isChecked(), true);
        await dialog.locator('.btn-cancel').click();
        await page.evaluate(() => state.navigateToNode(auditCategory, { openPath: true, openCurrentFolder: true }));
        await page.locator('[data-advanced-audit-id="fixture-option"]').dblclick();
        await dialog.locator('[data-advanced-audit-enabled]').check();
        await dialog.locator('.btn-ok').click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => allComputer.policySearchSources.audit.response.advanced_audit.rows[0].enabled), true);
        await page.evaluate(() => state.navigateToNode(allComputer, { openPath: true, openCurrentFolder: true }));
        await catalogFilter(page).fill('Audit fixture option');
        await page.locator('[data-policy-result-id]').dblclick();
        assert.equal(await dialog.locator('[data-advanced-audit-enabled]').isChecked(), true);
        await dialog.locator('[data-advanced-audit-enabled]').uncheck();
        await dialog.locator('.btn-ok').click();
        await dialog.waitFor({ state: 'hidden' });
        await page.evaluate(() => state.navigateToNode(auditCategory, { openPath: true, openCurrentFolder: true }));
        await page.locator('[data-advanced-audit-id="fixture-option"]').dblclick();
        assert.equal(await dialog.locator('[data-advanced-audit-enabled]').isChecked(), false);
        await dialog.locator('.btn-cancel').click();
    });
});

test('Current clickable paths include normal policy ancestry while All Policies dialogs retain the catalog path', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => selectAdmin('computer'));
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / Policies / Administrative Templates');
        await page.evaluate(() => state.navigateToNode(category('computer','mixed'), {openPath:true,openCurrentFolder:true}));
        await page.getByRole('button', { name: 'Nested category', exact: true }).click();
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / Policies / Administrative Templates / Mixed category / Nested category');
        await page.getByRole('button', {name:'Nested policy',exact:true}).dblclick();
        await page.locator('.gp__admx-settings').waitFor();
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / Policies / Administrative Templates / Mixed category / Nested category / Nested policy');
        await page.evaluate(() => {
            window.allComputer = scopeRoots.computer.children.find(node => node.template === 'all_policies');
            return state.navigateToNode(allComputer, {openPath:true,openCurrentFolder:true});
        });
        await page.waitForFunction(() => allComputer.policySearchSources.admx?.status === 'ready');
        await catalogFilter(page).fill('Rare policy');
        await page.locator('[data-policy-result-id]').dblclick();
        await page.locator('.gp__admx-settings').waitFor();
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / All Policies');
        await page.locator('.gpo-admx-dialog .btn-cancel').click();
        await catalogFilter(page).fill('Registry preferences');
        await page.locator('[data-policy-result-id]').dblclick();
        await page.locator('.gpo-editor-preferences__header').waitFor();
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / All Policies');
        await page.locator('.gpo-preferences-family-dialog .btn-cancel').click();
        await catalogFilter(page).fill('Startup scripts');
        await page.locator('[data-policy-result-id]').dblclick();
        await page.locator('.gpo-editor-scripts__event-dialog').waitFor();
        assert.equal(await page.locator('.workspace [data-category-path]').textContent(), 'Example GPO / Computer / All Policies');
    });
});
