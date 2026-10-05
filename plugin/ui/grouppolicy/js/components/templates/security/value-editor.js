define(['../../../util/element-creator', '../../../locales/translations'], function(elementCreator, translations) {
    "use strict";

    var createElement = elementCreator.createElement;
    function tr(key, fallback) {
        var value = translations && translations.t('security.' + key);
        return value && value !== 'security.' + key ? value : fallback;
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function same(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function defaultTyped(definition) {
        if (definition && definition.initial) return clone(definition.initial);
        var kind = definition && definition.value_type || 'string';
        if (kind === 'boolean') return { kind: kind, value: false };
        if (kind === 'integer') {
            var ranges = definition.input_ranges && definition.input_ranges.length
                ? definition.input_ranges : definition.ranges || [];
            return { kind: kind, value: ranges.length ? Number(ranges[0].min) : 0 };
        }
        if (kind === 'enum') {
            return { kind: kind, value: definition.options && definition.options.length
                ? definition.options[0].id : '' };
        }
        if (kind === 'flags' || kind === 'string_list' || kind === 'principal_list') {
            return { kind: kind, value: [] };
        }
        if (kind === 'collection') return { kind: kind, value: [] };
        return { kind: kind, value: '' };
    }

    function payload(value, fallback) {
        return value && Object.prototype.hasOwnProperty.call(value, 'value')
            ? value.value : fallback;
    }

    function optionLabel(option) {
        return option.display_name || option.id;
    }

    function inputFor(definition, control, value, disabled) {
        var current = value || defaultTyped(definition);
        var kind = definition.value_type;
        var input;
        var readers;
        var writers;
        if (kind === 'boolean') {
            input = createElement('select', { children: [
                createElement('option', {
                    attrs: { value: 'false' },
                    text: control && control.false_label || tr('disabled', 'Disabled')
                }),
                createElement('option', {
                    attrs: { value: 'true' },
                    text: control && control.true_label || tr('enabled', 'Enabled')
                })
            ] });
            writers = function(next) {
                input.getElement().value = payload(next, false) ? 'true' : 'false';
            };
            readers = function() {
                return { kind: 'boolean', value: input.getElement().value === 'true' };
            };
        } else if (kind === 'enum') {
            input = createElement('select', {
                children: [createElement('option', { attrs: { value: '', disabled: 'disabled' }, text: '—' })].concat((definition.options || []).map(function(option) {
                    return createElement('option', {
                        attrs: { value: option.id }, text: optionLabel(option)
                    });
                }))
            });
            writers = function(next) {
                input.getElement().value = String(payload(next, ''));
            };
            readers = function() {
                return { kind: 'enum', value: input.getElement().value };
            };
        } else if (kind === 'flags') {
            var checks = [];
            input = createElement('div', { className: 'gpo-editor-security-flags' });
            (definition.options || []).forEach(function(option) {
                var checkbox = createElement('input', { attrs: { type: 'checkbox' } });
                checks.push({ option: option, checkbox: checkbox });
                input.append(createElement('label', {
                    className: ['field', 'field__checkbox'],
                    children: [checkbox, createElement('span', { text: optionLabel(option) })]
                }));
            });
            readers = function() {
                return { kind: 'flags', value: checks.filter(function(item) {
                    return item.checkbox.getElement().checked;
                }).map(function(item) { return item.option.id; }) };
            };
            writers = function(next) {
                var selected = new Set(payload(next, []) || []);
                checks.forEach(function(item) {
                    item.checkbox.getElement().checked = selected.has(item.option.id);
                });
            };
            input.securityInputs = checks.map(function(item) {
                return item.checkbox.getElement();
            });
        } else if (kind === 'string_list' || kind === 'principal_list') {
            input = createElement('textarea', {
                attrs: { rows: '5', spellcheck: 'false' }
            });
            writers = function(next) {
                input.getElement().value = (payload(next, []) || []).join('\n');
            };
            readers = function() {
                return {
                    kind: kind,
                    value: input.getElement().value.split(/\r?\n/).filter(function(line) {
                        return line !== '';
                    })
                };
            };
        } else if (kind === 'sddl') {
            input = createElement('textarea', { attrs: { rows: '4', spellcheck: 'false' } });
            writers = function(next) { input.getElement().value = String(payload(next, '')); };
            readers = function() { return { kind: kind, value: input.getElement().value }; };
        } else {
            input = createElement('input', {
                attrs: {
                    type: kind === 'integer' ? 'number' : 'text',
                    autocomplete: 'off',
                    spellcheck: kind === 'sddl' ? 'false' : null
                }
            });
            writers = function(next) {
                input.getElement().value = String(payload(next, ''));
            };
            readers = function() {
                var raw = input.getElement().value;
                return {
                    kind: kind,
                    value: kind === 'integer'
                        ? (raw === '' ? NaN : Number(raw))
                        : raw
                };
            };
        }

        writers(current);
        input.getElement().setAttribute('data-security-value-kind', kind);

        function setDisabled(value) {
            var inputs = input.securityInputs || [input.getElement()];
            inputs.forEach(function(element) { element.disabled = Boolean(value); });
        }
        setDisabled(disabled || control && control.read_only);
        return {
            root: input,
            read: readers,
            write: writers,
            setDisabled: setDisabled,
            focus: function() {
                var target = (input.securityInputs || [input.getElement()])[0];
                if (target && target.focus) target.focus();
            }
        };
    }

    function validationError(definition, typed) {
        if (!definition || !typed || typed.kind !== definition.value_type) {
            return tr('validationType', 'The value type does not match the definition.');
        }
        if (typed.kind === 'integer') {
            if (!Number.isSafeInteger(typed.value)) return tr('validationInteger', 'Enter a whole number.');
            var ranges = definition.input_ranges && definition.input_ranges.length
                ? definition.input_ranges : definition.ranges || [];
            if (ranges.length && !ranges.some(function(range) {
                return typed.value >= range.min && typed.value <= range.max;
            })) return tr('validationRange', 'Enter a value in the allowed range.');
        }
        if ((typed.kind === 'enum' || typed.kind === 'flags') && definition.options) {
            var allowed = new Set(definition.options.map(function(option) { return option.id; }));
            var values = typed.kind === 'flags' ? typed.value : [typed.value];
            if (values.some(function(value) { return !allowed.has(value); })) {
                return tr('validationChoice', 'Select a value supplied by the definition.');
            }
        }
        if (typed.kind === 'sddl' && /[\r\n]/.test(typed.value)) {
            return tr('validationDescriptor', 'Enter one security descriptor without line breaks.');
        }
        if (['sddl', 'principal', 'service_name', 'registry_key', 'file_path'].indexOf(typed.kind) !== -1 && !String(typed.value || '').trim()) {
            return tr('validationRequired', 'A value is required.');
        }
        return null;
    }

    function fieldDefinition(collection, fieldId) {
        var field = (collection.fields || []).find(function(item) {
            return item.id === fieldId;
        });
        return field && field.element || null;
    }

    function newRow(collection) {
        var row = {};
        (collection.fields || []).forEach(function(field) {
            row[field.id] = field.element.initial
                ? { state: 'set', value: clone(field.element.initial) }
                : { state: 'unset' };
        });
        return row;
    }

    function rowKey(collection, row) {
        var state = row && row[collection.unique_by];
        return state && state.state === 'set' ? state.value : null;
    }

    function rowActions(collection, baseline, draft) {
        if (!collection.unique_by) return [];
        var previous = new Map();
        var current = new Map();
        (baseline || []).forEach(function(row) {
            var key = rowKey(collection, row);
            if (key) previous.set(JSON.stringify(key), row);
        });
        (draft || []).forEach(function(row) {
            var key = rowKey(collection, row);
            if (key) current.set(JSON.stringify(key), row);
        });
        var actions = [];
        previous.forEach(function(row, encoded) {
            if (!current.has(encoded)) {
                actions.push({ action: 'delete', key: rowKey(collection, row) });
            }
        });
        current.forEach(function(row, encoded) {
            if (!previous.has(encoded) || !same(previous.get(encoded), row)) {
                actions.push({ action: 'upsert', key: rowKey(collection, row), fields: clone(row) });
            }
        });
        return actions;
    }

    return {
        clone: clone,
        same: same,
        defaultTyped: defaultTyped,
        inputFor: inputFor,
        validationError: validationError,
        fieldDefinition: fieldDefinition,
        newRow: newRow,
        rowKey: rowKey,
        rowActions: rowActions
    };
});
