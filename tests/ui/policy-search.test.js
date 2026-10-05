'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');
function load(filename, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, filename), 'utf8'), {
        define: (names, factory) => { result = factory(...names.map(name => dependencies[name])); }
    });
    return result;
}
const locales = { en: load('locales/en.js'), ru: load('locales/ru.js') };
const translations = load('locales/translations.js', { './en': locales.en, './ru': locales.ru });
const security = load('components/templates/security/model.js', { '../../../locales/translations': translations });
const audit = load('components/templates/advanced-audit/model.js', { '../../../locales/translations': translations });
const editorIcons = load('components/editor-icons.js');
const model = load('components/templates/all-policies/model.js', {
    '../../../locales/translations': translations, '../security/model': security, '../advanced-audit/model': audit,
    '../../editor-icons': editorIcons
});
const plain = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

test('AT index rows include every deep and unconfigured policy in both scopes without mutating the catalog', () => {
    translations.setLanguage('en');
    const result = freeze({ policies: Array.from({ length: 2001 }, (_, index) => ({
        id: 'urn:example:policy/' + index,
        label: index === 2000 ? 'Unconfigured deep policy' : 'Duplicate name',
        path: ['Root category', 'Nested category ' + index], state: 'not_configured'
    })) });
    const before = plain(result);
    const byScope = {};
    for (const scope of ['computer', 'user']) {
        const rows = model.admxRows(result, scope);
        byScope[scope] = rows;
        assert.equal(rows.length, 2001);
        assert.equal(new Set(rows.map(row => row.id)).size, 2001);
        assert.equal(rows[2000].title, 'Unconfigured deep policy');
        assert.deepEqual(plain(rows[2000].path), ['Administrative Templates', 'Root category', 'Nested category 2000']);
        assert.deepEqual([...rows.map(row => row.target.policyId)], result.policies.map(policy => policy.id));
        assert.ok(rows.every(row => row.target.scope === scope && row.target.type === 'file'
            && row.target.template === 'admx' && row.target.showInTree === false));
        assert.equal(model.matches(rows[2000], 'NESTED CATEGORY 2000'), true);
        assert.equal(model.matches(rows[2000], 'UNCONFIGURED DEEP'), true);
        assert.notEqual(rows[0].target, result.policies[0]);
        assert.notEqual(rows[0].path, result.policies[0].path);
        assert.notEqual(rows[0].target, model.admxRows(result, scope)[0].target);
    }
    assert.notEqual(byScope.computer[0].id, byScope.user[0].id);
    assert.deepEqual(result, before);
});

test('Security index includes qualified duplicates, collections, orphan policies and category ancestry only for Computer', () => {
    translations.setLanguage('en');
    const element = { id: 'enabled', value_type: 'boolean' };
    const collection = { id: 'entries', value_type: 'collection', fields: [], unique_by: 'key' };
    const response = freeze({ security_catalog: { categories: [
        { namespace: 'ns:first', id: 'root', display_name: 'Root category' },
        { namespace: 'ns:first', id: 'child', display_name: 'Nested category', parent: ['ns:first', 'root'] },
        { namespace: 'ns:second', id: 'root', display_name: 'Second root' }
    ], policies: [
        { namespace: 'ns:first', policy_id: 'duplicate', display_name: 'Shared policy', category: ['ns:first', 'child'], elements: [element] },
        { namespace: 'ns:second', policy_id: 'duplicate', display_name: 'Shared policy', category: ['ns:second', 'root'], elements: [element] },
        { namespace: 'ns:first', policy_id: 'collection', display_name: 'Collection policy', category: ['ns:first', 'root'], elements: [collection] },
        { namespace: 'ns:first', policy_id: 'mixed', display_name: 'Mixed settings', category: ['ns:first', 'root'], elements: [collection, element] },
        { namespace: 'ns:first', policy_id: 'orphan', display_name: 'Orphan policy', category: ['missing', 'category'], elements: [] }
    ] }, security_snapshot: { policies: [] } });
    const before = plain(response);
    const rows = model.securityRows(response, 'computer');
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map(row => row.id)).size, 5);
    const duplicates = rows.filter(row => row.title === 'Shared policy');
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].id, duplicates[1].id);
    assert.deepEqual(plain(duplicates[0].path), [locales.en.security.title, 'Root category', 'Nested category']);
    assert.deepEqual(plain(duplicates[1].path), [locales.en.security.title, 'Second root']);
    const collectionRow = rows.find(row => row.target.securityPolicy.policy_id === 'collection');
    assert.equal(collectionRow.target.securityCollection, 'entries');
    assert.equal(collectionRow.target.openPolicyDialog, false);
    const mixed = rows.find(row => row.target.securityPolicy.policy_id === 'mixed');
    assert.equal(mixed.target.securityCollection, undefined);
    assert.equal(mixed.target.openPolicyDialog, true);
    const orphan = rows.find(row => row.target.securityPolicy.policy_id === 'orphan');
    assert.deepEqual(plain(orphan.path), [locales.en.security.title]);
    assert.ok(rows.every(row => row.target.template === 'security' && row.target.scope === 'computer'
        && row.target.type === 'file' && row.target.showInTree === false && !('securityModel' in row.target)));
    assert.deepEqual(plain(model.securityRows(response, 'user')), []);
    assert.deepEqual(response, before);
});

test('Security path projection terminates for cyclic categories and still includes their policy', () => {
    const response = { security_catalog: { categories: [
        { namespace: 'ns', id: 'a', display_name: 'A', parent: ['ns', 'b'] },
        { namespace: 'ns', id: 'b', display_name: 'B', parent: ['ns', 'a'] }
    ], policies: [{ namespace: 'ns', policy_id: 'cycle', display_name: 'Cycle policy', category: ['ns', 'a'], elements: [] }] } };
    const rows = model.securityRows(response, 'computer');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target.securityPolicy.policy_id, 'cycle');
    assert.equal(rows[0].path.length, 3);
});

test('Advanced Audit rows include all configured, unconfigured and preserved families with stable editor identities in EN/RU', () => {
    const firstGuid = '0cce9210-69ae-11d9-bed3-505054503030';
    const secondGuid = '0cce9211-69ae-11d9-bed3-505054503030';
    const response = freeze({ advanced_audit: { rows: [
        { kind: 'subcategory', guid: '{' + firstGuid.toUpperCase() + '}', target: { kind: 'system' }, display_name: 'Source name', editable: true, setting: { kind: 'system', value: 'success' } },
        { kind: 'subcategory', guid: firstGuid, target: { kind: 'user', sid: 'S-1-5-21-123' }, display_name: 'User source name', editable: true, setting: { kind: 'user', include_success: true } },
        { kind: 'option', option: 'vendor_option', display_name: 'Vendor option', editable: false, enabled: true },
        { kind: 'global_sacl', object_kind: 'file', sddl: 'S:(AU;SA;FA;;;WD)', editable: true },
        { kind: 'preserved', fields: ['opaque', 'source', 'row'] },
        { kind: 'preserved', fields: ['opaque', 'source', 'row'] }
    ], subcategory_catalog: [
        { guid: firstGuid, display_name: 'First source category' },
        { guid: secondGuid, display_name: 'Second source category' }
    ] } });
    const before = plain(response);
    let firstIds;
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        const rows = model.auditRows(response, 'computer');
        assert.equal(rows.length, 12, 'three subcategories, five options, two SACLs and two preserved rows');
        assert.equal(new Set(rows.map(row => row.id)).size, 12);
        const ids = [...rows.map(row => row.id)].sort();
        if (firstIds) assert.deepEqual(ids, firstIds);
        firstIds = ids;
        const subcategories = rows.filter(row => row.target.advancedAuditFamilyId === 'system_audit_policies');
        assert.equal(subcategories.length, 3);
        assert.equal(subcategories[0].title, locales[language].security.advancedAudit.subcategories[firstGuid]);
        assert.equal(subcategories[2].title, locales[language].security.advancedAudit.subcategories[secondGuid]);
        assert.notEqual(subcategories[0].id, subcategories[1].id);
        assert.equal(subcategories[1].path.at(-1), 'S-1-5-21-123');
        const preserved = rows.filter(row => row.target.advancedAuditFamilyId === 'preserved_advanced_audit');
        assert.equal(preserved.length, 2);
        assert.ok(preserved.every(row => row.target.readOnly));
        assert.deepEqual([...preserved.map(row => row.target.advancedAuditOccurrence)], [0, 1]);
        assert.equal(rows.find(row => row.title === 'Vendor option').target.readOnly, true);
        assert.ok(rows.every(row => row.target.template === 'advanced_audit' && row.target.scope === 'computer'
            && row.target.showInTree === false && row.target.openPolicyDialog
            && !('advancedAuditResponse' in row.target)));
    }
    assert.equal(model.auditIdentity(response.advanced_audit.rows[0]), model.auditIdentity({
        kind: 'subcategory', guid: firstGuid, target: { kind: 'system' }
    }));
    assert.notEqual(model.auditIdentity(response.advanced_audit.rows[0]), model.auditIdentity(response.advanced_audit.rows[1]));
    assert.deepEqual(plain(model.auditRows(response, 'user')), []);
    assert.deepEqual(response, before);
});

test('Scripts index has exactly the applicable events per scope and reuses localized event labels', () => {
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        for (const [scope, events, keys] of [
            ['computer', ['startup', 'shutdown'], ['startupScripts', 'shutdownScripts']],
            ['user', ['logon', 'logoff'], ['logonScript', 'logoffScript']]
        ]) {
            const rows = model.scriptRows(scope);
            assert.deepEqual([...rows.map(row => row.target.scriptEvent)], events);
            assert.deepEqual([...rows.map(row => row.title)], keys.map(key => locales[language].systemSettings[key]));
            assert.ok(rows.every(row => row.target.template === 'scripts' && row.target.scope === scope
                && row.target.showInTree === false && row.target.openPolicyDialog));
        }
    }
    assert.deepEqual(plain(model.scriptRows('unknown')), []);
    assert.notEqual(model.scriptRows('computer')[0].id, model.scriptRows('user')[0].id);
});

test('Optional Preferences rows retain scoped document identities, category labels and read-only metadata without sharing mutable DTOs', () => {
    const documents = freeze([
        { scope: 'computer', kind: 'registry', label: 'Registry', category_id: 'system_settings', editable: true, items: [{ id: 'one' }] },
        { scope: 'computer', kind: 'future', label: 'Future settings', category_id: 'vendor', category_label: 'Vendor category', editable: true, applicable: false },
        { scope: 'user', kind: 'files', label: 'Files', category_id: 'control_panel_settings', editable: false }
    ]);
    const before = plain(documents);
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        const computer = model.preferenceRows(documents, 'computer');
        const user = model.preferenceRows(documents, 'user');
        assert.equal(computer.length, 2);
        assert.equal(user.length, 1);
        assert.deepEqual(plain(computer[0].path), [locales[language].preferences.title, locales[language].preferences.windowsSettings]);
        assert.equal(computer[1].path[1], 'Vendor category');
        assert.equal(user[0].path[1], locales[language].preferences.controlPanelSettings);
        assert.equal(computer[0].target.readOnly, false);
        assert.equal(computer[1].target.readOnly, true);
        assert.equal(user[0].target.readOnly, true);
        assert.equal(computer[0].target.preferenceKind, 'registry');
        assert.equal(computer[0].target.showInTree, false);
        assert.notEqual(computer[0].target.document, documents[0]);
        assert.deepEqual(plain(computer[0].target.document), documents[0]);
    }
    assert.deepEqual(documents, before);
});

test('Search matches normalized displayed names and paths case-insensitively in both languages and clearing restores every row', () => {
    const rows = freeze([
        { id: 'en', title: 'Éclair policy', path: ['Administrative Templates', 'Deep category'] },
        { id: 'ru', title: 'Политика параметров', path: ['Административные шаблоны', 'Расширенные параметры'] }
    ]);
    const before = plain(rows);
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        assert.equal(model.matches(rows[0], '  E\u0301CLAIR  '), true);
        assert.equal(model.matches(rows[0], 'DEEP CATEGORY'), true);
        assert.equal(model.matches(rows[1], 'ПОЛИТИКА'), true);
        assert.equal(model.matches(rows[1], 'РАСШИРЕННЫЕ ПАРАМЕТРЫ'), true);
        assert.equal(model.matches(rows[1], 'missing'), false);
        assert.equal(rows.filter(row => model.matches(row, '  ')).length, 2);
    }
    assert.deepEqual(rows, before);
});

test('Search sorting copies the source and uses UI locale with path and identity tie-breakers', () => {
    translations.setLanguage('en');
    const rows = freeze([
        { id: 'z', title: 'Zulu', path: [] },
        { id: 'b', title: 'Alpha', path: ['Beta'] },
        { id: 'a2', title: 'Alpha', path: ['Alpha'] },
        { id: 'e', title: 'Éclair', path: [] },
        { id: 'a1', title: 'Alpha', path: ['Alpha'] }
    ]);
    const before = plain(rows);
    const sorted = model.sortRows(rows);
    assert.notEqual(sorted, rows);
    assert.deepEqual([...sorted.map(row => row.id)], ['a1', 'a2', 'b', 'e', 'z']);
    assert.strictEqual(sorted[0], rows[4]);
    assert.deepEqual(rows, before);
    const mixed = [
        { id: '1', title: 'Zulu' }, { id: '2', title: 'Яблоко' },
        { id: '3', title: 'Apple' }, { id: '4', title: 'Альфа' }
    ];
    assert.deepEqual([...model.sortRows(mixed).map(row => row.title)], ['Apple', 'Zulu', 'Альфа', 'Яблоко']);
    translations.setLanguage('ru');
    assert.deepEqual([...model.sortRows(mixed).map(row => row.title)], ['Альфа', 'Яблоко', 'Apple', 'Zulu']);
});

test('Malformed source payloads are errors rather than empty successful indexes', () => {
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        const message = locales[language].policySearch.invalidIndex;
        assert.throws(() => model.admxRows({}, 'computer'), error => error.message === message);
        assert.throws(() => model.securityRows({ security_catalog: { categories: [] } }, 'computer'),
            error => error.message === message);
        assert.throws(() => model.auditRows({ advanced_audit: { rows: [] } }, 'computer'),
            error => error.message === message);
    }
    assert.deepEqual(plain(model.admxRows({ policies: [] }, 'computer')), []);
    assert.deepEqual(plain(model.securityRows({ security_catalog: { categories: [], policies: [] } }, 'computer')), []);
    const emptyAudit = model.auditRows({ advanced_audit: { rows: [], subcategory_catalog: [] } }, 'computer');
    assert.equal(emptyAudit.length, 6, 'two global SACLs and four supported audit options are always available');
});
