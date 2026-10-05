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
        define: (names, factory) => { result = factory(...names.map(name => dependencies[name])); }
    });
    return result;
}
const en = load('locales/en.js');
const ru = load('locales/ru.js');
const translations = load('locales/translations.js', { './en': en, './ru': ru });
const status = load('components/editor-status.js', {
    '../util/element-creator': { createElement: (tag, options) => ({ tag, ...options }) },
    '../util/editor-dto': load('util/editor-dto.js'),
    '../locales/translations': translations
});

test('editor errors, actions and pending notices use the selected language', () => {
    for (const [language, locale] of [['en', en], ['ru', ru]]) {
        translations.setLanguage(language);
        for (const category of Object.keys(locale.editorStatus.errors)) {
            assert.equal(status.messageForError({ category }), locale.editorStatus.errors[category]);
        }
        const error = status.renderError({ category: 'publication-conflict', field: 'value' }, { onRefresh() {}, onReconcile() {} });
        assert.equal(error.children[1].text, locale.editorStatus.field + ': value');
        assert.deepEqual(Array.from(error.children[2].children, action => action.text), [locale.editorStatus.refresh, locale.editorStatus.reconcile]);
        assert.equal(status.renderPending({}, () => {}).children[0].text, locale.editorStatus.pending);
        assert.equal(status.messageForError({ message: 'Security policy actions must be a list' }),
            locale.editorStatus.errors.operational + ' ' + locale.editorStatus.details.securityActionsList);
        assert.equal(status.messageForError({ category: 'validation', field: 'policies', message: 'Security policy actions must be a list.' }),
            locale.editorStatus.errors.validation + ' ' + locale.editorStatus.details.securityActionsList);
        assert.equal(status.messageForError({ category: 'validation', message: 'Security element actions must be a list.' }),
            locale.editorStatus.errors.validation + ' ' + locale.editorStatus.details.securityElementActionsList);
        assert.equal(status.messageForError({ category: 'validation', message: 'Keyed-row actions must be a list.' }),
            locale.editorStatus.errors.validation + ' ' + locale.editorStatus.details.securityRowActionsList);
        assert.equal(status.messageForError({ category: 'validation', message: 'Untranslated server diagnostic' }), locale.editorStatus.errors.validation);
        const details = status.renderDiagnostics([{ code: 'source_error', message: 'Untranslated diagnostic' }]);
        assert.equal(details.tag, 'details');
        assert.equal(details.children[0].text, locale.editorStatus.technicalDetails);
    }
});

test('Security and editor-status locale keys are complete in both languages', () => {
    function paths(value, prefix = '') {
        return Object.entries(value).flatMap(([key, child]) => typeof child === 'object' ? paths(child, prefix + key + '.') : [prefix + key]);
    }
    for (const area of ['security', 'editorStatus']) assert.deepEqual(paths(en[area]).sort(), paths(ru[area]).sort());
    const files = ['components/templates/security-template.js', 'components/templates/advanced-audit-template.js',
        ...fs.readdirSync(path.join(root, 'components/templates/security')).map(file => 'components/templates/security/' + file)];
    for (const language of ['en', 'ru']) {
        translations.setLanguage(language);
        for (const file of files) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            const relative = source.includes("translations.t('security.' + key)");
            for (const match of source.matchAll(/\btr\('([^']+)'\s*,/g)) {
                const key = relative ? 'security.' + match[1] : match[1];
                assert.notEqual(translations.t(key), key, language + ': ' + file + ': ' + key);
            }
        }
    }
});
