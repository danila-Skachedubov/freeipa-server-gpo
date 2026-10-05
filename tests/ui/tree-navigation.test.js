'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js/components/tree-view/tree-view-list-data.js');
let editorIcons;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,
    '../../plugin/ui/grouppolicy/js/components/editor-icons.js'), 'utf8'), {
    define: (_dependencies, factory) => { editorIcons = factory(); }
});

function locale(language) {
    let messages;
    const filename = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js/locales', language + '.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        define: (_dependencies, factory) => { messages = factory(); }
    });
    return messages;
}

function treeModule(options = {}) {
    let tree;
    const translations = options.translations || { t: key => key };
    if (options.language) translations.getLanguage = () => options.language;
    vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
        define: (names, factory) => {
            tree = factory(...names.map(name => ({
                '../../locales/translations': translations,
                '../../util/API': { getDisplayName: () => 'Example GPO', ...options.api },
                '../templates/security/model': options.securityModel || {},
                '../templates/advanced-audit/model': options.auditModel || {},
                '../editor-icons': editorIcons
            })[name]));
        },
        Map, Promise
    });
    return tree;
}

function preference(scope, kind, categoryId, categoryOrder, displayOrder, label) {
    return {
        scope, kind, label, editable: kind !== 'control_panel',
        category_id: categoryId, category_label: categoryId,
        category_order: categoryOrder, display_order: displayOrder
    };
}

function childByTitle(parent, title) {
    const child = (parent.children || []).find(node => node.title === title);
    assert.ok(child, `Missing navigation branch: ${title}`);
    return child;
}

function scopeByName(root, scope) {
    return childByTitle(root, scope === 'computer' ? 'policies.machine' : 'policies.user');
}

function policyBranch(scopeRoot) {
    return childByTitle(scopeRoot, 'policies.title');
}

function windowsSettings(scopeRoot) {
    return childByTitle(policyBranch(scopeRoot), 'policies.windowsSettings');
}

function administrativeTemplates(scopeRoot) {
    return childByTitle(policyBranch(scopeRoot), 'policies.adminTemplates');
}

test('tree headings keep the requested scope and neutral category names in both languages', () => {
    for (const [language, expected] of Object.entries({
        en: ['Computer', 'User', 'System Settings', 'Component Settings'],
        ru: ['Компьютер', 'Пользователь', 'Конфигурация системы', 'Параметры компонентов']
    })) {
        const messages = locale(language);
        assert.deepEqual([
            messages.policies.machine,
            messages.policies.user,
            messages.policies.windowsSettings,
            messages.preferences.controlPanelSettings
        ], expected);
        assert.equal(messages.preferences.windowsSettings, messages.policies.windowsSettings);
    }
});

test('Policies and Preferences keep their editors under the correct scope and category', () => {
    const future = preference('computer', 'future_kind', 'future_category', 15, 1, 'Future');
    future.category_label = 'Future settings';
    const tree = treeModule().buildTreeViewList({ preference_documents: [
        preference('computer', 'registry', 'system_settings', 10, 60, 'Registry'),
        preference('computer', 'control_panel', 'control_panel_settings', 20, 0, 'Control Panel'),
        preference('computer', 'files', 'system_settings', 10, 30, 'Files'),
        future,
        preference('user', 'files', 'system_settings', 10, 30, 'Files')
    ] })[0];

    const computer = scopeByName(tree, 'computer');
    const user = scopeByName(tree, 'user');
    assert.deepEqual([...computer.children.map(node => node.title)], [
        'policies.allPolicies', 'policies.title', 'preferences.title'
    ]);
    assert.deepEqual([...user.children.map(node => node.title)], [
        'policies.allPolicies', 'policies.title', 'preferences.title'
    ]);
    for (const [scope, branch] of [['computer', computer], ['user', user]]) {
        const all = childByTitle(branch, 'policies.allPolicies');
        assert.equal(all.template, 'all_policies');
        assert.equal(all.scope, scope);
        assert.equal(all.type, 'folder');
        assert.deepEqual([...all.children], []);
        assert.equal(all.includePreferences, true);
        assert.ok(all.preferenceDocuments.every(document => document.scope === scope));
    }

    const computerPolicies = policyBranch(computer);
    assert.deepEqual([...computerPolicies.children.map(node => node.title)], [
        'policies.windowsSettings', 'policies.adminTemplates'
    ]);
    assert.deepEqual([...windowsSettings(computer).children.map(node => node.title)], [
        'policies.scriptsComputer', 'security.title'
    ]);
    const computerScripts = windowsSettings(computer).children.find(node => node.template === 'scripts');
    assert.equal(computerScripts.type, 'file');
    assert.equal(computerScripts.icon, editorIcons.scripts());
    assert.equal(computerScripts.template, 'scripts');
    assert.equal(computerScripts.scope, 'computer');
    assert.equal(computerScripts.children, undefined);
    assert.deepEqual([...windowsSettings(user).children.map(node => node.title)], [
        'policies.scriptsUser'
    ]);
    const userScripts = windowsSettings(user).children.find(node => node.template === 'scripts');
    assert.equal(userScripts.type, 'file');
    assert.equal(userScripts.icon, editorIcons.scripts());
    assert.equal(userScripts.template, 'scripts');
    assert.equal(userScripts.scope, 'user');
    assert.equal(userScripts.children, undefined);

    const categories = childByTitle(computer, 'preferences.title').children;
    assert.deepEqual([...categories.map(node => node.title)], [
        'preferences.windowsSettings', 'Future settings', 'preferences.controlPanelSettings'
    ]);
    assert.deepEqual([...categories[0].children.map(node => node.preferenceKind)], ['files', 'registry']);
    assert.equal(categories[0].children[0].template, 'preferences');
    assert.equal(categories[2].children[0].preferenceKind, 'control_panel');
    assert.equal(categories[2].children[0].readOnly, true);
    assert.deepEqual([...childByTitle(user, 'preferences.title').children[0].children.map(node => node.preferenceKind)], ['files']);
});

test('legacy preference documents without category metadata stay visible', () => {
    const root = treeModule().buildTreeViewList({ preference_documents: [
        { scope: 'computer', kind: 'files', label: 'Files', editable: true }
    ] })[0];
    const computer = scopeByName(root, 'computer');
    const category = childByTitle(computer, 'preferences.title').children[0];
    assert.equal(category.title, 'preferences.otherSettings');
    assert.equal(category.children[0].preferenceKind, 'files');
});

test('empty unsupported branches are not presented as available editors', () => {
    const root = treeModule().buildTreeViewList({})[0];
    assert.deepEqual([...scopeByName(root, 'computer').children.map(node => node.title)], [
        'policies.allPolicies', 'policies.title'
    ]);
    assert.deepEqual([...scopeByName(root, 'user').children.map(node => node.title)], [
        'policies.allPolicies', 'policies.title'
    ]);
    assert.equal(policyBranch(scopeByName(root, 'computer')).children.some(node => node.title === 'policies.softwareSettings'), false);
});

for (const language of ['en', 'ru']) {
    for (const scope of ['computer', 'user']) {
        test(`Administrative Templates retains hidden policies and sorts root and nested lists in ${language} for ${scope}`, async () => {
            const labels = language === 'en'
                ? ['alpha', 'Éclair', 'Zulu', 'Яблоко']
                : ['Альфа', 'Ёж', 'Яблоко', 'Apple'];
            function children(parent) {
                return [2, 0, 3, 1].flatMap(index => [
                    { kind: 'policy', id: `${scope}:${parent}:policy-${index}`, label: labels[index] + ' policy' },
                    { kind: 'category', id: `${scope}:${parent}:category-${index}`, label: labels[index] + ' category' }
                ]);
            }
            const rootDtos = children('root');
            const nestedDtos = children('nested');
            const calls = [];
            const tree = treeModule({ language, api: {
                children: async (requestedScope, categoryId) => {
                    calls.push([requestedScope, categoryId]);
                    const result = categoryId === null ? rootDtos : nestedDtos;
                    // Both documented response shapes work at either depth.
                    return (scope === 'computer') === (categoryId === null)
                        ? result : { children: result };
                }
            } });
            const scopeRoot = scopeByName(tree.buildTreeViewList({})[0], scope);
            const templates = administrativeTemplates(scopeRoot);
            const rootChildren = await templates.loadChildren();
            const category = rootChildren.find(node => node.categoryId === `${scope}:root:category-0`);
            const nestedChildren = await category.loadChildren();

            assert.deepEqual(calls, [[scope, null], [scope, category.categoryId]]);
            for (const [parent, dtos, nodes] of [['root', rootDtos, rootChildren], ['nested', nestedDtos, nestedChildren]]) {
                assert.equal(nodes.length, dtos.length);
                assert.deepEqual([...nodes.map(node => node.title)], [
                    ...labels.map(label => label + ' category'),
                    ...labels.map(label => label + ' policy')
                ]);
                assert.deepEqual([...nodes.map(node => node.categoryId || node.policyId)].sort(), dtos.map(node => node.id).sort());
                for (const node of nodes) {
                    assert.equal(node.scope, scope);
                    if (node.type === 'folder') {
                        assert.notEqual(node.showInTree, false);
                        assert.equal(node.lazy, true);
                        assert.ok(node.categoryId.startsWith(`${scope}:${parent}:category-`));
                    } else {
                        assert.equal(node.type, 'file');
                        assert.equal(node.template, 'admx');
                        assert.equal(node.icon, 'ico-file');
                        assert.equal(node.showInTree, false);
                        assert.ok(node.policyId.startsWith(`${scope}:${parent}:policy-`));
                    }
                }
            }
            assert.deepEqual(rootDtos.map(node => node.id), children('root').map(node => node.id));
            assert.deepEqual(nestedDtos.map(node => node.id), children('nested').map(node => node.id));
        });
    }
}

test('Administrative Templates falls back to IDs and supports translation mocks without a language getter', async () => {
    const tree = treeModule({ api: { children: async () => ({ children: [
        { kind: 'policy', id: 'Zulu policy' },
        { kind: 'category', id: 'Zulu category' },
        { kind: 'policy', id: 'Alpha policy', label: '' },
        { kind: 'category', id: 'Alpha category', label: '' }
    ] }) } });
    const templates = administrativeTemplates(scopeByName(tree.buildTreeViewList({})[0], 'computer'));
    const nodes = await templates.loadChildren();
    assert.deepEqual([...nodes.map(node => node.title)], ['Alpha category', 'Zulu category', 'Alpha policy', 'Zulu policy']);
    assert.ok(nodes.filter(node => node.type === 'file').every(node => node.showInTree === false));
});

test('Administrative Templates ordering and visibility do not change Preferences, Scripts, or Security navigation rules', async () => {
    const securityPolicy = { title: 'Scalar policy', type: 'file', template: 'security', showInTree: false };
    const collection = { title: 'Alpha collection', type: 'file', template: 'security', securityCollection: 'entries' };
    const category = { title: 'Zulu category', type: 'folder', template: 'security', children: [securityPolicy] };
    const tree = treeModule({ language: 'ru',
        api: { securityDefinitionsShow: async () => ({}), advancedAuditShow: async () => ({}) },
        securityModel: { navigationNodes: () => [category, collection] },
        auditModel: { navigationNode: () => ({ title: 'Middle audit', type: 'folder', template: 'advanced_audit' }) }
    }).buildTreeViewList({ preference_documents: [
        preference('computer', 'registry', 'earlier', 1, 20, 'Alpha registry'),
        preference('computer', 'files', 'earlier', 1, 10, 'Zulu files'),
        preference('computer', 'services', 'later', 2, 1, 'Alpha services')
    ].map(document => ({ ...document, category_label: document.category_id === 'earlier' ? 'Zulu settings' : 'Alpha settings' })) })[0];
    const computer = scopeByName(tree, 'computer');
    const categories = childByTitle(computer, 'preferences.title').children;
    assert.deepEqual([...categories.map(node => node.title)], ['Zulu settings', 'Alpha settings']);
    assert.deepEqual([...categories[0].children.map(node => node.title)], ['Zulu files', 'Alpha registry']);
    assert.ok(categories.flatMap(node => node.children).every(node => node.showInTree !== false));
    for (const scopeRoot of tree.children) {
        const scripts = windowsSettings(scopeRoot).children.find(node => node.template === 'scripts');
        assert.equal(scripts.type, 'file');
        assert.equal(scripts.template, 'scripts');
        assert.notEqual(scripts.showInTree, false);
    }
    const security = childByTitle(windowsSettings(computer), 'security.title');
    const securityNodes = await security.loadChildren();
    assert.deepEqual([...securityNodes.map(node => node.title)], ['Alpha collection', 'Middle audit', 'Zulu category']);
    assert.strictEqual(securityNodes[0], collection);
    assert.notEqual(collection.showInTree, false);
    assert.strictEqual(securityNodes[2].children[0], securityPolicy);
});
