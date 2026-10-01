'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy');
function load(file, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), {
        define: (names, factory) => { result = factory(...names.map(name => dependencies[name])); }
    });
    return result;
}
const icons = load('components/editor-icons.js');
const presentations = load('components/templates/preference/targeting-presentations.js');
const translations = { t: key => key, getLanguage: () => 'en' };
const tree = load('components/tree-view/tree-view-list-data.js', {
    '../../locales/translations': translations, '../../util/API': { getDisplayName: () => 'Example GPO' },
    '../templates/security/model': {}, '../templates/advanced-audit/model': {}, '../editor-icons': icons
});
const model = load('components/templates/all-policies/model.js', {
    '../../../locales/translations': translations, '../security/model': {},
    '../advanced-audit/model': {}, '../../editor-icons': icons
});
const preferenceKinds = ['applications', 'control_panel', 'data_sources', 'devices', 'drives',
    'environment_variables', 'files', 'folder_options', 'folders', 'ini_files', 'internet_settings',
    'local_users_and_groups', 'network_options', 'network_shares', 'power_options', 'printers',
    'regional_options', 'registry', 'scheduled_tasks', 'services', 'shortcuts', 'start_menu'];
const categories = ['system_settings', 'control_panel_settings', 'other_settings'];
const css = fs.readFileSync(path.join(root, 'css/icons.css'), 'utf8');
function asset(className) {
    assert.match(className, /^gpo-icon gpo-icon-[a-z-]+$/);
    const name = className.split('gpo-icon-')[1];
    const rule = new RegExp('\\.gpo-icon\\.gpo-icon-' + name + ' \\{ background-image: url\\(([^)]+)\\); \\}');
    const match = css.match(rule);
    assert.ok(match, 'Missing stylesheet mapping: ' + name);
    const filename = path.resolve(root, 'css', match[1]);
    assert.equal(path.dirname(filename), path.join(root, 'img/svg/ico'));
    assert.ok(fs.existsSync(filename), 'Missing icon: ' + filename);
    return fs.readFileSync(filename, 'utf8');
}

test('all 22 native preference families and all 29 targeting kinds have explicit semantic icons', () => {
    assert.deepEqual([...icons.preferenceKinds].sort(), preferenceKinds.slice().sort());
    assert.deepEqual([...icons.targetingKinds].sort(), [...presentations.supportedKinds].sort());
    assert.equal(new Set(preferenceKinds.map(icons.preference)).size, 22);
    assert.equal(new Set([...icons.targetingKinds].map(icons.targeting)).size, 29);
    assert.ok(Object.isFrozen(icons) && Object.isFrozen(icons.preferenceKinds) && Object.isFrozen(icons.targetingKinds));
});

test('mapped assets are self-contained 16px SVGs in the established grey palette', () => {
    const classes = preferenceKinds.map(icons.preference).concat([...icons.targetingKinds].map(icons.targeting),
        categories.map(icons.preferenceCategory), icons.preferencesRoot(), icons.scripts(),
        ['startup', 'shutdown', 'logon', 'logoff'].map(icons.scriptEvent),
        ['classic', 'powershell'].map(icons.scriptFile), icons.targeting(null));
    for (const className of new Set(classes)) {
        const svg = asset(className);
        assert.match(svg, /width="16" height="16" viewBox="0 0 16 16"/);
        assert.match(svg, /#6C757D/);
        assert.doesNotMatch(svg, /<script|<foreignObject|<image|<text|href=|onload=/i);
        const colors = svg.match(/#[0-9a-f]{3,8}\b/gi) || [];
        assert.ok(colors.every(color => color.toLowerCase() === '#6c757d'), className);
    }
});

test('tree roots, actual preference families and Scripts share the centralized mapping', () => {
    const documents = preferenceKinds.map((kind, index) => ({ scope: 'computer', kind, label: kind,
        editable: true, category_id: categories[index % categories.length] }));
    const scope = tree.buildTreeViewList({ preference_documents: documents })[0].children[0];
    const preferences = scope.children.find(node => node.title === 'preferences.title');
    assert.equal(preferences.icon, icons.preferencesRoot());
    assert.equal(preferences.children.length, 3);
    for (const category of preferences.children) {
        assert.equal(category.icon, icons.preferenceCategory(category.preferenceCategoryId));
        for (const node of category.children) assert.equal(node.icon, icons.preference(node.preferenceKind));
    }
    const scripts = scope.children.find(node => node.title === 'policies.title').children[0].children[0];
    assert.equal(scripts.template, 'scripts');
    assert.equal(scripts.type, 'file');
    assert.equal(scripts.icon, icons.scripts());
});

test('All Policies preference and script event projections use the same icons in both scopes', () => {
    for (const scope of ['computer', 'user']) {
        const documents = preferenceKinds.map(kind => ({ scope, kind, label: kind, editable: true }));
        for (const row of model.preferenceRows(documents, scope)) {
            assert.equal(row.target.icon, icons.preference(row.target.preferenceKind));
        }
        for (const row of model.scriptRows(scope)) assert.equal(row.target.icon, icons.scriptEvent(row.target.scriptEvent));
    }
});

test('unknown future/vendor kinds fall back without inheriting object prototype names', () => {
    for (const value of [null, '', 'vendor_new', '__proto__', 'toString', 'constructor']) {
        assert.equal(icons.preference(value), icons.preferencesRoot());
        assert.equal(icons.targeting(value), icons.targeting(null));
        assert.equal(icons.preferenceCategory(value), icons.preferenceCategory('other_settings'));
        assert.equal(icons.scriptEvent(value), icons.scripts());
        asset(icons.targeting(value));
    }
});
