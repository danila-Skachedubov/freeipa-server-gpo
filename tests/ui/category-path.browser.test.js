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
<style>body{font:12px Arial,sans-serif}.gp__container{height:100vh}#confirmation{display:none}#confirmation.active{display:block;position:fixed;z-index:2000;top:40px;left:450px;background:white}</style>
</head><body><div class="gp__container"><div id="header"></div><div id="main" class="gp__main"><nav id="tree" class="tree-view"></nav></div>
<div id="confirmation" role="alertdialog"><button id="discard">Discard</button><button id="save">Save</button><button id="stay">Cancel navigation</button></div></div>
<script src="/require.js"></script><script>
window.requests=[];
function labels(){return translations.getLanguage()==='ru'?{category:'Управление пакетами',policy:'Установка программ',preference:'Файлы'}:{category:'Package Control',policy:'Software Install',preference:'Files'};}
function policy(){return {scope:'computer',policy_id:'install',label:labels().policy,state:'enabled',comment:null,
 capabilities:{enable:true,disable:true,clear:true,inspect_parameters:true,edit_parameters:true,edit_comments:true},
 parameters:[{id:'path',label:'Path',kind:'text',editable:true,value:{kind:'text',value:'original'}}]};}
function securityResponse(){return {security_catalog:{semantic_revision:'fixture-revision',categories:[{namespace:'fixture',id:'category',display_name:'Account Policies'}],
 policies:[{namespace:'fixture',policy_id:'example',display_name:'Password setting',category:['fixture','category'],elements:[{id:'enabled',value_type:'boolean'}]}]},security_snapshot:{policies:[]}};}
function auditResponse(){return {advanced_audit:{rows:[],subcategory_catalog:[{guid:'0cce9210-69ae-11d9-bed3-505054503030',display_name:'Account Logon'}]}};}
define('util/API',[],()=>({getDisplayName:()=> 'Example GPO',
 children:async(scope,id)=>{requests.push({method:'children',id});return {children:id===null?[{kind:'category',id:'packages',label:labels().category}]:[{kind:'policy',id:'install',label:labels().policy}]};},
 policyShow:async()=>{requests.push({method:'show'});return {policy:policy()};},
 policyUpdate:async()=>{requests.push({method:'write'});throw Error('Read-only fixture');},
 policyIndex:async()=>({policies:[{id:'install',label:labels().policy,path:[labels().category]}]}),
 securityDefinitionsShow:async()=>securityResponse(),advancedAuditShow:async()=>auditResponse(),
 preferenceItems:async()=>({items:[]}),
 scriptsShow:async(scope,event)=>({scripts:{scope,event,execution_order:'unspecified',assets:[],classic:{editable:true,entries:[],snapshot:{}},powershell:{editable:true,entries:[],snapshot:{}}}})
}));
require.config({baseUrl:'/js'});
require(['app','components/tree-view/tree-view-list','components/tree-view/tree-view-list-data',
 'components/header/header','components/workspace/workspace','locales/translations'],
 (app,treeList,treeData,headerModule,workspaceModule,translationModule)=>{
 window.translations=translationModule;
 window.reset=async(language)=>{
  if(window.state)state.cleanupCurrentView();
  translations.setLanguage(language);requests=[];
  document.getElementById('header').replaceChildren();
  document.querySelector('.workspace')?.remove();
  document.getElementById('tree').replaceChildren();
  window.state=app._test.createTreeViewState();
  state.setHeader(headerModule.renderHeader(document.getElementById('header')));
  const workspace=workspaceModule.renderWorkspace();document.getElementById('main').appendChild(workspace.getElement());
  window.roots=treeData.buildTreeViewList({preference_documents:[{scope:'computer',kind:'files',label:labels().preference,category_id:'system_settings',editable:true}]});
  document.getElementById('tree').appendChild(treeList.renderTreeViewList(roots,workspace,state).getElement());
  const scope=roots[0].children[0];
  const policies=scope.children.find(node=>node.title===translations.t('policies.title'));
  const preferences=scope.children.find(node=>node.title===translations.t('preferences.title'));
  const settings=policies.children.find(node=>node.title===translations.t('policies.windowsSettings'));
  window.nodes={scope,policies,settings,preferences,preference:preferences.children[0].children[0],
   scripts:settings.children.find(node=>node.template==='scripts'),security:settings.children.find(node=>node.lazy),
   at:policies.children.find(node=>node.title===translations.t('policies.adminTemplates')),
   all:scope.children.find(node=>node.template==='all_policies')};
  state.policyChangedModal=document.getElementById('confirmation');
  document.getElementById('discard').onclick=()=>state.handlePolicyChangedNo();
  document.getElementById('save').onclick=()=>state.handlePolicyChangedYes();
  document.getElementById('stay').onclick=()=>{state.pendingNavigation=null;state.hidePolicyChangedModal();};
 };
 window.openView=async(kind)=>{
  if(kind==='folder')return state.navigateToNode(nodes.settings,{openPath:true});
  if(kind==='preferences')return state.navigateToNode(nodes.preference,{openPath:true});
  if(kind==='scripts')return state.navigateToNode(nodes.scripts,{openPath:true});
  if(kind==='all')return state.navigateToNode(nodes.all,{openPath:true});
  if(kind==='security'||kind==='audit'){
   await state.navigateToNode(nodes.security,{openPath:true});
   if(kind==='security')return state.navigateToNode(nodes.security.children.find(node=>node.template==='security'),{openPath:true});
   nodes.audit=nodes.security.children.find(node=>node.title===translations.t('security.advancedAudit.title'));
   return state.navigateToNode(nodes.audit.children[0],{openPath:true});
  }
  if(kind==='at'){
   await state.navigateToNode(nodes.at,{openPath:true});
   nodes.packages=nodes.at.children[0];
   await state.navigateToNode(nodes.packages,{openPath:true});
   nodes.policy=nodes.packages.children[0];
   return state.navigateToNode(nodes.policy,{openPath:true});
  }
 };
 reset('en').then(()=>window.ready=true);
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
        assert.equal(await page.evaluate(() => requests.some(request => request.method === 'write')), false);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

async function pathMetrics(page) {
    return page.locator('.workspace > .gpo-category-path').evaluate(element => {
        const style = getComputedStyle(element);
        const button = element.querySelector('button');
        const buttonStyle = getComputedStyle(button);
        const box = element.getBoundingClientRect();
        const workspaceBox = element.closest('.workspace').getBoundingClientRect();
        return {
            fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color,
            padding: style.padding, buttonFont: buttonStyle.font, buttonColor: buttonStyle.color,
            inset: box.left - workspaceBox.left, width: box.width - workspaceBox.width
        };
    });
}

for (const language of ['en', 'ru']) {
    test('The actual app shares a quiet clickable ' + language + ' path across every catalog and includes the AT policy leaf', browserOptions, async () => {
        await withPage(async page => {
            await page.evaluate(language => reset(language), language);
            let reference;
            for (const kind of ['folder', 'preferences', 'scripts', 'security', 'audit', 'all', 'at']) {
                await page.evaluate(kind => openView(kind), kind);
                const pathView = page.locator('.workspace > .gpo-category-path');
                await pathView.waitFor();
                assert.equal(await page.locator('.workspace [data-category-path]').count(), 1, kind + ' should have one path');
                const metrics = await pathMetrics(page);
                if (!reference) reference = metrics;
                else assert.deepEqual(metrics, reference, kind + ' should match the common heading');
                assert.equal(metrics.fontWeight, '400');
                assert.equal(await pathView.getAttribute('aria-label'), await page.evaluate(() => translations.t('navigation.path')));
                const titles = await pathView.locator('.gpo-category-path__segment').allTextContents();
                assert.deepEqual(titles, await page.evaluate(() => state.getPathToItem(state.selectedItem.item).map(node => node.title)));
                assert.equal(await pathView.locator('button[aria-current=page]').count(), 1);
                assert.equal(await page.locator('.workspace h2[data-category-path]').count(), 0);
            }
            const leaf = page.locator('.workspace > .gpo-category-path button[aria-current=page]');
            assert.equal(await leaf.textContent(), await page.evaluate(() => labels().policy));
            const modal = page.locator('.gpo-admx-dialog');
            await modal.locator('[data-field-id=path] input').waitFor();
            assert.equal(await modal.locator('.gpo-category-path, [data-category-path]').count(), 0);
            await modal.locator('.btn-cancel').click();
            await leaf.click();
            await page.locator('.gpo-admx-dialog [data-field-id=path] input').waitFor();
            assert.equal(await page.evaluate(() => state.selectedItem.item === nodes.policy), true);
        });
    });
}

test('Breadcrumb navigation uses the actual draft guard and reveals ancestors after discard', browserOptions, async () => {
    await withPage(async page => {
        await page.evaluate(() => openView('at'));
        const input = page.locator('.gpo-admx-dialog [data-field-id=path] input');
        await input.fill('unsaved draft');
        await page.evaluate(() => {
            state.getPathToItem(nodes.policy).slice(0, -1).forEach(node => state.setFolderOpened(node, false));
        });
        // A modal owns pointer interaction, but all programmatic navigation must still respect its draft.
        const parent = page.locator('.workspace > .gpo-category-path button').filter({ hasText: 'Package Control' });
        await parent.evaluate(button => button.click());
        assert.equal(await page.evaluate(() => state.pendingNavigation.item === nodes.packages && state.selectedItem.item === nodes.policy), true);
        assert.equal(await input.inputValue(), 'unsaved draft');
        assert.equal(await page.evaluate(() => state.currentView.hasUnsavedChanges()), true);
        await page.locator('#stay').click();
        assert.equal(await input.inputValue(), 'unsaved draft');
        assert.equal(await page.evaluate(() => state.pendingNavigation === null && state.selectedItem.item === nodes.policy), true);
        await parent.evaluate(button => button.click());
        await page.locator('#discard').click();
        await page.waitForFunction(() => state.selectedItem.item === nodes.packages);
        assert.equal(await page.locator('.gpo-admx-dialog').count(), 0);
        assert.deepEqual(await page.evaluate(() => state.getPathToItem(nodes.packages).slice(0, -1).map(node => node.opened)), [true, true, true, true]);
        assert.equal(await page.evaluate(() => nodes.packages.opened), false);
        assert.equal(await page.locator('.workspace > .gpo-category-path button[aria-current=page]').textContent(), 'Package Control');
    });
});

test('Catalog titles remain plaintext in clickable path labels and attributes', browserOptions, async () => {
    await withPage(async page => {
        const unsafe = '<img src=x onerror="window.titleExecuted=true"> & <b>name</b>';
        await page.evaluate(async unsafe => {
            await state.navigateToNode(nodes.at, { openPath: true });
            nodes.packages = nodes.at.children[0];
            nodes.packages.title = unsafe;
            await state.navigateToNode(nodes.packages, { openPath: true });
        }, unsafe);
        const leaf = page.locator('.workspace > .gpo-category-path button[aria-current=page]');
        assert.equal(await leaf.textContent(), unsafe);
        assert.equal(await leaf.getAttribute('title'), unsafe);
        assert.equal(await page.locator('.gpo-category-path img, .gpo-category-path b').count(), 0);
        assert.equal(await page.evaluate(() => Boolean(window.titleExecuted)), false);
        await page.locator('.gpo-category-path button').filter({ hasText: 'Administrative Templates' }).click();
        assert.equal(await page.evaluate(() => state.selectedItem.item === nodes.at), true);
    });
});
