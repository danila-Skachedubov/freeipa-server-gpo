'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');

function load(file) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
        define: (names, factory) => {
            assert.equal(names.length, 0, 'the collection model must remain independent of DOM and persistence');
            result = factory();
        }
    }, { filename: file });
    return result;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function textList(entries) {
    return { kind: 'text_list', value: entries };
}

function keyValueList(entries) {
    return { kind: 'key_value_list', value: entries };
}

function listParameter(collection = {}, extra = {}) {
    return {
        id: 'Packages',
        kind: 'list',
        ...extra,
        collection: { mode: 'list', ...collection }
    };
}

function keyValueParameter(collection = {}, extra = {}) {
    return {
        id: 'SecurityDevices',
        kind: 'list',
        ...extra,
        collection: { mode: 'key_value', ...collection }
    };
}

const collection = load('util/collection-value.js');

test('ordinary and explicit collections keep distinct typed values without delimiter encoding', () => {
    const ordinary = collection.session(listParameter(), textList(['a=b', 'C:\\Scripts\\one:two.cmd']));
    assert.equal(ordinary.mode, 'list');
    assert.deepEqual(plain(ordinary.read()), textList(['a=b', 'C:\\Scripts\\one:two.cmd']));

    const pairs = [{ key: 'Module=one', value: 'C:\\Program Files\\PKCS#11\\module.dll' }];
    const explicit = collection.session(keyValueParameter(), keyValueList(pairs));
    assert.equal(explicit.mode, 'key_value');
    assert.deepEqual(plain(explicit.read()), keyValueList(pairs));
    assert.deepEqual(plain(collection.empty(listParameter())), textList([]));
    assert.deepEqual(plain(collection.empty(keyValueParameter())), keyValueList([]));
    assert.equal(collection.mode({ kind: 'list' }, keyValueList([])), 'key_value');
});

test('missing collection metadata remains compatible with existing text-list callers', () => {
    const parameter = { id: 'OldList', kind: 'list' };
    assert.equal(collection.mode(parameter, textList(['old'])), 'list');
    assert.deepEqual(plain(collection.constraints(parameter, textList([]))), {
        mode: 'list', unique_keys: false, key_case_sensitive: false,
        allow_empty_values: true, min_items: 0
    });
    assert.deepEqual(plain(collection.session(parameter, null).read()), textList([]));
});

test('each session isolates the original, other sessions and returned typed pairs', () => {
    const parameter = keyValueParameter();
    const original = keyValueList([{ key: 'OpenSC', value: '/usr/lib/opensc.so' }]);
    const first = collection.session(parameter, original);
    const second = collection.session(parameter, original);

    original.value[0].value = '/changed/outside.so';
    original.value.push({ key: 'Outside', value: '/outside.so' });
    assert.deepEqual(plain(first.read()), keyValueList([{ key: 'OpenSC', value: '/usr/lib/opensc.so' }]));

    const id = first.rows[0].id;
    assert.equal(first.edit(id, 'value', '/local/draft.so'), true);
    assert.deepEqual(plain(second.read()), keyValueList([{ key: 'OpenSC', value: '/usr/lib/opensc.so' }]));
    assert.equal(original.value[0].value, '/changed/outside.so');

    const accepted = first.read();
    accepted.value[0].key = 'Caller mutation';
    accepted.value.push({ key: 'Caller entry', value: '/caller.so' });
    assert.deepEqual(plain(first.read()), keyValueList([{ key: 'OpenSC', value: '/local/draft.so' }]));
});

test('reopening clones the current parent draft rather than an older dialog baseline', () => {
    const parameter = listParameter();
    const initial = textList(['first']);
    const first = collection.session(parameter, initial);
    first.edit(first.rows[0].id, 'value', 'accepted');
    const parentDraft = first.read();
    const reopened = collection.session(parameter, parentDraft);
    assert.equal(reopened.isDirty(), false);
    reopened.edit(reopened.rows[0].id, 'value', 'cancelled');
    assert.deepEqual(plain(parentDraft), textList(['accepted']));
    assert.deepEqual(initial, textList(['first']));
});

test('row identities are stable and list positions follow zero-based array order', () => {
    const session = collection.session(listParameter(), textList(['zero', 'one', 'two']));
    const originalIds = plain(session.rows.map(row => row.id));
    assert.equal(new Set(originalIds).size, 3);
    assert.deepEqual(plain(session.rows.map((row, index) => [index, row.value])), [
        [0, 'zero'], [1, 'one'], [2, 'two']
    ]);

    session.edit(originalIds[1], 'value', 'edited one');
    session.move(originalIds[2], 0);
    assert.deepEqual(plain(session.rows.map(row => row.id)), [originalIds[2], originalIds[0], originalIds[1]]);
    assert.deepEqual(plain(session.rows.map((row, index) => [index, row.value])), [
        [0, 'two'], [1, 'zero'], [2, 'edited one']
    ]);
    assert.deepEqual(plain(session.read()), textList(['two', 'zero', 'edited one']));
});

test('Add appends a blank row, clears selection and uses a new identity after deletion', () => {
    const session = collection.session(keyValueParameter(), keyValueList([
        { key: 'a', value: '1' }, { key: 'b', value: '2' }
    ]));
    const selectedId = session.rows[0].id;
    session.select(selectedId);
    assert.equal(session.selectedId, selectedId);
    const addedId = session.add();
    assert.equal(session.selectedId, null);
    assert.equal(session.rows.length, 3);
    assert.equal(session.rows[2].id, addedId);
    assert.equal(session.rows[2].key, '');
    assert.equal(session.rows[2].value, '');
    assert.equal(session.removeSelected(), false);

    session.select(addedId);
    assert.equal(session.removeSelected(), true);
    const nextId = session.add();
    assert.notEqual(nextId, addedId);
    assert.equal(session.rows[2].id, nextId);
    assert.deepEqual(plain(session.read()), keyValueList([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]));
});

test('Remove deletes only the selected row and clears selection without selecting a neighbour', () => {
    const session = collection.session(listParameter(), textList(['a', 'b', 'c']));
    const ids = plain(session.rows.map(row => row.id));
    assert.equal(session.removeSelected(), false);
    session.select('unknown');
    assert.equal(session.selectedId, null);
    assert.equal(session.removeSelected(), false);
    session.select(ids[1]);
    assert.equal(session.removeSelected(), true);
    assert.equal(session.selectedId, null);
    assert.deepEqual(plain(session.rows.map(row => row.id)), [ids[0], ids[2]]);
    assert.deepEqual(plain(session.read()), textList(['a', 'c']));
    assert.equal(session.removeSelected(), false);
});

test('reorder retains row identities and selection, and invalid or no-op moves change nothing', () => {
    const session = collection.session(listParameter(), textList(['a', 'b', 'c']));
    const ids = plain(session.rows.map(row => row.id));
    session.select(ids[1]);
    assert.equal(session.move(ids[1], 0), true);
    assert.equal(session.selectedId, ids[1]);
    assert.deepEqual(plain(session.rows.map(row => row.id)), [ids[1], ids[0], ids[2]]);
    assert.equal(session.move(ids[1], 0), false);
    assert.equal(session.move('unknown', 1), false);
    assert.equal(session.move(ids[1], 0.5), false);
    assert.deepEqual(plain(session.read()), textList(['b', 'a', 'c']));
    assert.equal(session.move(ids[1], 100), true);
    assert.deepEqual(plain(session.read()), textList(['a', 'c', 'b']));
    assert.equal(session.move(ids[1], -100), true);
    assert.deepEqual(plain(session.read()), textList(['b', 'a', 'c']));
    assert.equal(session.selectedId, ids[1]);
});

test('pending editor text is included in read, validation and dirty detection but never mutates rows', () => {
    const parameter = keyValueParameter();
    const session = collection.session(parameter, keyValueList([
        { key: 'first', value: '1' }, { key: 'second', value: '2' }
    ]));
    const id = session.rows[1].id;
    const pending = { id, field: 'key', value: 'FIRST' };
    assert.equal(session.isDirty(), false);
    assert.equal(session.isDirty(pending), true);
    assert.equal(session.rows[1].key, 'second');
    assert.deepEqual(plain(session.read(pending)), keyValueList([
        { key: 'first', value: '1' }, { key: 'FIRST', value: '2' }
    ]));
    assert.deepEqual(plain(session.errors(pending)).map(error => [error.id, error.field, error.code]), [
        [id, 'key', 'duplicateKey'], [session.rows[0].id, 'key', 'duplicateKey']
    ]);

    // Escape discards the pending buffer: callers resume reading without it.
    assert.equal(session.isDirty(), false);
    assert.deepEqual(plain(session.errors()), []);
    assert.equal(session.rows[1].key, 'second');
    session.edit(id, pending.field, 'third');
    assert.equal(session.isDirty(), true);
    assert.deepEqual(plain(session.read()), keyValueList([
        { key: 'first', value: '1' }, { key: 'third', value: '2' }
    ]));
});

test('fresh blank rows are ignored while existing empty entries remain part of the collection', () => {
    const session = collection.session(listParameter(), textList(['']));
    const addedId = session.add();
    assert.equal(session.rows.length, 2);
    assert.deepEqual(plain(session.read()), textList(['']));
    assert.equal(session.isDirty(), false);

    const pending = { id: addedId, field: 'value', value: 'new' };
    assert.deepEqual(plain(session.read(pending)), textList(['', 'new']));
    assert.equal(session.isDirty(pending), true);
    assert.equal(session.rows[1].value, '');
    session.edit(addedId, 'value', 'new');
    assert.deepEqual(plain(session.read()), textList(['', 'new']));
    session.edit(addedId, 'value', '');
    assert.deepEqual(plain(session.read()), textList(['']));

    const explicit = collection.session(keyValueParameter(), keyValueList([{ key: 'existing', value: '' }]));
    const freshId = explicit.add();
    assert.deepEqual(plain(explicit.read()), keyValueList([{ key: 'existing', value: '' }]));
    explicit.edit(freshId, 'key', 'fresh');
    assert.deepEqual(plain(explicit.read()), keyValueList([
        { key: 'existing', value: '' }, { key: 'fresh', value: '' }
    ]));
});

test('partially filled new key–value rows are retained and validated at the correct row identity', () => {
    const session = collection.session(keyValueParameter(), keyValueList([]));
    const id = session.add();
    const pending = { id, field: 'value', value: '/usr/lib/provider.so' };
    assert.equal(session.isDirty(pending), true);
    assert.deepEqual(plain(session.read(pending)), keyValueList([{ key: '', value: '/usr/lib/provider.so' }]));
    assert.deepEqual(plain(session.errors(pending)), [
        { index: 0, field: 'key', code: 'requiredKey', id }
    ]);
    session.edit(id, 'key', 'Provider');
    assert.deepEqual(plain(session.errors()), []);
});

test('explicit keys are unique with domain-declared ASCII-case rules, not locale folding', () => {
    const insensitive = keyValueParameter({ key_case_sensitive: false });
    const casePair = keyValueList([{ key: 'OpenSC', value: '1' }, { key: 'opensc', value: '2' }]);
    assert.deepEqual(plain(collection.validate(insensitive, casePair)), [
        { index: 1, field: 'key', code: 'duplicateKey' },
        { index: 0, field: 'key', code: 'duplicateKey' }
    ]);
    assert.deepEqual(plain(collection.validate(keyValueParameter({ key_case_sensitive: true }), casePair)), []);
    assert.deepEqual(plain(collection.validate(insensitive, keyValueList([
        { key: 'Ä', value: '1' }, { key: 'ä', value: '2' }
    ]))), []);
});

test('declared Unicode uppercase comparison conservatively finds non-ASCII registry key collisions', () => {
    const entries = keyValueList([
        { key: 'Ключ', value: '1' }, { key: 'ключ', value: '2' },
        { key: 'ß', value: '3' }, { key: 'SS', value: '4' }
    ]);
    const unicodeRules = { key_comparison: 'unicode_uppercase', key_case_sensitive: false };
    assert.deepEqual(plain(collection.validate(keyValueParameter(unicodeRules), entries)), [
        { index: 1, field: 'key', code: 'duplicateKey' },
        { index: 0, field: 'key', code: 'duplicateKey' },
        { index: 3, field: 'key', code: 'duplicateKey' },
        { index: 2, field: 'key', code: 'duplicateKey' }
    ]);
    assert.deepEqual(plain(collection.validate(keyValueParameter({ key_case_sensitive: false }), entries)), []);
    assert.deepEqual(plain(collection.validate(keyValueParameter({ ...unicodeRules, key_case_sensitive: true }), entries)), []);
    assert.deepEqual(plain(collection.constraints(keyValueParameter(unicodeRules), entries)).key_comparison,
        'unicode_uppercase');
});

test('name-equals-data lists enforce declared uniqueness while numbered lists allow repeats and empty values', () => {
    const named = listParameter({ unique_keys: true, allow_empty_values: false });
    assert.deepEqual(plain(collection.validate(named, textList(['Package', 'package']))), [
        { index: 1, field: 'value', code: 'duplicateKey' },
        { index: 0, field: 'value', code: 'duplicateKey' }
    ]);
    assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: true, key_case_sensitive: true }),
        textList(['Package', 'package']))), []);
    assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: false, allow_empty_values: true }),
        textList(['repeat', 'repeat', '', '  ']))), []);
    assert.deepEqual(plain(collection.session(listParameter({ unique_keys: false, allow_empty_values: true }),
        textList(['repeat', 'repeat', ''])).read()), textList(['repeat', 'repeat', '']));
});

test('minimum size excludes untouched new rows and empty-value constraints do not trim stored content', () => {
    const parameter = listParameter({ min_items: 1, allow_empty_values: false });
    const session = collection.session(parameter, textList([]));
    const id = session.add();
    assert.deepEqual(plain(session.errors()), [{ index: null, field: null, code: 'minItems', id: null }]);
    assert.deepEqual(plain(session.errors({ id, field: 'value', value: '   ' })), [
        { index: 0, field: 'value', code: 'requiredValue', id }
    ]);
    session.edit(id, 'value', '  firefox  ');
    assert.deepEqual(plain(session.errors()), []);
    assert.deepEqual(plain(session.read()), textList(['  firefox  ']));
});

test('NUL text and reserved or blank registry keys receive field-specific errors', () => {
    const errors = plain(collection.validate(keyValueParameter(), keyValueList([
        { key: 'Provider', value: 'invalid\0value' },
        { key: '**Del.SomeRecord', value: 'value' },
        { key: 'invalid\0key', value: 'value' },
        { key: '  ', value: 'value' }
    ])));
    assert.deepEqual(errors, [
        { index: 0, field: 'value', code: 'invalidText' },
        { index: 1, field: 'key', code: 'invalidKey' },
        { index: 2, field: 'key', code: 'invalidKey' },
        { index: 3, field: 'key', code: 'requiredKey' }
    ]);
    assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: false }), textList(['a\0b']))), [
        { index: 0, field: 'value', code: 'invalidText' }
    ]);
    assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: true }), textList(['**Del.a']))), [
        { index: 0, field: 'value', code: 'invalidKey' }
    ]);
    assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: false }), textList(['**plain-text']))), []);
});

test('registry names reject CR and LF while collection data preserves permitted newlines', () => {
    for (const name of ['first\nsecond', 'first\rsecond', 'first\r\nsecond']) {
        assert.deepEqual(plain(collection.validate(keyValueParameter(),
            keyValueList([{ key: name, value: 'data\r\nwith\nnewlines' }]))), [
            { index: 0, field: 'key', code: 'invalidKey' }
        ]);
        assert.deepEqual(plain(collection.validate(listParameter({ unique_keys: true }), textList([name]))), [
            { index: 0, field: 'value', code: 'invalidKey' }
        ]);
    }

    const pairs = keyValueList([{ key: 'Provider', value: 'data\r\nwith\nnewlines' }]);
    assert.deepEqual(plain(collection.validate(keyValueParameter(), pairs)), []);
    assert.deepEqual(plain(collection.session(keyValueParameter(), pairs).read()), pairs);

    const numbered = listParameter({ unique_keys: false });
    const entries = textList(['first\r\nsecond', 'first\r\nsecond']);
    assert.deepEqual(plain(collection.validate(numbered, entries)), []);
    assert.deepEqual(plain(collection.session(numbered, entries).read()), entries);
});

test('maximum length counts Unicode scalar values rather than UTF-16 code units', () => {
    const parameter = listParameter({}, { max_length: 2 });
    assert.deepEqual(plain(collection.validate(parameter, textList(['🦊🙂', 'яa']))), []);
    assert.deepEqual(plain(collection.validate(parameter, textList(['🦊🙂a']))), [
        { index: 0, field: 'value', code: 'tooLong' }
    ]);
    assert.deepEqual(plain(collection.validate(keyValueParameter({}, { max_length: 2 }), keyValueList([
        { key: 'Long key is independent of the value constraint', value: '🦊🙂a' }
    ]))), [{ index: 0, field: 'value', code: 'tooLong' }]);
    assert.deepEqual(plain(collection.validate(listParameter({}, { max_length: null }), textList(['long value']))), []);
});

test('declared key and value limits count UTF-16 units separately and accept exact emoji boundaries', () => {
    const rules = { max_key_length: 3, max_value_length: 5, length_unit: 'utf16' };
    const parameter = keyValueParameter(rules);
    const boundary = keyValueList([{ key: '🦊a', value: '🦊🙂a' }]);
    assert.deepEqual(plain(collection.validate(parameter, boundary)), []);
    assert.deepEqual(plain(collection.validate(parameter, keyValueList([{ key: '🦊ab', value: '🦊🙂a' }]))), [
        { index: 0, field: 'key', code: 'keyTooLong' }
    ]);
    assert.deepEqual(plain(collection.validate(parameter, keyValueList([{ key: '🦊a', value: '🦊🙂ab' }]))), [
        { index: 0, field: 'value', code: 'tooLong' }
    ]);
    assert.deepEqual(plain(collection.constraints(parameter, boundary)), {
        mode: 'key_value', unique_keys: true, key_case_sensitive: false,
        allow_empty_values: true, min_items: 0,
        max_key_length: 3, max_value_length: 5, length_unit: 'utf16'
    });

    assert.deepEqual(plain(collection.validate(listParameter({ max_value_length: 2, length_unit: 'utf16' }),
        textList(['🦊']))), []);
    assert.deepEqual(plain(collection.validate(listParameter({ max_value_length: 2, length_unit: 'utf16' }),
        textList(['🦊a']))), [{ index: 0, field: 'value', code: 'tooLong' }]);
    assert.deepEqual(plain(collection.validate(keyValueParameter({ max_key_length: 2, max_value_length: 2 }),
        keyValueList([{ key: '🦊a', value: '🦊🙂' }]))), []);
});

test('declared collection mode rejects a mismatched wire kind instead of inferring a different mode', () => {
    const parameter = listParameter();
    const mismatched = keyValueList([{ key: 'key', value: 'value' }]);
    assert.equal(collection.mode(parameter, mismatched), 'list');
    assert.deepEqual(plain(collection.validate(parameter, mismatched)), [
        { index: null, field: null, code: 'invalidValue' }
    ]);
    assert.deepEqual(plain(collection.validate(keyValueParameter(), textList(['value']))), [
        { index: null, field: null, code: 'invalidValue' }
    ]);
    assert.deepEqual(plain(collection.validate({ kind: 'list' }, mismatched)), []);
});

test('invalid values are rejected without normalizing malformed entries or mutating the input', () => {
    assert.deepEqual(plain(collection.validate(listParameter(), null)), [
        { index: null, field: null, code: 'invalidValue' }
    ]);
    assert.deepEqual(plain(collection.validate(listParameter(), { kind: 'text_list', value: 'not an array' })), [
        { index: null, field: null, code: 'invalidValue' }
    ]);
    const malformed = keyValueList([{ key: 'good', value: 12 }, { value: 'missing key' }, null]);
    const baseline = plain(malformed);
    assert.deepEqual(plain(collection.validate(keyValueParameter(), malformed)), [
        { index: 0, field: 'value', code: 'invalidValue' },
        { index: 1, field: 'key', code: 'invalidValue' },
        { index: 2, field: 'value', code: 'invalidValue' }
    ]);
    assert.deepEqual(malformed, baseline);
});

test('summaries show at most three previews, use only KV keys and preserve original full values', () => {
    const longValue = 'x'.repeat(10000) + '\nfull final text';
    const ordinary = textList(['first\nline', 'second\tvalue', longValue, 'fourth']);
    const baseline = plain(ordinary);
    const summary = plain(collection.summary(listParameter(), ordinary));
    assert.equal(summary.mode, 'list');
    assert.equal(summary.count, 4);
    assert.equal(summary.more, true);
    assert.equal(summary.preview.length, 3);
    assert.equal(summary.preview[0], 'first line');
    assert.equal(summary.preview[1], 'second value');
    assert.equal(summary.preview[2], longValue.replace(/\n/g, ' '));
    assert.deepEqual(ordinary, baseline);
    assert.deepEqual(plain(collection.session(listParameter(), ordinary).read()), baseline);

    const pairs = keyValueList([{ key: 'OpenSC', value: longValue }, { key: 'CryptoPro', value: '/full/path.so' }]);
    assert.deepEqual(plain(collection.summary(keyValueParameter(), pairs)), {
        mode: 'key_value', count: 2, preview: ['OpenSC', 'CryptoPro'], more: false
    });
    assert.equal(pairs.value[0].value, longValue);
    assert.deepEqual(plain(collection.summary(listParameter(), null)), {
        mode: 'list', count: 0, preview: [], more: false
    });
});

test('filtering searches keys and values but does not alter saved order or hidden entries', () => {
    const initial = keyValueList([
        { key: 'First', value: '/first.so' },
        { key: 'OpenSC', value: '/usr/lib/provider.so' },
        { key: 'Last', value: '/last.so' }
    ]);
    const session = collection.session(keyValueParameter(), initial);
    const selectedId = session.rows[2].id;
    session.select(selectedId);
    assert.deepEqual(plain(session.visible('opensc').map(row => row.id)), [session.rows[1].id]);
    assert.deepEqual(plain(session.visible('PROVIDER').map(row => row.id)), [session.rows[1].id]);
    assert.equal(session.visible('nothing matches').length, 0);
    assert.equal(session.selectedId, selectedId);
    assert.equal(session.isDirty(), false);
    assert.deepEqual(plain(session.read()), initial);
    assert.deepEqual(plain(session.visible('').map(row => row.id)), plain(session.rows.map(row => row.id)));
});

test('only valid editable fields can be committed and an unknown selection cannot remove data', () => {
    const ordinary = collection.session(listParameter(), textList(['one']));
    const id = ordinary.rows[0].id;
    assert.equal(ordinary.edit(id, 'key', 'registry name'), false);
    assert.equal(ordinary.edit(id, 'id', 'replacement id'), false);
    assert.equal(ordinary.edit('unknown', 'value', 'other'), false);
    assert.equal(ordinary.rows[0].id, id);
    assert.deepEqual(plain(ordinary.read()), textList(['one']));
    ordinary.select('unknown');
    assert.equal(ordinary.removeSelected(), false);
    assert.deepEqual(plain(ordinary.read()), textList(['one']));
});

test('English and Russian collection strings cover every label and validation code with matching placeholders', () => {
    const en = load('locales/en.js').collections;
    const ru = load('locales/ru.js').collections;
    function strings(source, prefix = '') {
        return Object.entries(source).flatMap(([key, value]) => {
            const name = prefix ? prefix + '.' + key : key;
            return typeof value === 'object' ? strings(value, name) : [[name, value]];
        });
    }
    const english = Object.fromEntries(strings(en));
    const russian = Object.fromEntries(strings(ru));
    assert.deepEqual(Object.keys(russian).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
        assert.equal(typeof value, 'string', 'English ' + key);
        assert.ok(value.trim(), 'English ' + key);
        assert.equal(typeof russian[key], 'string', 'Russian ' + key);
        assert.ok(russian[key].trim(), 'Russian ' + key);
        assert.deepEqual(russian[key].match(/\{[^{}]+\}/g) || [], value.match(/\{[^{}]+\}/g) || [], key);
    }
    for (const code of [
        'minItems', 'requiredKey', 'requiredValue', 'duplicateKey', 'invalidKey',
        'invalidText', 'tooLong', 'keyTooLong', 'invalidValue'
    ]) {
        assert.ok(english['errors.' + code], 'English error ' + code);
        assert.ok(russian['errors.' + code], 'Russian error ' + code);
    }
    assert.equal(en.add, 'Add');
    assert.equal(ru.add, 'Добавить');
    assert.equal(en.errors.keyTooLong, 'The name exceeds the allowed length.');
    assert.equal(ru.errors.keyTooLong, 'Имя превышает допустимую длину.');
});
