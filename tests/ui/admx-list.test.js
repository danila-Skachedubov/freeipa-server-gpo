'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');
function load(file, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
        define: (names, factory) => {
            result = factory(...names.map(name => dependencies[name]));
        }
    });
    return result;
}

const dto = load('util/editor-dto.js', { './collection-value': load('util/collection-value.js') });
const en = load('locales/en.js');
const ru = load('locales/ru.js');
const translations = load('locales/translations.js', { './en': en, './ru': ru });
const status = load('components/editor-status.js', {
    '../util/element-creator': { createElement: (tag, options) => ({ tag, ...options }) },
    '../util/editor-dto': dto,
    '../locales/translations': translations
});

function policy(state, values) {
    return {
        state,
        capabilities: { enable: true, disable: true, clear: true, edit_parameters: true },
        state_actions: {
            enabled: { available: true, mode: 'dynamic_list_values', requires_parameters: true },
            disabled: { available: true, mode: 'clear_list_values', requires_parameters: false },
            not_configured: { available: true, mode: 'remove_owned_records', requires_parameters: false }
        },
        parameters: [{ id: 'InstallPackagesList', kind: 'list', value: values === null
            ? null : { kind: 'text_list', value: values } }],
        comment: null
    };
}

function draft(state, values) {
    return {
        state,
        parameters: [{ parameter_id: 'InstallPackagesList', value: { kind: 'text_list', value: values } }],
        comment: ''
    };
}

test('Software Install enables with separate package entries, replaces entries and can be disabled', () => {
    const initial = policy('not_configured', null);
    assert.equal(dto.canSelectPolicyState(initial, 'enabled'), true);
    assert.equal(dto.canEditPolicyParameters(initial, 'enabled'), true);
    const baseline = draft('not_configured', []);
    const enabled = draft('enabled', ['vim', 'git']);
    assert.equal(dto.validatePolicyDraft(initial, enabled), null);
    const enableRequest = dto.buildPolicyUpdate(initial, enabled, baseline);
    assert.equal(enableRequest.state, 'enabled');
    assert.equal(enableRequest.set_parameters[0].parameter_id, 'InstallPackagesList');
    assert.equal(JSON.stringify(enableRequest.set_parameters[0].value),
        JSON.stringify({ kind: 'text_list', value: ['vim', 'git'] }));

    const configured = policy('enabled', ['vim', 'git']);
    const replacement = dto.buildPolicyUpdate(configured, draft('enabled', ['git', 'curl']), enabled);
    assert.equal(replacement.state, undefined);
    assert.equal(JSON.stringify(replacement.set_parameters[0].value.value),
        JSON.stringify(['git', 'curl']));
    const disabled = dto.buildPolicyUpdate(configured, draft('disabled', ['vim', 'git']), enabled);
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.set_parameters, undefined);
    assert.equal(dto.validatePolicyDraft(configured, draft('disabled', [])), null);
});

test('empty enabled list is stopped before RPC with a localized field error', () => {
    const initial = policy('not_configured', null);
    for (const values of [[], ['   ']]) {
        const error = dto.validatePolicyDraft(initial, draft('enabled', values));
        assert.equal(error.category, 'validation');
        assert.equal(error.field, 'InstallPackagesList');
        for (const [language, locale] of [['en', en], ['ru', ru]]) {
            translations.setLanguage(language);
            assert.equal(status.messageForError(error),
                locale.editorStatus.errors.validation + ' ' + locale.editorStatus.details.listRequiresEntry);
            assert.notEqual(translations.t('policies.listOnePerLine'), 'policies.listOnePerLine');
        }
    }
});

test('read-only and unsupported list inspection does not block an unrelated comment edit', () => {
    const readOnly = policy('enabled', null);
    readOnly.capabilities.edit_parameters = false;
    assert.equal(dto.validatePolicyDraft(readOnly, draft('enabled', [])), null);
    const unsupported = policy('enabled', null);
    const inspected = draft('enabled', []);
    inspected.parameters[0].value = { kind: 'unsupported', value: { type: 'binary', value: [1] } };
    assert.equal(dto.validatePolicyDraft(unsupported, inspected), null);
});

test('explicit key-value policy updates retain structured pairs and validate domain constraints', () => {
    const configured = policy('enabled', null);
    configured.parameters[0].collection = {
        mode: 'key_value', unique_keys: true, key_comparison: 'unicode_uppercase',
        allow_empty_values: true, min_items: 1
    };
    const value = { kind: 'key_value_list', value: [{ key: 'Provider=one:module', value: 'C:\\one=path:module.dll' }] };
    const edited = draft('enabled', []);
    edited.parameters[0].value = value;
    assert.equal(dto.validatePolicyDraft(configured, edited), null);
    assert.equal(JSON.stringify(dto.buildPolicyUpdate(configured, edited).set_parameters[0].value), JSON.stringify(value));
    value.value.push({ key: 'PROVIDER=ONE:MODULE', value: '' });
    assert.equal(dto.validatePolicyDraft(configured, edited).message, 'Invalid collection entries');
});

test('enabling a policy never materializes an inspected read-only collection default', () => {
    const initial = policy('not_configured', null);
    const parameter = initial.parameters[0];
    parameter.editable = false;
    parameter.default_value = { kind: 'text_list', value: ['read-only default'] };
    const baseline = draft('not_configured', ['read-only default']);
    const enabled = draft('enabled', ['read-only default']);
    assert.equal(dto.validatePolicyDraft(initial, enabled), null);
    const request = dto.buildPolicyUpdate(initial, enabled, baseline);
    assert.equal(request.state, 'enabled');
    assert.equal(request.set_parameters, undefined);
});
