'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');
function load(file, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
        define: (names, factory) => { result = factory(...names.map(name => dependencies[name])); }
    });
    return result;
}
const locales = { en: load('locales/en.js'), ru: load('locales/ru.js') };
const translations = load('locales/translations.js', { './en': locales.en, './ru': locales.ru });
const model = load('components/templates/advanced-audit/model.js', { '../../../locales/translations': translations });
const plain = value => JSON.parse(JSON.stringify(value));
const guid = number => '0cce' + number.toString(16) + '-69ae-11d9-bed3-505054503030';
const catalog = Array.from({ length: 58 }, (_, index) => ({
    guid: '{' + guid(0x9210 + index).toUpperCase() + '}', display_name: 'Server label ' + index
}));

test('all 58 audit subcategories have EN/RU labels in unconfigured and configured rows', () => {
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        const names = locales[language].security.advancedAudit.subcategories;
        assert.equal(Object.keys(names).length, 58);
        const response = { advanced_audit: { rows: [], subcategory_catalog: catalog } };
        const emptyRows = model.familyById(response, 'system_audit_policies').rows;
        assert.equal(emptyRows.length, 58);
        for (let index = 0; index < 58; index++) {
            assert.equal(emptyRows[index].display_name, names[guid(0x9210 + index)]);
            assert.equal(emptyRows[index].guid, catalog[index].guid);
            if (language === 'ru' && index !== 0x9220 - 0x9210) assert.match(emptyRows[index].display_name, /[А-Яа-я]/);
        }
        response.advanced_audit.rows = catalog.map((entry, index) => ({
            kind: 'subcategory', guid: guid(0x9210 + index), display_name: entry.display_name,
            machine_name: 'SOURCE-NAME-' + index, target: { kind: 'system' },
            setting: { kind: 'system', value: 'success' }, editable: true
        }));
        response.advanced_audit.rows.push({
            kind: 'subcategory', guid: catalog[0].guid, display_name: 'User source name',
            machine_name: 'USER-SOURCE', target: { kind: 'user', sid: 'S-1-5-21-123' },
            setting: { kind: 'user', include_success: true }, editable: true
        });
        const before = plain(response);
        const configuredRows = model.familyById(response, 'system_audit_policies').rows;
        assert.equal(configuredRows.length, 59, 'brace/case differences must not add duplicate system policies');
        for (let index = 0; index < configuredRows.length; index++) {
            const row = configuredRows[index];
            const original = response.advanced_audit.rows[index];
            assert.equal(row.display_name, names[original.guid.replace(/[{}]/g, '').toLowerCase()]);
            assert.notEqual(row, original);
            assert.deepEqual(plain({ ...row, display_name: original.display_name }), plain(original));
        }
        assert.deepEqual(response, before, 'UI localization must not mutate backend DTOs');
    }
});

test('all four configured audit options are localized without changing identities or machine metadata', () => {
    const ids = ['crash_on_audit_fail', 'full_privilege_auditing', 'audit_base_objects', 'audit_base_directories'];
    const rows = ids.map(option => ({ kind: 'option', option, machine_name: 'ORIGINAL-SOURCE', display_name: 'English source label', enabled: true }));
    const response = { advanced_audit: { rows, subcategory_catalog: [] } };
    const before = plain(response);
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        for (const [index, row] of model.familyById(response, 'audit_options').rows.entries()) {
            assert.equal(row.display_name, locales[language].security.advancedAudit[ids[index]]);
            assert.equal(row.option, ids[index]);
            assert.equal(row.machine_name, 'ORIGINAL-SOURCE');
            assert.equal(row.enabled, true);
        }
    }
    assert.deepEqual(response, before);
});

test('unknown audit GUIDs and options retain their source labels', () => {
    translations.setLanguage('ru');
    const response = { advanced_audit: { rows: [
        { kind: 'subcategory', guid: '{11119210-69AE-11D9-BED3-505054503030}', display_name: 'Vendor subcategory', target: { kind: 'system' } },
        { kind: 'option', option: 'vendor_option', display_name: 'Vendor option', machine_name: 'SOURCE' }
    ], subcategory_catalog: [] } };
    assert.equal(model.familyById(response, 'system_audit_policies').rows[0].display_name, 'Vendor subcategory');
    assert.equal(model.familyById(response, 'audit_options').rows[0].display_name, 'Vendor option');
});

test('all 58 localized GUIDs match the installed native audit catalog', { skip: !fs.existsSync('/usr/share/xml/sdmx/1.0/sdmx-1.0.xsd') }, () => {
    const nativeCatalog = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', [
        'import json,tempfile,pathlib',
        'from admix import Workspace',
        'with tempfile.TemporaryDirectory() as directory:',
        ' p=pathlib.Path(directory); (p/"gpo").mkdir()',
        ' w=Workspace.open(p/"gpo",load_preferences=False,state_directory=p/"state",state_key="audit-locales-test")',
        ' print(json.dumps(w.security.advanced_audit()["subcategory_catalog"]))'
    ].join('\n')], { encoding: 'utf8' }));
    assert.equal(nativeCatalog.length, 58);
    for (const entry of nativeCatalog) {
        const key = entry.guid.replace(/[{}]/g, '').toLowerCase();
        assert.equal(locales.en.security.advancedAudit.subcategories[key], entry.display_name);
        assert.equal(typeof locales.ru.security.advancedAudit.subcategories[key], 'string');
    }
});
