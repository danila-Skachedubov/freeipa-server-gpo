/** Typed collection values and isolated editor sessions; no DOM or persistence. */
define([], function() {
    'use strict';
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function mode(parameter, value) {
        if (parameter.collection && parameter.collection.mode) return parameter.collection.mode;
        return value && value.kind === 'key_value_list' ? 'key_value' : 'list';
    }
    function constraints(parameter, value) {
        var declared = parameter.collection || {};
        return {
            mode: mode(parameter, value),
            unique_keys: declared.unique_keys === true || mode(parameter, value) === 'key_value',
            key_case_sensitive: declared.key_case_sensitive === true,
            key_comparison: declared.key_comparison,
            allow_empty_values: declared.allow_empty_values !== false,
            min_items: Number(declared.min_items || 0),
            max_length: parameter.max_length,
            max_key_length: declared.max_key_length,
            max_value_length: declared.max_value_length,
            length_unit: declared.length_unit
        };
    }
    function folded(key, rules) {
        if (rules.key_case_sensitive) return key;
        return rules.key_comparison === 'unicode_uppercase' ? key.toUpperCase()
            : key.replace(/[A-Z]/g, function(letter) { return letter.toLowerCase(); });
    }
    function validate(parameter, value) {
        var rules = constraints(parameter, value);
        var errors = [];
        var entries = value && value.value;
        if (!Array.isArray(entries) || value.kind !== (rules.mode === 'key_value' ? 'key_value_list' : 'text_list')) {
            return [{ index: null, field: null, code: 'invalidValue' }];
        }
        if (entries.length < rules.min_items) errors.push({ index: null, field: null, code: 'minItems' });
        var seen = new Map();
        entries.forEach(function(entry, index) {
            var key = rules.mode === 'key_value' ? entry && entry.key : entry;
            var text = rules.mode === 'key_value' ? entry && entry.value : entry;
            var keyField = rules.mode === 'key_value' ? 'key' : 'value';
            if (typeof text !== 'string' || rules.mode === 'key_value' && typeof key !== 'string') {
                errors.push({ index: index, field: typeof text !== 'string' ? 'value' : keyField, code: 'invalidValue' });
                return;
            }
            if (text.indexOf('\0') !== -1) errors.push({ index: index, field: 'value', code: 'invalidText' });
            if (!rules.allow_empty_values && !text.trim()) errors.push({ index: index, field: 'value', code: 'requiredValue' });
            if (rules.max_length !== null && rules.max_length !== undefined && Array.from(text).length > rules.max_length) {
                errors.push({ index: index, field: 'value', code: 'tooLong' });
            }
            var valueLength = rules.length_unit === 'utf16' ? text.length : Array.from(text).length;
            if (rules.max_value_length !== null && rules.max_value_length !== undefined && valueLength > rules.max_value_length) {
                errors.push({ index: index, field: 'value', code: 'tooLong' });
            }
            if (!rules.unique_keys) return;
            if (!key.trim()) errors.push({ index: index, field: keyField, code: rules.mode === 'key_value' ? 'requiredKey' : 'requiredValue' });
            if (/[\0\r\n]/.test(key) || key.indexOf('**') === 0) errors.push({ index: index, field: keyField, code: 'invalidKey' });
            var keyLength = rules.length_unit === 'utf16' ? key.length : Array.from(key).length;
            if (rules.max_key_length !== null && rules.max_key_length !== undefined && keyLength > rules.max_key_length) {
                errors.push({ index: index, field: keyField, code: 'keyTooLong' });
            }
            var name = folded(key, rules);
            if (seen.has(name)) {
                errors.push({ index: index, field: keyField, code: 'duplicateKey' });
                var previous = seen.get(name);
                if (!errors.some(function(error) { return error.index === previous && error.code === 'duplicateKey'; })) {
                    errors.push({ index: previous, field: keyField, code: 'duplicateKey' });
                }
            } else seen.set(name, index);
        });
        return errors;
    }
    function empty(parameter, value) {
        return { kind: mode(parameter, value) === 'key_value' ? 'key_value_list' : 'text_list', value: [] };
    }
    function summary(parameter, value) {
        var entries = value && Array.isArray(value.value) ? value.value : [];
        return {
            mode: mode(parameter, value),
            count: entries.length,
            preview: entries.slice(0, 3).map(function(entry) {
                var text = mode(parameter, value) === 'key_value' ? entry.key : entry;
                return String(text).replace(/[\r\n\t]+/g, ' ');
            }),
            more: entries.length > 3
        };
    }
    function session(parameter, value) {
        var initial = value && Array.isArray(value.value) ? clone(value) : empty(parameter, value);
        var rules = constraints(parameter, initial);
        var sequence = 0;
        var rows = initial.value.map(function(entry) {
            return rules.mode === 'key_value'
                ? { id: 'row-' + (++sequence), key: entry.key, value: entry.value, fresh: false }
                : { id: 'row-' + (++sequence), value: entry, fresh: false };
        });
        function effectiveRows(pending) {
            return rows.map(function(row) {
                if (!pending || pending.id !== row.id) return row;
                var copy = Object.assign({}, row);
                copy[pending.field] = pending.value;
                return copy;
            }).filter(function(row) {
                return !row.fresh || row.value !== '' || rules.mode === 'key_value' && row.key !== '';
            });
        }
        function read(pending) {
            return {
                kind: rules.mode === 'key_value' ? 'key_value_list' : 'text_list',
                value: effectiveRows(pending).map(function(row) {
                    return rules.mode === 'key_value' ? { key: row.key, value: row.value } : row.value;
                })
            };
        }
        var state = {
            rows: rows,
            mode: rules.mode,
            selectedId: null,
            read: read,
            isDirty: function(pending) { return JSON.stringify(read(pending)) !== JSON.stringify(initial); },
            find: function(id) { return rows.find(function(row) { return row.id === id; }); },
            select: function(id) { state.selectedId = state.find(id) ? id : null; },
            add: function() {
                var row = { id: 'row-' + (++sequence), value: '', fresh: true };
                if (rules.mode === 'key_value') row.key = '';
                rows.push(row);
                state.selectedId = null;
                return row.id;
            },
            removeSelected: function() {
                var index = rows.findIndex(function(row) { return row.id === state.selectedId; });
                if (index < 0) return false;
                rows.splice(index, 1);
                state.selectedId = null;
                return true;
            },
            edit: function(id, field, text) {
                var row = state.find(id);
                if (!row || field !== 'value' && !(rules.mode === 'key_value' && field === 'key')) return false;
                row[field] = String(text);
                return true;
            },
            move: function(id, index) {
                var from = rows.findIndex(function(row) { return row.id === id; });
                if (from < 0 || !Number.isInteger(index)) return false;
                var to = Math.max(0, Math.min(rows.length - 1, index));
                if (to === from) return false;
                var row = rows.splice(from, 1)[0];
                rows.splice(to, 0, row);
                return true;
            },
            visible: function(query) {
                var needle = String(query || '').toLocaleLowerCase();
                return rows.filter(function(row) {
                    return !needle || ((row.key || '') + '\n' + row.value).toLocaleLowerCase().indexOf(needle) !== -1;
                });
            },
            errors: function(pending) {
                var effective = effectiveRows(pending);
                return validate(parameter, read(pending)).map(function(error) {
                    return Object.assign({}, error, { id: error.index === null ? null : effective[error.index].id });
                });
            }
        };
        return state;
    }
    return { mode: mode, constraints: constraints, validate: validate, empty: empty, summary: summary, session: session };
});
