define([
    '../../../util/element-creator',
    '../../../util/API',
    '../../../util/editor-dto',
    '../../editor-status',
    '../../confirmation-dialog',
    '../../editor-dialog',
    '../../list-navigation',
    '../../../locales/translations',
    './layouts/index',
    './targeting-editor'
], function(elementCreator, API, dto, editorStatus, confirmationDialog, editorDialog, listNavigation, translations, preferenceLayouts, targetingEditor) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;
    var nextHeaderOwnerId = 1;
    var nextFieldControlId = 1;
    var PREFERENCE_LAYOUTS = preferenceLayouts;

    function pt(key) {
        return t('preferences.editor.' + key);
    }

    function validationMessage(code) {
        if (code === 'required') return pt('validationRequired');
        if (code === 'invalid_number') return pt('validationInvalidNumber');
        if (code === 'unsigned_byte_range') return pt('validationUnsignedByteRange');
        var targetingCodes = { invalid_date: 'validationDate', invalid_time: 'validationTime',
            invalid_ip: 'validationIp', invalid_ipv6: 'validationIpv6', invalid_mac: 'validationMac', invalid_version: 'validationVersion', invalid_guid: 'validationGuid',
            invalid_range: 'validationRange', invalid_value: 'validationValue' };
        if (targetingCodes[code]) return pt(targetingCodes[code]);
        return pt('validationFixErrors');
    }

    function listFrom(result, key) {
        if (Array.isArray(result)) return result;
        return result && Array.isArray(result[key]) ? result[key] : [];
    }

    function parentCandidateLabel(candidate) {
        var depth = Math.max(0, Math.floor(Number(candidate && candidate.depth) || 0));
        var prefix = '';
        for (var index = 0; index < depth; index += 1) prefix += '\u00a0\u00a0';
        return prefix + String(candidate && candidate.label || '');
    }

    function scopeField(field, scope) {
        var result = dto.clone(field);
        if (!result || result.id !== 'metadata.userContext') return result;
        if (scope === 'user') {
            result.label = pt('userContext');
        } else {
            result.hidden = true;
            result.editable = false;
        }
        return result;
    }

    function actionLabel(value) {
        var key = ({ create: 'actionCreate', replace: 'actionReplace',
            update: 'actionUpdate', delete: 'actionDelete' })[value];
        return key ? pt(key) : (value === null || value === undefined ? '' : String(value));
    }

    function itemFieldValue(item, fieldId) {
        if (!item || !fieldId) return '';
        if (Array.isArray(item.fields)) {
            for (var index = 0; index < item.fields.length; index++) {
                if (item.fields[index] && item.fields[index].id === fieldId) {
                    return dto.valuePayload(item.fields[index].value);
                }
            }
        }
        if (item.properties && typeof item.properties === 'object') {
            var key = String(fieldId).indexOf('properties.') === 0
                ? String(fieldId).slice('properties.'.length) : String(fieldId);
            if (Object.prototype.hasOwnProperty.call(item.properties, key)) {
                var raw = item.properties[key];
                if (raw && typeof raw === 'object' && 'kind' in raw) return dto.valuePayload(raw);
                return raw === null || raw === undefined ? '' : String(raw);
            }
        }
        return '';
    }

    function tableColumns(kind) {
        var layout = PREFERENCE_LAYOUTS[kind];
        if (layout && Array.isArray(layout.columns) && layout.columns.length) {
            return layout.columns;
        }
        return null;
    }

    function hiddenFieldControl(field) {
        return {
            id: field.id,
            field: field,
            read: function() { return dto.clone(field.value); },
            setError: function() {},
            setDynamicDisabled: function() { return false; },
            focus: function() {}
        };
    }

    function buildControlInput(field, forceReadonly, materializeOptionalDefault, textarea) {
        var value = dto.clone(field.value || { kind: 'text', value: '' });
        var disabled = Boolean(forceReadonly || field.editable === false);
        var controlKind = field.control || '';
        var input;
        var inputElement = null;
        var optionalBooleanTouched = false;
        var checkboxValueKind = null;
        var checkboxControlId = null;
        function checkboxControl(checked) {
            var controlId = 'gpo-preference-field-' + nextFieldControlId++;
            checkboxControlId = controlId;
            var checkbox = createElement('input', {
                attrs: {
                    id: controlId,
                    type: 'checkbox',
                    disabled: disabled ? 'disabled' : null
                }
            });
            checkbox.getElement().checked = Boolean(checked);
            checkbox.on('change', function() { optionalBooleanTouched = true; });
            inputElement = checkbox.getElement();
            return createElement('span', {
                className: 'gpo-editor-boolean',
                children: [
                    checkbox,
                    createElement('label', {
                        attrs: { 'for': controlId, 'aria-label': field.label || field.id }
                    })
                ]
            });
        }
        if (controlKind.indexOf('generated_') === 0) {
            input = createElement('div', {
                className: 'gpo-editor-field__generated',
                text: value.value === null || value.value === undefined ? '' : String(value.value)
            });
        } else if (value.kind === 'boolean') {
            input = checkboxControl(value.value);
        } else if (value.kind === 'optional_boolean') {
            checkboxValueKind = 'optional_boolean';
            input = checkboxControl(value.value === true);
        } else if (controlKind === 'optional_boolean_u8') {
            checkboxValueKind = 'optional_boolean_u8';
            input = checkboxControl(value.value === 1);
        } else if (value.kind === 'action') {
            input = createElement('select', {
                attrs: { disabled: disabled ? 'disabled' : null },
                children: ['create', 'replace', 'update', 'delete'].map(function(action) {
                    return createElement('option', { attrs: { value: action }, text: action });
                })
            });
            input.getElement().value = value.value;
        } else if (value.kind === 'filter_combine') {
            input = createElement('select', {
                attrs: { disabled: disabled ? 'disabled' : null },
                children: ['and', 'or'].map(function(combine) {
                    return createElement('option', { attrs: { value: combine }, text: combine.toUpperCase() });
                })
            });
            input.getElement().value = value.value;
        } else if (controlKind === 'choice') {
            input = createElement('select', {
                attrs: { disabled: disabled ? 'disabled' : null },
                children: (Array.isArray(field.choices) ? field.choices : []).map(function(choice) {
                    return createElement('option', {
                        attrs: { value: choice.key },
                        text: choice.label
                    });
                })
            });
            input.getElement().value = value.value;
        } else if (value.kind === 'text_list' || textarea) {
            input = createElement('textarea', {
                attrs: { disabled: disabled ? 'disabled' : null },
                text: Array.isArray(value.value) ? value.value.join('\n')
                    : (value.value === null || value.value === undefined ? '' : String(value.value))
            });
        } else if (value.kind === 'optional_text') {
            input = createElement('input', {
                attrs: {
                    type: 'text',
                    disabled: disabled ? 'disabled' : null,
                    value: value.value === null ? '' : value.value
                }
            });
        } else {
            var numeric = value.kind === 'integer' || value.kind === 'unsigned_byte' || value.kind === 'optional_unsigned_byte';
            input = createElement('input', {
                attrs: {
                    type: numeric ? 'number' : 'text',
                    min: value.kind.indexOf('unsigned') !== -1 ? 0 : null,
                    max: value.kind.indexOf('unsigned_byte') !== -1 ? 255 : null,
                    required: field.required ? 'required' : null,
                    disabled: disabled ? 'disabled' : null,
                    value: value.value === null || value.value === undefined ? '' : value.value
                }
            });
        }
        if (!inputElement) inputElement = input.getElement();
        var errorElement = createElement('span', { className: 'gpo-editor-field__error' });
        var dynamicDisabled = false;
        function applyBaselineToInput() {
            if (checkboxValueKind === 'optional_boolean_u8') {
                inputElement.checked = value.value === 1;
            } else if (checkboxValueKind === 'optional_boolean') {
                inputElement.checked = value.value === true;
            } else if (value.kind === 'boolean') {
                inputElement.checked = Boolean(value.value);
            } else if (Array.isArray(value.value)) {
                inputElement.value = value.value.join('\n');
            } else {
                inputElement.value = value.value === null || value.value === undefined
                    ? '' : value.value;
            }
            optionalBooleanTouched = false;
        }
        return {
            value: value,
            disabled: disabled,
            controlKind: controlKind,
            input: input,
            inputElement: inputElement,
            errorElement: errorElement,
            checkboxControlId: checkboxControlId,
            read: function() {
                if (disabled || dynamicDisabled
                        || controlKind.indexOf('generated_') === 0) return dto.clone(value);
                if (checkboxValueKind && value.value === null
                        && !materializeOptionalDefault && !optionalBooleanTouched) {
                    return dto.clone(value);
                }
                if (checkboxValueKind === 'optional_boolean_u8') {
                    return { kind: value.kind, value: inputElement.checked ? 1 : 0 };
                }
                if (checkboxValueKind === 'optional_boolean') {
                    return { kind: value.kind, value: Boolean(inputElement.checked) };
                }
                return dto.preferenceValueFromInput(value, inputElement.value, inputElement.checked);
            },
            setInputError: function(message) {
                if (inputElement && typeof inputElement.setAttribute === 'function') {
                    if (message) inputElement.setAttribute('aria-invalid', 'true');
                    else inputElement.removeAttribute('aria-invalid');
                }
                errorElement.setText(message || '');
            },
            setDynamicDisabled: function(nextDisabled) {
                if (controlKind.indexOf('generated_') === 0) return false;
                var next = Boolean(nextDisabled);
                if (next === dynamicDisabled) return false;
                dynamicDisabled = next;
                inputElement.disabled = Boolean(disabled || dynamicDisabled);
                if (dynamicDisabled) applyBaselineToInput();
                return true;
            },
            focus: function() {
                if (inputElement && typeof inputElement.focus === 'function') inputElement.focus();
            }
        };
    }

    function fieldControl(field, forceReadonly, materializeOptionalDefault, options) {
        var opts = options || {};
        var builder = buildControlInput(field, forceReadonly, materializeOptionalDefault, false);
        var wrapSelect = Boolean(opts.wrapSelect) && valueKindIsSelect(builder);
        var wrapCheckbox = Boolean(opts.wrapCheckbox) && builder.checkboxControlId !== null;
        var builderIsInput = builder.checkboxControlId === null
                && builder.inputElement.tagName === 'INPUT';
        var builderInputType = builderIsInput
                ? String(builder.inputElement.getAttribute('type') || '').toLowerCase()
                : '';
        var wrapText = builderIsInput
                && (builderInputType === 'number'
                        || (Boolean(opts.wrapText) && builderInputType === 'text'));
        var element;
        if (wrapCheckbox) {
            element = createElement('div', {
                className: [
                    'field',
                    'field__checkbox',
                    'gpo-editor-field',
                    builder.disabled ? 'gpo-editor-field--readonly' : null
                ],
                attrs: { 'data-field-id': field.id },
                children: [
                    createElement('div', {
                        className: 'field__label',
                        children: [
                            createElement('label', {
                                className: 'gpo-editor-field__label',
                                attrs: { 'for': builder.checkboxControlId },
                                children: [
                                    createElement('span', { text: field.label || field.id }),
                                    field.required ? createElement('span', {
                                        className: 'gpo-editor-field__required', text: '*'
                                    }) : null
                                ]
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'field__element',
                        children: [builder.input]
                    }),
                    builder.disabled ? createElement('span', {
                        className: 'gpo-editor-field__hint', text: pt('readonly')
                    }) : null,
                    builder.errorElement
                ]
            });
        } else if (wrapText) {
            element = createElement('div', {
                className: [
                    'field',
                    'field__input',
                    'gpo-editor-field',
                    builder.disabled ? 'gpo-editor-field--readonly' : null
                ],
                attrs: { 'data-field-id': field.id },
                children: [
                    createElement('div', {
                        className: 'field__label',
                        children: [
                            createElement('span', {
                                className: 'gpo-editor-field__label',
                                children: [
                                    createElement('span', { text: field.label || field.id }),
                                    field.required ? createElement('span', {
                                        className: 'gpo-editor-field__required', text: '*'
                                    }) : null
                                ]
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'field__element',
                        children: [builder.input, builder.errorElement]
                    }),
                    builder.disabled ? createElement('span', {
                        className: 'gpo-editor-field__hint', text: pt('readonly')
                    }) : null
                ]
            });
        } else {
            element = createElement('div', {
                className: [
                    'gpo-editor-field',
                    wrapSelect ? 'field' : null,
                    builder.disabled ? 'gpo-editor-field--readonly' : null
                ],
                attrs: { 'data-field-id': field.id },
                children: wrapSelect ? [
                    createElement('div', {
                        className: 'field__label',
                        children: [
                            createElement('span', {
                                className: 'gpo-editor-field__label',
                                children: [
                                    createElement('span', { text: field.label || field.id }),
                                    field.required ? createElement('span', {
                                        className: 'gpo-editor-field__required', text: '*'
                                    }) : null
                                ]
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'field__element',
                        children: [builder.input]
                    }),
                    builder.disabled ? createElement('span', {
                        className: 'gpo-editor-field__hint', text: pt('readonly')
                    }) : null,
                    builder.errorElement
                ] : [
                    createElement('span', {
                        className: 'gpo-editor-field__label',
                        children: [
                            createElement('span', { text: field.label || field.id }),
                            field.required ? createElement('span', {
                                className: 'gpo-editor-field__required', text: '*'
                            }) : null
                        ]
                    }),
                    builder.input,
                    builder.disabled ? createElement('span', {
                        className: 'gpo-editor-field__hint', text: pt('readonly')
                    }) : null,
                    builder.errorElement
                ]
            });
        }
        var lastError = '';
        function applyError(message) {
            lastError = message || '';
            element.getElement().classList.toggle('gpo-editor-field--error', Boolean(message));
            builder.setInputError(message);
        }
        if (!builder.disabled) {
            builder.inputElement.addEventListener('input', function() {
                if (lastError) applyError('');
            });
        }
        return {
            id: field.id,
            field: field,
            element: element,
            read: builder.read,
            setError: applyError,
            setDynamicDisabled: function(nextDisabled) {
                if (!builder.setDynamicDisabled(nextDisabled)) return false;
                element.getElement().classList.toggle(
                    'gpo-editor-field--readonly', Boolean(nextDisabled));
                if (nextDisabled) {
                    lastError = '';
                    element.getElement().classList.remove('gpo-editor-field--error');
                    builder.setInputError('');
                }
                return true;
            },
            focus: builder.focus
        };
    }

    function mockupFieldControl(field, forceReadonly, materializeOptionalDefault, options) {
        var opts = options || {};
        var builder = buildControlInput(field, forceReadonly, materializeOptionalDefault, Boolean(opts.textarea));
        var checkboxLike = builder.value.kind === 'boolean'
            || builder.value.kind === 'optional_boolean'
            || builder.controlKind === 'optional_boolean_u8';
        var element;
        if (checkboxLike) {
            element = createElement('div', {
                className: ['field', 'field__checkbox', builder.disabled ? 'field--readonly' : null],
                attrs: { 'data-field-id': field.id },
                children: [
                    createElement('label', {
                        children: [
                            builder.input,
                            createElement('span', {
                                className: 'field__label-checkbox',
                                text: field.label || field.id
                            })
                        ]
                    }),
                    builder.errorElement
                ]
            });
        } else {
            var fieldClasses = ['field', 'field__input'];
            if (opts.textarea) {
                fieldClasses.push('field__description', 'h-auto');
            } else if (builder.controlKind === 'directory_path' || builder.controlKind === 'file_path') {
                fieldClasses.push('field__input--path');
            } else if (valueKindIsSelect(builder)) {
                fieldClasses.push('select');
            }
            element = createElement('div', {
                className: fieldClasses,
                attrs: { 'data-field-id': field.id },
                children: [
                    createElement('div', {
                        className: 'field__label',
                        children: [
                            createElement('span', { text: field.label || field.id }),
                            field.required ? createElement('span', {
                                className: 'gpo-editor-field__required', text: '*'
                            }) : null
                        ]
                    }),
                    createElement('div', {
                        className: 'field__element',
                        children: [builder.input, builder.errorElement]
                    })
                ]
            });
        }
        var lastError = '';
        function applyError(message) {
            lastError = message || '';
            element.getElement().classList.toggle('gpo-editor-field--error', Boolean(message));
            builder.setInputError(message);
        }
        if (!builder.disabled) {
            builder.inputElement.addEventListener('input', function() {
                if (lastError) applyError('');
            });
        }
        return {
            id: field.id,
            field: field,
            element: element,
            read: builder.read,
            setError: applyError,
            setDynamicDisabled: function(nextDisabled) {
                if (!builder.setDynamicDisabled(nextDisabled)) return false;
                element.getElement().classList.toggle(
                    'field--readonly', Boolean(nextDisabled));
                if (nextDisabled) {
                    lastError = '';
                    element.getElement().classList.remove('gpo-editor-field--error');
                    builder.setInputError('');
                }
                return true;
            },
            focus: builder.focus
        };
    }

    function valueKindIsSelect(builder) {
        return builder.value.kind === 'action'
            || builder.value.kind === 'filter_combine'
            || builder.controlKind === 'choice';
    }

    function dependencyRulesFor(kind) {
        var layout = PREFERENCE_LAYOUTS[kind];
        return layout && Array.isArray(layout.dependencies) ? layout.dependencies : [];
    }

    function conditionTextValue(raw) {
        if (raw === null || raw === undefined) return '';
        if (Array.isArray(raw)) return raw.join('\n');
        return String(raw);
    }

    function conditionValueIsEmpty(raw) {
        if (raw === null || raw === undefined) return true;
        if (typeof raw === 'string') return raw.trim() === '';
        if (Array.isArray(raw)) return raw.length === 0;
        return false;
    }

    function conditionBooleanValue(raw) {
        return raw === true || raw === 1 || raw === 'true';
    }

    function conditionCompare(expected, raw) {
        if (expected === true) return conditionBooleanValue(raw);
        if (expected === false) return raw === false || raw === 0;
        return conditionTextValue(raw).toLowerCase()
            === conditionTextValue(expected).toLowerCase();
    }

    function conditionHolds(condition, readSource) {
        if (!condition) return true;
        if (condition.anyOf !== undefined) {
            return (Array.isArray(condition.anyOf) ? condition.anyOf : [])
                .some(function(nested) { return conditionHolds(nested, readSource); });
        }
        if (condition.suffix !== undefined) {
            return conditionTextValue(readSource(condition.source)).toLowerCase()
                .endsWith(String(condition.suffix).toLowerCase());
        }
        if (Object.prototype.hasOwnProperty.call(condition, 'nonEmpty')) {
            return Boolean(condition.nonEmpty) !== conditionValueIsEmpty(readSource(condition.source));
        }
        var raw = readSource(condition.source);
        if (condition.in !== undefined) {
            return (Array.isArray(condition.in) ? condition.in : [])
                .some(function(item) { return conditionCompare(item, raw); });
        }
        if (condition.notIn !== undefined) {
            return !(Array.isArray(condition.notIn) ? condition.notIn : [])
                .some(function(item) { return conditionCompare(item, raw); });
        }
        if (condition.equals !== undefined) {
            return conditionCompare(condition.equals, raw);
        }
        if (condition.notEquals !== undefined) {
            return !conditionCompare(condition.notEquals, raw);
        }
        return true;
    }

    function ruleEnabled(rule, readSource) {
        var conditions = Array.isArray(rule && rule.enabledWhen) ? rule.enabledWhen : [];
        return conditions.every(function(condition) {
            return conditionHolds(condition, readSource);
        });
    }

    function attachFieldDependencies(formElement, controlsById, rules) {
        var disabledIds = new Set();
        function sourceValue(fieldId) {
            var payload = null;
            (controlsById.get(fieldId) || []).forEach(function(control) {
                var current = control.read();
                if (current !== undefined) payload = dto.valuePayload(current);
            });
            return payload;
        }
        function sync() {
            var passes = Math.min(rules.length + 1, 12);
            for (var pass = 0; pass < passes; pass += 1) {
                var changed = false;
                var cache = new Map();
                var nextDisabled = [];
                var readSource = function(fieldId) {
                    if (!cache.has(fieldId)) cache.set(fieldId, sourceValue(fieldId));
                    return cache.get(fieldId);
                };
                rules.forEach(function(rule) {
                    if (!rule || !rule.field) return;
                    var enabled = ruleEnabled(rule, readSource);
                    if (!enabled) nextDisabled.push(rule.field);
                    (controlsById.get(rule.field) || []).forEach(function(control) {
                        if (control.setDynamicDisabled
                                && control.setDynamicDisabled(!enabled)) {
                            changed = true;
                        }
                    });
                });
                disabledIds.clear();
                nextDisabled.forEach(function(id) { disabledIds.add(id); });
                if (!changed) break;
            }
        }
        formElement.addEventListener('input', sync);
        formElement.addEventListener('change', sync);
        return { sync: sync, disabledIds: disabledIds };
    }

    function buildPlaceholderCheckbox(entry) {
        var label = (entry && entry.label)
            || (entry && entry.labelKey ? pt(entry.labelKey) : '');
        var controlId = 'gpo-preference-field-' + nextFieldControlId++;
        var checkbox = createElement('input', {
            attrs: {
                id: controlId,
                type: 'checkbox',
                disabled: 'disabled'
            }
        });
        return createElement('div', {
            className: ['field', 'field__checkbox', 'field--readonly'],
            children: [
                createElement('label', {
                    children: [
                        createElement('span', {
                            className: 'gpo-editor-boolean',
                            children: [
                                checkbox,
                                createElement('label', {
                                    attrs: { 'for': controlId, 'aria-label': label }
                                })
                            ]
                        }),
                        createElement('span', {
                            className: 'field__label-checkbox',
                            text: label
                        })
                    ]
                })
            ]
        });
    }

    function isMetadataField(field) {
        return String(field && field.id || '').indexOf('metadata.') === 0;
    }

    function isGeneralTabField(field) {
        return isMetadataField(field)
            || (Boolean(field) && field.id === 'properties.disabled');
    }

    function isBasicTabField(field) {
        return !isGeneralTabField(field);
    }

    function orderedTabEntries(fields, layoutEntries, predicate) {
        var layout = Array.isArray(layoutEntries) ? layoutEntries : [];
        var belongs = typeof predicate === 'function' ? predicate : function() { return true; };
        var result = [];
        var placed = {};
        layout.forEach(function(entry) {
            var item = dto.clone(entry || {});
            if (!item.field) {
                if (item.line) result.push({ line: true });
                if (item.placeholder) result.push(item);
                return;
            }
            var field = fields.find(function(candidate) { return candidate.id === item.field; });
            if (!field || !belongs(field)) return;
            placed[item.field] = true;
            result.push(item);
        });
        fields.forEach(function(field) {
            if (placed[field.id] || !belongs(field)) return;
            result.push({ field: field.id });
        });
        return result;
    }

    function buildFieldTabs(fields, options) {
        var opts = options || {};
        var layout = opts.layout || null;
        var fieldsById = new Map();
        fields.forEach(function(field) { fieldsById.set(field.id, field); });
        var basicEntries = orderedTabEntries(fields, layout ? layout.basic : null, isBasicTabField);
        var generalEntries = orderedTabEntries(fields, layout ? layout.general : null, isGeneralTabField);
        var fieldOptions = {};
        basicEntries.concat(generalEntries).forEach(function(entry) {
            if (entry && entry.field && !fieldOptions[entry.field]) fieldOptions[entry.field] = entry;
        });

        fields.forEach(function(field) {
            var control;
            if (field.hidden) {
                control = hiddenFieldControl(field);
            } else if (layout) {
                control = mockupFieldControl(field, opts.readonly, opts.creating, fieldOptions[field.id] || {});
            } else {
                control = fieldControl(field, opts.readonly, opts.creating);
            }
            opts.controls.push(control);
            if (!opts.controlsById.has(field.id)) opts.controlsById.set(field.id, []);
            opts.controlsById.get(field.id).push(control);
        });

        function renderable(entries) {
            return entries.some(function(entry) {
                if (entry.placeholder) return true;
                if (!entry.field) return false;
                var field = fieldsById.get(entry.field);
                return Boolean(field && !field.hidden);
            });
        }

        var basicHasFields = renderable(basicEntries);
        var generalHasFields = renderable(generalEntries);
        if (!basicHasFields && !generalHasFields) return null;

        function buildContent(entries) {
            var content = createElement('div', { className: 'tab-content' });
            entries.forEach(function(entry) {
                if (entry.line) {
                    content.append(createElement('div', { className: 'field__line' }));
                    return;
                }
                if (entry.placeholder) {
                    content.append(buildPlaceholderCheckbox(entry));
                    return;
                }
                if (!entry.field) return;
                (opts.controlsById.get(entry.field) || []).forEach(function(control) {
                    if (control.element) content.append(control.element);
                });
            });
            return content;
        }

        var basicContent = buildContent(basicEntries);
        var generalContent = buildContent(generalEntries);
        basicContent.getElement().id = 'tab-basic';
        generalContent.getElement().id = 'tab-general';
        var activeTab = basicHasFields ? 'tab-basic' : 'tab-general';
        if (activeTab === 'tab-basic') basicContent.getElement().classList.add('active');
        else generalContent.getElement().classList.add('active');

        var tabs = createElement('div', { className: 'preference__modal-tabs' });
        var buttons = createElement('div', { className: 'tab-buttons' });
        [
            { id: 'tab-basic', enabled: basicHasFields, label: pt('tabBasic') },
            { id: 'tab-general', enabled: generalHasFields, label: pt('tabGeneral') }
        ].forEach(function(spec) {
            if (!spec.enabled) return;
            buttons.append(createElement('div', {
                className: ['preference__tab-button', activeTab === spec.id ? 'active' : null],
                attrs: { 'data-tab': spec.id },
                text: spec.label,
                events: { click: function() { activateTab(spec.id); } }
            }));
        });
        tabs.append(buttons);
        tabs.append(basicContent);
        tabs.append(generalContent);

        var filtersTab = opts.layout
            ? (opts.layout.filters === 'basic' ? 'tab-basic'
                : opts.layout.filters === 'general' ? 'tab-general' : null)
            : null;
        tabs.filtersSlot = filtersTab === 'tab-basic' && basicHasFields ? basicContent
            : filtersTab === 'tab-general' && generalHasFields ? generalContent
            : null;

        function activateTab(id) {
            Array.prototype.forEach.call(tabs.getElement().querySelectorAll('.preference__tab-button'),
                function(button) {
                    button.classList.toggle('active', button.getAttribute('data-tab') === id);
                });
            Array.prototype.forEach.call(tabs.getElement().querySelectorAll('.tab-content'),
                function(content) {
                    content.classList.toggle('active', content.id === id);
                });
        }

        return tabs;
    }

    function editableFields(controls, baseline, changedOnly) {
        var result = [];
        controls.forEach(function(control, id) {
            var field = baseline.get(id);
            if (!field || !field.editable) return;
            var value = control.read();
            if (!changedOnly || !dto.equal(value, field.value)) result.push({ id: id, value: value });
        });
        return result;
    }


    function filterKey(path) { return JSON.stringify(path || []); }

    async function renderPreferencesTemplate(options) {
        var config = options || {};
        var item = config.item || {};
        var documentDto = item.document || {};
        var root = createElement('div', {
            className: ['gp__preference', 'gpo-editor-preferences']
        });
        var rootElement = root.getElement();
        var headerElement = config.header && config.header.getElement ? config.header.getElement() : null;
        var headerControls = headerElement ? headerElement.querySelector('.gp__control') : null;
        var headerActions = headerElement ? headerElement.querySelector('.gp__control-actions') : null;
        var admxActions = headerElement ? headerElement.querySelector('.gp__control-admx') : null;
        var helpSeparator = headerElement ? headerElement.querySelector('.gp__control-separator') : null;
        var createButton = headerControls ? headerControls.querySelector('.preferences__btn-create') : null;
        var editButton = headerControls ? headerControls.querySelector('.preferences__btn-edit') : null;
        var deleteButton = headerControls ? headerControls.querySelector('.preferences__btn-delete') : null;
        var headerOwner = 'preferences-' + nextHeaderOwnerId++;
        var items = [];
        var selectedIdentity = null;
        var modalState = null;
        var opening = false;
        var pendingDiscard = null;
        var discardModal = null;
        var cleanups = [];
        var formRequestId = 0;
        var itemsRequestId = 0;
        var infoRequestId = 0;
        var itemFieldsCache = new Map();
        var fieldsRequestId = 0;
        var tableRefreshScheduled = false;
        var deleting = false;
        var disposed = false;
        var tableNavigation;

        if (headerControls) {
            headerControls.setAttribute('data-preference-owner', headerOwner);
            headerControls.style.display = documentDto.editable ? 'flex' : 'none';
        }
        if (headerActions) {
            headerActions.setAttribute('data-preference-owner', headerOwner);
            headerActions.style.display = 'flex';
        }
        if (admxActions) admxActions.style.display = 'none';
        if (helpSeparator) helpSeparator.style.display = 'none';

        function ownsHeader() {
            return Boolean(headerControls
                && headerControls.getAttribute('data-preference-owner') === headerOwner);
        }

        function setHeaderState() {
            if (typeof config.onFormStateChange === 'function') config.onFormStateChange(Boolean(modalState));
            if (!ownsHeader()) return;
            var editable = Boolean(documentDto.editable);
            var available = editable && !modalState && !opening && !deleting;
            if (createButton) createButton.classList.toggle('active', available);
            if (editButton) editButton.classList.toggle('active', available && selectedIdentity !== null);
            if (deleteButton) deleteButton.classList.toggle('active', available && selectedIdentity !== null);
        }

        function setOpening(value) {
            opening = Boolean(value);
            rootElement.classList.toggle('gpo-editor-preferences--opening', opening);
            if (opening) rootElement.setAttribute('aria-busy', 'true');
            else rootElement.removeAttribute('aria-busy');
            Array.prototype.forEach.call(
                rootElement.querySelectorAll('.gpo-editor-preference-table__actions button'),
                function(button) { button.disabled = opening; }
            );
            setHeaderState();
        }

        function addListener(target, name, handler) {
            if (!target) return;
            target.addEventListener(name, handler);
            cleanups.push(function() { target.removeEventListener(name, handler); });
        }

        function recoveryConflict(response) {
            var recovery = response && response.recovery;
            if (!recovery || recovery.kind !== 'conflict') return null;
            var error = new Error('Preference publication reconciliation is still conflicted.');
            error.category = 'publication_conflict';
            error.details = recovery.conflict || null;
            return error;
        }

        async function reconcilePage(event) {
            if (event && event.currentTarget) event.currentTarget.disabled = true;
            try {
                var response = await API.reconcile();
                var conflict = recoveryConflict(response);
                if (conflict) throw conflict;
                await loadItems();
            } catch (error) {
                showPageError(error);
            } finally {
                if (event && event.currentTarget) event.currentTarget.disabled = false;
            }
        }

        function showPageError(error) {
            var slot = rootElement.querySelector('.gpo-editor-preferences__error');
            if (!slot) return;
            slot.innerHTML = '';
            slot.appendChild(editorStatus.renderError(error, {
                onRefresh: loadItems,
                onReconcile: reconcilePage
            }).getElement());
        }

        function renderTable() {
            var tableSlot = rootElement.querySelector('.gpo-editor-preferences__table');
            if (!tableSlot) return;
            var heldFocus = tableSlot.contains(document.activeElement);
            tableSlot.innerHTML = '';
            if (!items.length) {
                tableSlot.appendChild(createElement('div', {
                    className: 'gpo-editor-empty', text: pt('emptyItems')
                }).getElement());
                if (tableNavigation) { tableNavigation.sync(); if (heldFocus) tableNavigation.focusSelected(); }
                return;
            }
            var columns = tableColumns(item.preferenceKind);
            var useTemplate = Boolean(columns);
            var headerCells = useTemplate
                ? columns.map(function(column) {
                    return createElement('th', { text: pt(column.labelKey) });
                })
                : [
                    createElement('th', { text: pt('itemColumn') }),
                    createElement('th', { text: pt('filtersColumn') }),
                    createElement('th', { text: pt('actionsColumn') })
                ];

            function buildDataCells(preferenceItem, index) {
                if (!useTemplate) {
                    return [
                        createElement('td', { text: preferenceItem.label }),
                        createElement('td', { text: preferenceItem.has_filters ? pt('yes') : pt('no') })
                    ];
                }
                return columns.map(function(column) {
                    var text = '';
                    if (column.source === 'name') {
                        text = preferenceItem.label;
                    } else if (column.source === 'order') {
                        text = String(index + 1);
                    } else if (column.source === 'field') {
                        var value = cachedFieldValue(preferenceItem.identity, column.field);
                        text = column.format === 'action'
                            ? actionLabel(value)
                            : (value === null || value === undefined ? '' : String(value));
                    }
                    return createElement('td', { text: text });
                });
            }

            function buildActionsCell(preferenceItem) {
                return createElement('td', {
                    className: 'gpo-editor-preference-table__actions',
                    children: [createElement('button', {
                        className: 'button',
                        attrs: {
                            type: 'button',
                            disabled: opening ? 'disabled' : null
                        },
                        text: documentDto.editable ? t('header.edit') : pt('viewTitle'),
                        events: { click: function(event) {
                            event.stopPropagation();
                            selectItem(preferenceItem.identity);
                            void openForm(selectedIdentity);
                        } }
                    })]
                });
            }

            var bodyRows = items.map(function(preferenceItem, index) {
                var selected = selectedIdentity !== null && dto.equal(selectedIdentity, preferenceItem.identity);
                var cells = buildDataCells(preferenceItem, index);
                if (!useTemplate) cells.push(buildActionsCell(preferenceItem));
                var row = createElement('tr', {
                    className: selected ? 'active' : null,
                    attrs: { tabindex: '-1', 'data-preference-identity': cacheKey(preferenceItem.identity),
                        'aria-selected': selected ? 'true' : 'false' },
                    children: cells,
                    events: {
                        click: function() {
                            selectItem(preferenceItem.identity);
                            if (tableNavigation) tableNavigation.focusSelected();
                        },
                        dblclick: function() {
                            if (modalState || opening || deleting) return;
                            selectItem(preferenceItem.identity);
                            void openForm(selectedIdentity);
                        }
                    }
                });
                row.getElement().__preferenceIdentity = preferenceItem.identity;
                return row;
            });

            var table = createElement('table', {
                className: ['preference__table', 'gpo-catalog-table'],
                children: [
                    createElement('thead', { children: [createElement('tr', { children: headerCells })] }),
                    createElement('tbody', { children: bodyRows })
                ]
            });
            tableSlot.appendChild(table.getElement());
            if (tableNavigation) { tableNavigation.sync(); if (heldFocus) tableNavigation.focusSelected(); }
        }

        function selectItem(identity) {
            selectedIdentity = dto.clone(identity);
            Array.prototype.forEach.call(rootElement.querySelectorAll('[data-preference-identity]'), function(row) {
                var selected = dto.equal(row.__preferenceIdentity, selectedIdentity);
                row.classList.toggle('active', selected);
                row.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
            if (tableNavigation) tableNavigation.sync();
            setHeaderState();
            void requestInfoPanel(selectedIdentity);
        }

        function focusTable() {
            if (!disposed && (typeof config.isCurrent !== 'function' || config.isCurrent()) && tableNavigation) {
                tableNavigation.focusSelected();
            }
        }

        function cacheKey(identity) {
            return JSON.stringify(identity);
        }

        function cachedFieldValue(identity, fieldId) {
            var fields = itemFieldsCache.get(cacheKey(identity));
            if (!fields) return '';
            return itemFieldValue({ fields: fields }, fieldId);
        }

        function scheduleTableRefresh() {
            if (tableRefreshScheduled) return;
            tableRefreshScheduled = true;
            var run = function() {
                tableRefreshScheduled = false;
                if (typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                renderTable();
            };
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(run);
            } else {
                setTimeout(run, 16);
            }
        }

        function ensureItemFields(identity) {
            var key = cacheKey(identity);
            if (itemFieldsCache.has(key)) {
                return Promise.resolve(itemFieldsCache.get(key));
            }
            var startedGeneration = fieldsRequestId;
            return API.preferenceShow(item.scope, item.preferenceKind, dto.clone(identity)).then(function(response) {
                if (startedGeneration !== fieldsRequestId) return null;
                var fields = dto.clone(response.fields || response.new_item_fields || []).map(function(field) {
                    return scopeField(field, item.scope);
                });
                itemFieldsCache.set(key, fields);
                return fields;
            });
        }

        function prefetchTableFields() {
            var generation = ++fieldsRequestId;
            items.forEach(function(preferenceItem) {
                if (preferenceItem.identity === null || preferenceItem.identity === undefined) return;
                if (itemFieldsCache.has(cacheKey(preferenceItem.identity))) return;
                void ensureItemFields(preferenceItem.identity).then(function(fields) {
                    if (!fields) return;
                    if (generation !== fieldsRequestId) return;
                    if (typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                    scheduleTableRefresh();
                });
            });
        }

        function invalidateCachedFields(identity) {
            itemFieldsCache.delete(cacheKey(identity));
            fieldsRequestId += 1;
        }

        async function loadItems() {
            var requestId = ++itemsRequestId;
            try {
                var response = await API.preferenceItems(item.scope, item.preferenceKind);
                if (requestId !== itemsRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                items = listFrom(response, 'items');
                if (selectedIdentity !== null && !items.some(function(entry) {
                    return dto.equal(entry.identity, selectedIdentity);
                })) selectedIdentity = null;
                var errorSlot = rootElement.querySelector('.gpo-editor-preferences__error');
                if (errorSlot) errorSlot.innerHTML = '';
                renderTable();
                setHeaderState();
                void prefetchTableFields();
                if (selectedIdentity !== null) {
                    void requestInfoPanel(selectedIdentity);
                } else {
                    resetInfoPanel();
                }
            } catch (error) {
                if (requestId !== itemsRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                showPageError(error);
            }
        }

        function buildInfoPanel() {
            var info = createElement('div', {
                className: ['preference__info', config.isHelpOpen ? 'is-open' : null]
            });
            var settings = createElement('div', { className: 'preference__settings' });
            settings.append(createElement('div', {
                className: 'preference__settings-title',
                text: pt('settingsTitle')
            }));
            settings.append(createElement('div', { className: 'preference__settings-data' }));
            info.append(settings);
            var description = createElement('div', { className: 'preference__description' });
            description.append(createElement('div', {
                className: 'preference__description-title',
                text: pt('descriptionTitle')
            }));
            description.append(createElement('div', {
                className: ['preference__description-data', 'empty'],
                text: pt('noDescription')
            }));
            info.append(description);
            return info;
        }

        function settingsItems() {
            return [
                { id: 'metadata.bypassErrors', label: pt('settingBypassErrors') },
                { id: 'metadata.removePolicy', label: pt('settingRemovePolicy') },
                { id: 'properties.disabled', label: pt('settingDisabled') }
            ];
        }

        function fieldCheckedState(field) {
            var v = field && field.value;
            var raw = v && typeof v === 'object' ? v.value : v;
            if (raw === null || raw === undefined) return null;
            if (raw === true || raw === 1) return true;
            if (raw === false || raw === 0) return false;
            return Boolean(raw);
        }

        function fieldText(field) {
            var v = field && field.value;
            var raw = v && typeof v === 'object' ? v.value : v;
            if (Array.isArray(raw)) return raw.join('\n');
            return raw === null || raw === undefined ? '' : String(raw);
        }

        function renderInfoPanel(fields) {
            var dataSlot = rootElement.querySelector('.preference__settings-data');
            var descSlot = rootElement.querySelector('.preference__description-data');
            if (!dataSlot || !descSlot) return;
            var byId = new Map();
            (Array.isArray(fields) ? fields : []).forEach(function(field) {
                if (field && field.id !== undefined && !byId.has(field.id)) byId.set(field.id, field);
            });
            dataSlot.innerHTML = '';
            settingsItems().forEach(function(spec) {
                var field = byId.get(spec.id);
                var label = (field && field.label) || spec.label;
                var value = fieldCheckedState(field);
                dataSlot.appendChild(createElement('div', {
                    className: 'preference__settings-item',
                    children: [
                        createElement('div', { className: 'preference__settings-name', text: label + ':' }),
                        createElement('div', {
                            className: 'preference__settings-value',
                            text: value === null ? '' : (value ? pt('yes') : pt('no'))
                        })
                    ]
                }).getElement());
            });
            var descField = byId.get('metadata.desc');
            var descText = fieldText(descField);
            descSlot.innerHTML = '';
            if (descText) {
                descSlot.classList.remove('empty');
                descSlot.textContent = descText;
            } else {
                descSlot.classList.add('empty');
                descSlot.textContent = pt('noDescription');
            }
        }

        function resetInfoPanel() {
            renderInfoPanel([]);
        }

        async function requestInfoPanel(identity) {
            var requestId = ++infoRequestId;
            try {
                var fields = await ensureItemFields(identity);
                if (requestId !== infoRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                if (fields) renderInfoPanel(fields);
                else resetInfoPanel();
            } catch (error) {
                if (requestId !== infoRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                resetInfoPanel();
            }
        }

        function renderShell() {
            rootElement.innerHTML = '';
            var dataTable = createElement('div', { className: 'preference__data-table' });
            dataTable.append(createElement('div', {
                className: 'gpo-editor-preferences__header',
                children: [
                    config.hideHeading ? null : createElement('h2', { text: config.categoryPath || documentDto.label || item.preferenceKind,
                        attrs: { 'data-category-path': '' } }),
                    createElement('div', {
                        className: ['gpo-editor-document-state', documentDto.editable ? null : 'gpo-editor-document-state--readonly'],
                        text: documentDto.editable ? pt('documentEditable') : pt('documentReadOnly')
                    })
                ]
            }));
            dataTable.append(createElement('div', { className: 'gpo-editor-preferences__error' }));
            dataTable.append(createElement('div', { className: 'gpo-editor-preferences__table' }));
            if (!config.modalHost) dataTable.append(createElement('div', { className: 'gpo-editor-preferences__modal-host' }));
            rootElement.appendChild(dataTable.getElement());
            rootElement.appendChild(buildInfoPanel().getElement());
            resetInfoPanel();
        }

        function buildFilterEditor(showResult, formState, readonly) {
            return targetingEditor.render({
                showResult: showResult,
                formState: formState,
                readonly: readonly,
                scope: item.scope,
                language: translations.getLanguage(),
                pt: pt,
                fieldControl: fieldControl,
                validationMessage: validationMessage
            });
        }

        async function openForm(identity) {
            var creating = identity === null || identity === undefined;
            if (creating && !documentDto.editable) return;
            if (opening) return false;
            if (modalState && !closeForm(false, 'close')) return;
            var host = config.modalHost || rootElement.querySelector('.gpo-editor-preferences__modal-host');
            if (!host) return;
            var requestId = ++formRequestId;
            setOpening(true);
            try {
                var response = await API.preferenceShow(item.scope, item.preferenceKind, identity);
                if (requestId !== formRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                var readonly = !documentDto.editable;
                var fields = dto.clone(creating
                    ? (response.new_item_fields || response.fields || [])
                    : (response.fields || [])).map(function(field) {
                        return scopeField(field, item.scope);
                    });
                if (!creating) {
                    infoRequestId += 1;
                    renderInfoPanel(fields);
                }
                var parentCandidates = creating && Array.isArray(response.parent_candidates)
                    ? dto.clone(response.parent_candidates) : [];
                var controls = [];
                var controlsById = new Map();
                var fieldTabs = buildFieldTabs(fields, {
                    controls: controls,
                    controlsById: controlsById,
                    readonly: readonly,
                    creating: creating,
                    layout: PREFERENCE_LAYOUTS[item.preferenceKind] || null
                });
                var formState = {
                    dirty: false,
                    busy: false,
                    readFilterResult: function() { return { operations: [], errors: [] }; }
                };
                var errorSlot = createElement('div', { className: 'gpo-editor-preference-form__error' });
                var validationSlot = createElement('div', {
                    className: 'gpo-editor-preference-form__validation',
                    attrs: { role: 'alert' }
                });
                var originalName = response.item && response.item.label !== undefined
                    ? String(response.item.label) : '';
                var nameInput = null;
                var nameField = null;
                var nameError = null;
                var parentSelect = null;
                var parentField = null;
                if (!creating) {
                    nameInput = createElement('input', {
                        attrs: {
                            type: 'text',
                            value: originalName,
                            required: 'required',
                            disabled: readonly ? 'disabled' : null
                        }
                    });
                    nameError = createElement('span', { className: 'gpo-editor-field__error' });
                    nameField = createElement('div', {
                        className: ['field', 'field__input', readonly ? 'field--readonly' : null],
                        attrs: { 'data-field-id': 'name' },
                        children: [
                            createElement('div', {
                                className: 'field__label',
                                children: [
                                    createElement('span', { text: pt('rename') }),
                                    createElement('span', { className: 'gpo-editor-field__required', text: '*' })
                                ]
                            }),
                            createElement('div', {
                                className: 'field__element',
                                children: [nameInput, nameError]
                            })
                        ]
                    });
                }
                if (creating && parentCandidates.length > 1) {
                    parentSelect = createElement('select', {
                        attrs: { 'aria-label': pt('parent') },
                        children: parentCandidates.map(function(candidate, index) {
                            return createElement('option', {
                                attrs: { value: String(index) },
                                text: parentCandidateLabel(candidate)
                            });
                        })
                    });
                    var rootParentIndex = parentCandidates.findIndex(function(candidate) {
                        return candidate && candidate.identity === null;
                    });
                    parentSelect.getElement().value = String(
                        rootParentIndex < 0 ? 0 : rootParentIndex
                    );
                    parentField = createElement('label', {
                        className: ['gpo-editor-field', 'gpo-editor-preference-parent'],
                        attrs: { 'data-field-id': 'parent' },
                        children: [
                            createElement('span', {
                                className: 'gpo-editor-field__label',
                                text: pt('parent')
                            }),
                            parentSelect
                        ]
                    });
                }
                var saveButton = readonly ? null : createElement('button', {
                    className: ['button', 'btn-ok'],
                    attrs: { type: 'button' },
                    text: pt('save'),
                    events: { click: function() { void saveForm(); } }
                });
                var closeAction = function() { closeForm(false, 'close'); };
                var cancelAction = function() { closeForm(false, 'cancel'); };
                var filterSection = createElement('div', { className: 'preference__modal-filters' });
                filterSection.append(buildFilterEditor(response, formState, readonly));
                var targettingModalElement = null;
                var closeTargettingModal = function(accept) {
                    if (accept && !readonly && !formState.acceptFilterDraft()) return;
                    if (!accept) formState.cancelFilterDraft();
                    if (targettingModalElement) {
                        targettingModalElement.classList.remove('active');
                        targettingModalElement.inert = true;
                    }
                    form.getElement().classList.remove('dimmed');
                    form.getElement().inert = false;
                    if (targettingButton) targettingButton.getElement().focus();
                };
                var buildTargettingModal = function() {
                    if (targettingModalElement) return targettingModalElement;
                    targettingModalElement = createElement('div', {
                        className: [
                            'targetting__modal', 'preference__modal',
                            readonly ? 'preference__modal--readonly' : null
                        ],
                        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': pt('targettingTitle'), tabindex: '-1' },
                        children: [createElement('div', {
                            className: 'preference__modal-wrapper',
                            children: [
                                createElement('div', {
                                    className: 'preference__modal-header',
                                    children: [
                                        createElement('div', {
                                            className: 'title',
                                            text: pt('targettingTitle')
                                        }),
                                        createElement('button', {
                                            className: 'close',
                                            attrs: { type: 'button', 'aria-label': pt('close') },
                                            events: { click: function() { closeTargettingModal(false); } }
                                        })
                                    ]
                                }),
                                createElement('div', {
                                    className: 'preference__modal-content',
                                    children: [filterSection]
                                }),
                                createElement('div', {
                                    className: 'preference__modal-footer',
                                    children: readonly ? [
                                        createElement('button', {
                                            className: ['button', 'btn-cancel'],
                                            attrs: { type: 'button' },
                                            text: pt('close'),
                                            events: { click: function() { closeTargettingModal(false); } }
                                        })
                                    ] : [
                                        createElement('button', {
                                            className: ['button', 'btn-cancel'],
                                            attrs: { type: 'button' },
                                            text: pt('cancel'),
                                            events: { click: function() { closeTargettingModal(false); } }
                                        }),
                                        createElement('button', {
                                            className: ['button', 'btn-ok'],
                                            attrs: { type: 'button' },
                                            text: pt('targetingOk'),
                                            events: { click: function() { closeTargettingModal(true); } }
                                        })
                                    ]
                                })
                            ]
                        })]
                    }).getElement();
                    targettingModalElement.addEventListener('keydown', function(event) {
                        if (event.defaultPrevented || event.target.closest('[role="dialog"], [role="alertdialog"]') !== targettingModalElement) return;
                        if (event.key === 'Escape' && !event.defaultPrevented) {
                            event.preventDefault(); closeTargettingModal(false);
                        }
                        editorDialog.trapTab(event, targettingModalElement);
                    });
                    targettingModalElement.inert = true;
                    return targettingModalElement;
                };
                var buildModalContent = function() {
                    var content = createElement('div', { className: 'preference__modal-content' });
                    content.append(validationSlot);
                    content.append(errorSlot);
                    content.append(createElement('div', { className: 'gpo-editor-fields' }));
                    if (fieldTabs) content.append(fieldTabs);
                    return content;
                };
                var form = createElement('div', {
                    className: [
                        'preference__modal', 'gpo-editor-preference-form',
                        readonly ? 'preference__modal--readonly' : null
                    ],
                    attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
                        'aria-label': creating ? pt('createTitle') : (readonly ? pt('viewTitle') : pt('editTitle')) },
                    events: { keydown: function(event) {
                        if (event.defaultPrevented || event.target.closest('[role="dialog"], [role="alertdialog"]') !== form.getElement()) return;
                        if (event.key === 'Escape') {
                            event.preventDefault(); event.stopPropagation(); closeAction();
                        }
                        editorDialog.trapTab(event, form.getElement());
                    } },
                    children: [createElement('div', {
                        className: 'preference__modal-wrapper',
                        children: [
                            createElement('div', {
                                className: 'preference__modal-header',
                                children: [
                                    createElement('div', {
                                        className: 'title',
                                        text: creating ? pt('createTitle')
                                            : (readonly ? pt('viewTitle') : pt('editTitle'))
                                    }),
                                    createElement('button', {
                                        className: 'close',
                                        attrs: { type: 'button', 'aria-label': pt('close') },
                                        events: { click: closeAction }
                                    })
                                ]
                            }),
                            buildModalContent(),
                            createElement('div', {
                                className: 'preference__modal-footer',
                                children: readonly ? [
                                    createElement('button', {
                                        className: ['button', 'btn-cancel'],
                                        attrs: { type: 'button' },
                                        text: pt('close'),
                                        events: { click: closeAction }
                                    })
                                ] : [
                                    createElement('button', {
                                        className: ['button', 'btn-cancel'],
                                        attrs: { type: 'button' },
                                        text: pt('cancel'),
                                        events: { click: cancelAction }
                                    }),
                                    saveButton
                                ]
                            })
                        ]
                    })]
                });
                var fieldSlot = form.getElement().querySelector('.gpo-editor-fields');
                if (nameField) {
                    var basicTab = form.getElement().querySelector('#tab-basic');
                    var targetTypeField = basicTab
                        && basicTab.querySelector('[data-field-id="properties.targetType"]');
                    if (targetTypeField && targetTypeField.parentNode) {
                        targetTypeField.parentNode.insertBefore(
                            nameField.getElement(), targetTypeField);
                    } else if (basicTab) {
                        basicTab.insertBefore(nameField.getElement(), basicTab.firstChild);
                    } else if (fieldSlot) {
                        fieldSlot.appendChild(nameField.getElement());
                    }
                }
                if (parentField && fieldSlot) fieldSlot.appendChild(parentField.getElement());
                var targettingButton = createElement('button', {
                    className: ['button', 'preference__tab-targetting-btn'],
                    attrs: { type: 'button' },
                    text: pt('targettingButton'),
                    events: {
                        click: function() {
                            if (formState.busy) return;
                            formState.beginFilterDraft();
                            var modal = buildTargettingModal();
                            if (!modal.parentNode) host.appendChild(modal);
                            void modal.offsetHeight;
                            modal.inert = false;
                            modal.classList.add('active');
                            form.getElement().classList.add('dimmed');
                            form.getElement().inert = true;
                            var first = modal.querySelector('.gpo-editor-filter-add:not(:disabled), [role="treeitem"], .btn-cancel');
                            if (first) first.focus();
                            else modal.focus();
                        }
                    }
                });
                var generalTabElement = form.getElement().querySelector('#tab-general');
                var descriptionField = generalTabElement
                    && generalTabElement.querySelector('[data-field-id="metadata.desc"]');
                if (generalTabElement && descriptionField && descriptionField.parentNode) {
                    descriptionField.parentNode.insertBefore(
                        targettingButton.getElement(), descriptionField);
                } else if (generalTabElement) {
                    generalTabElement.appendChild(targettingButton.getElement());
                } else {
                    var formContentSlot = form.getElement().querySelector('.preference__modal-content');
                    if (formContentSlot) formContentSlot.appendChild(targettingButton.getElement());
                }
                if (!readonly) {
                    form.getElement().addEventListener('input', function() {
                        if (!formState.busy) formState.dirty = true;
                    });
                    form.getElement().addEventListener('change', function() {
                        if (!formState.busy) formState.dirty = true;
                    });
                }
                host.innerHTML = '';
                host.appendChild(form.getElement());
                host.classList.add('active');
                void form.getElement().offsetHeight;
                form.getElement().classList.add('active');
                modalState = {
                    creating: creating,
                    readonly: readonly,
                    identity: dto.clone(identity),
                    descriptors: fields,
                    controls: controls,
                    controlsById: controlsById,
                    originalName: originalName,
                    nameInput: nameInput && nameInput.getElement(),
                    nameField: nameField && nameField.getElement(),
                    nameError: nameError && nameError.getElement(),
                    parentCandidates: parentCandidates,
                    parentSelect: parentSelect && parentSelect.getElement(),
                    formState: formState,
                    formElement: form.getElement(),
                    validationSlot: validationSlot.getElement(),
                    errorSlot: errorSlot.getElement(),
                    saveButton: saveButton && saveButton.getElement(),
                    closeButtons: [
                        form.getElement().querySelector('.close'),
                        form.getElement().querySelector('.btn-cancel')
                    ].filter(Boolean),
                    busyDisabledStates: new Map(),
                    saving: false,
                    reconciling: false,
                    requiresRefresh: false,
                    blockedDescriptors: false
                };
                if (modalState.nameInput && !readonly) {
                    modalState.nameInput.addEventListener('input', function() {
                        if (modalState.nameError.textContent) setNameError(modalState, '');
                    });
                }
                var duplicates = dto.preferenceFieldIds(fields).duplicates;
                if (!readonly && duplicates.length) {
                    modalState.blockedDescriptors = true;
                    modalState.formElement.classList.add('gpo-editor-preference-form--invalid');
                    modalState.validationSlot.textContent = pt('validationFixErrors');
                    duplicates.forEach(function(id) {
                        (controlsById.get(id) || []).forEach(function(control) {
                            control.setError(pt('validationFixErrors'));
                        });
                    });
                }
                var dependencyRules = dependencyRulesFor(item.preferenceKind);
                if (dependencyRules.length && !readonly) {
                    var dependencies = attachFieldDependencies(
                        modalState.formElement, controlsById, dependencyRules);
                    modalState.dependencyDisabledIds = dependencies.disabledIds;
                    dependencies.sync();
                }
                syncFormBusy(modalState);
                setHeaderState();
            } catch (error) {
                if (requestId === formRequestId) showPageError(error);
            } finally {
                if (requestId === formRequestId) setOpening(false);
            }
        }

        function showDiscardModal(action) {
            if (discardModal) return;
            pendingDiscard = { action: action };
            if (modalState && modalState.formElement) {
                modalState.formElement.classList.add('gpo-editor-preference-form--confirming');
                if (modalState.formElement.parentNode) {
                    var targettingModal = modalState.formElement.parentNode
                        .querySelector('.targetting__modal');
                    if (targettingModal) {
                        targettingModal.classList.add('gpo-editor-preference-form--confirming');
                    }
                }
            }
            discardModal = confirmationDialog.open(config.modalHost || rootElement, {
                message: pt(action === 'cancel'
                    ? 'confirmCancelDiscard' : 'confirmCloseDiscard'),
                onCancel: function() { handleDiscardModalChoice(false); },
                onConfirm: function() { handleDiscardModalChoice(true); }
            });
        }

        function hideDiscardModal() {
            if (discardModal) {
                discardModal.close();
                discardModal = null;
            }
            var confirmingForms = (config.modalHost || rootElement).querySelectorAll(
                '.gpo-editor-preference-form--confirming');
            Array.prototype.forEach.call(confirmingForms, function(formElement) {
                formElement.classList.remove('gpo-editor-preference-form--confirming');
            });
        }

        function handleDiscardModalChoice(confirmed) {
            var pending = pendingDiscard;
            pendingDiscard = null;
            hideDiscardModal();
            if (!confirmed || !pending) return;
            closeForm(true, pending.action);
        }

        function closeHostModals(host) {
            host.classList.remove('active');
            var modals = Array.prototype.slice.call(host.children);
            modals.forEach(function(element) {
                element.classList.remove('active');
            });
            setTimeout(function() {
                modals.forEach(function(element) {
                    if (!element.classList.contains('active') && element.parentNode === host) {
                        host.removeChild(element);
                    }
                });
            }, 500);
        }

        function closeForm(force, action) {
            var state = modalState;
            if (state && (state.saving || state.reconciling)
                    && action !== 'saved' && action !== 'cleanup') return false;
            if (!force && state && state.formState.dirty) {
                if (pendingDiscard) return false;
                showDiscardModal(action);
                return false;
            }
            pendingDiscard = null;
            hideDiscardModal();
            formRequestId += 1;
            var host = config.modalHost || rootElement.querySelector('.gpo-editor-preferences__modal-host');
            if (host) closeHostModals(host);
            modalState = null;
            setHeaderState();
            if (action !== 'cleanup' && action !== 'navigation') focusTable();
            return true;
        }

        function formInteractiveElements(state) {
            var elements = [];
            var roots = [state.formElement];
            if (state.formElement.parentNode) {
                var targettingModal = state.formElement.parentNode.querySelector('.targetting__modal');
                if (targettingModal) roots.push(targettingModal);
            }
            roots.forEach(function(root) {
                ['input', 'select', 'textarea', 'button'].forEach(function(selector) {
                    Array.prototype.forEach.call(
                        root.querySelectorAll(selector),
                        function(element) {
                            if (elements.indexOf(element) === -1) elements.push(element);
                        }
                    );
                });
            });
            return elements;
        }

        function isRefreshSafeAction(state, element) {
            return state.closeButtons.indexOf(element) !== -1
                || Boolean(element.classList
                    && element.classList.contains('gpo-editor-status__action'));
        }

        function syncFormBusy(state) {
            if (!state) return;
            var busy = Boolean(state.saving || state.reconciling);
            var elements = formInteractiveElements(state);
            if (busy) {
                elements.forEach(function(element) {
                    if (!state.busyDisabledStates.has(element)) {
                        state.busyDisabledStates.set(element, Boolean(element.disabled));
                    }
                    element.disabled = true;
                });
            } else {
                state.busyDisabledStates.forEach(function(disabled, element) {
                    element.disabled = disabled;
                });
                state.busyDisabledStates.clear();
            }
            var refreshLocked = Boolean(state.requiresRefresh);
            state.formState.busy = busy || refreshLocked;
            state.formElement.classList.toggle('gpo-editor-preference-form--busy', busy);
            state.formElement.classList.toggle(
                'gpo-editor-preference-form--refresh-required', refreshLocked
            );
            if (busy) state.formElement.setAttribute('aria-busy', 'true');
            else state.formElement.removeAttribute('aria-busy');
            if (!busy && refreshLocked) {
                formInteractiveElements(state).forEach(function(element) {
                    element.disabled = !isRefreshSafeAction(state, element);
                });
            }
            (state.closeButtons || []).forEach(function(button) { button.disabled = busy; });
            if (state.saveButton) {
                state.saveButton.disabled = Boolean(
                    busy || state.requiresRefresh || state.blockedDescriptors
                );
            }
        }

        function setNameError(state, message) {
            if (!state.nameField || !state.nameError || !state.nameInput) return;
            state.nameField.classList.toggle('gpo-editor-field--error', Boolean(message));
            state.nameError.textContent = message || '';
            if (message) state.nameInput.setAttribute('aria-invalid', 'true');
            else state.nameInput.removeAttribute('aria-invalid');
        }

        function clearFormErrors(state) {
            state.controls.forEach(function(control) { control.setError(''); });
            setNameError(state, '');
            state.formElement.classList.remove('gpo-editor-preference-form--invalid');
            state.validationSlot.textContent = '';
            state.errorSlot.innerHTML = '';
        }

        function markServerFieldError(state, error) {
            if (!error || !error.field) return;
            var field = String(error.field);
            var message = error.message || pt('validationFixErrors');
            if (field === 'name' || field.indexOf('name') !== -1) setNameError(state, message);
            state.controlsById.forEach(function(controls, id) {
                if (field === id || field.indexOf(id) !== -1) {
                    controls.forEach(function(control) { control.setError(message); });
                }
            });
        }

        function renderFormError(state, error) {
            if (modalState !== state) return;
            state.errorSlot.innerHTML = '';
            var category = dto.errorCategory(error).replace(/-/g, '_');
            var actions = {
                onReconcile: async function(event) {
                    if (state.reconciling || state.saving) return;
                    var button = event && event.currentTarget;
                    if (button) button.disabled = true;
                    state.reconciling = true;
                    syncFormBusy(state);
                    try {
                        var response = await API.reconcile();
                        var conflict = recoveryConflict(response);
                        if (conflict) throw conflict;
                        if (modalState === state) {
                            state.requiresRefresh = true;
                            renderReconcileSuccess(state);
                            await loadItems();
                        }
                    } catch (reconcileError) {
                        renderFormError(state, reconcileError);
                    } finally {
                        state.reconciling = false;
                        syncFormBusy(state);
                        if (button && modalState === state) button.disabled = false;
                    }
                }
            };
            if (category === 'storage_conflict' || category === 'publication_conflict'
                    || category === 'not_found') {
                actions.onRefresh = function() {
                    if (!window.confirm(pt('confirmRefreshDiscard'))) return;
                    closeForm(true);
                    void loadItems();
                };
            }
            state.errorSlot.appendChild(editorStatus.renderError(error, actions).getElement());
            markServerFieldError(state, error);
            syncFormBusy(state);
        }

        function renderReconcileSuccess(state) {
            if (modalState !== state) return;
            state.errorSlot.innerHTML = '';
            state.errorSlot.appendChild(createElement('div', {
                className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--info'],
                attrs: { role: 'status' },
                children: [
                    createElement('span', { text: pt('reconcileSucceededRefresh') }),
                    createElement('button', {
                        className: ['button', 'gpo-editor-status__action'],
                        attrs: { type: 'button' },
                        text: pt('refresh'),
                        events: { click: function() {
                            if (!window.confirm(pt('confirmRefreshDiscard'))) return;
                            closeForm(true, 'refresh');
                            void loadItems();
                        } }
                    })
                ]
            }).getElement());
            syncFormBusy(state);
        }

        async function saveForm() {
            if (!modalState || modalState.readonly) return true;
            var state = modalState;
            if (state.saving || state.reconciling || state.requiresRefresh
                    || state.blockedDescriptors) return false;
            clearFormErrors(state);
            var draftFields = state.controls.map(function(control) {
                return { id: control.id, value: control.read() };
            });
            var filterResult = state.formState.readFilterResult();
            var result = dto.buildPreferenceRequest({
                creating: state.creating,
                identity: state.identity,
                descriptors: state.descriptors,
                fields: draftFields,
                name: state.nameInput ? state.nameInput.value : null,
                originalName: state.originalName,
                parent: state.parentSelect ? dto.preferenceParentIdentity(
                    state.parentCandidates, state.parentSelect.value
                ) : null,
                filters: filterResult.operations,
                validationExemptions: state.dependencyDisabledIds || []
            });
            var errors = result.errors.concat(filterResult.errors || []);
            if (errors.length) {
                state.formElement.classList.add('gpo-editor-preference-form--invalid');
                state.validationSlot.textContent = pt('validationFixErrors');
                var firstControl = null;
                errors.forEach(function(error) {
                    if (error.path) return;
                    if (error.id === 'name') {
                        setNameError(state, validationMessage(error.code));
                        if (!firstControl && state.nameInput) firstControl = state.nameInput;
                        return;
                    }
                    (state.controlsById.get(error.id) || []).forEach(function(control) {
                        control.setError(validationMessage(error.code));
                        if (!firstControl) firstControl = control;
                    });
                });
                if (firstControl && typeof firstControl.focus === 'function') firstControl.focus();
                return false;
            }
            if (!result.request) {
                closeForm(true, 'saved');
                return true;
            }
            state.saving = true;
            syncFormBusy(state);
            state.saveButton.textContent = pt('saving');
            try {
                var response = state.creating
                    ? await API.preferenceCreate(item.scope, item.preferenceKind, result.request)
                    : await API.preferenceUpdate(item.scope, item.preferenceKind, result.request);
                var conflict = recoveryConflict(response);
                if (conflict) throw conflict;
                if (!state.creating) invalidateCachedFields(state.identity);
                closeForm(true, 'saved');
                await loadItems();
                if (typeof config.onSaved === 'function') config.onSaved(response);
                return true;
            } catch (error) {
                renderFormError(state, error);
                return false;
            } finally {
                state.saving = false;
                if (modalState === state) {
                    state.saveButton.textContent = pt('save');
                    syncFormBusy(state);
                }
            }
        }

        async function deleteSelected() {
            if (!documentDto.editable || selectedIdentity === null || modalState || opening || deleting || disposed) return;
            if (!window.confirm(pt('confirmDelete'))) return;
            var identity = dto.clone(selectedIdentity);
            var before = items.map(function(entry) { return cacheKey(entry.identity); });
            var removed = false;
            deleting = true; setHeaderState();
            if (deleteButton) deleteButton.disabled = true;
            try {
                var response = await API.preferenceDelete(item.scope, item.preferenceKind, identity);
                invalidateCachedFields(identity);
                await loadItems();
                if (disposed || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                var next = listNavigation.neighbor(before, [cacheKey(identity)], items.map(function(entry) { return cacheKey(entry.identity); }));
                var survivor = items.find(function(entry) { return cacheKey(entry.identity) === next; });
                selectedIdentity = survivor ? dto.clone(survivor.identity) : null;
                renderTable(); setHeaderState(); removed = true;
                if (typeof config.onSaved === 'function') config.onSaved(response);
            } catch (error) {
                showPageError(error);
            } finally {
                deleting = false; setHeaderState();
                if (deleteButton && ownsHeader()) deleteButton.disabled = false;
                if (removed && !disposed && (typeof config.isCurrent !== 'function' || config.isCurrent())) focusTable();
            }
        }

        renderShell();
        var tableSlot = rootElement.querySelector('.gpo-editor-preferences__table');
        tableNavigation = listNavigation.bind(tableSlot, {
            rows: function() { return Array.from(tableSlot.querySelectorAll('[data-preference-identity]')); },
            selected: function() { return tableSlot.querySelector('tr.active'); },
            select: function(row) { selectItem(row.__preferenceIdentity); },
            activate: function(row) { void openForm(dto.clone(row.__preferenceIdentity)); },
            remove: function() { void deleteSelected(); },
            canRemove: function() { return Boolean(documentDto.editable); },
            busy: function() { return disposed || opening || deleting || Boolean(modalState); }
        });
        setHeaderState();
        addListener(createButton, 'click', function() {
            if (createButton.classList.contains('active')) void openForm(null);
        });
        addListener(editButton, 'click', function() {
            if (editButton.classList.contains('active')) void openForm(selectedIdentity);
        });
        addListener(deleteButton, 'click', function() {
            if (deleteButton.classList.contains('active')) void deleteSelected();
        });
        await loadItems();

        root.hasUnsavedChanges = function() {
            return Boolean(modalState && (modalState.formState.dirty || modalState.saving
                || modalState.reconciling || modalState.requiresRefresh));
        };
        root.applyChanges = saveForm;
        root.isBusy = function() { return Boolean(modalState && (modalState.saving || modalState.reconciling)); };
        root.cancelChanges = function() { return closeForm(true, 'navigation'); };
        root.cleanup = function() {
            disposed = true;
            tableNavigation.cleanup();
            itemsRequestId += 1;
            formRequestId += 1;
            cleanups.splice(0).forEach(function(cleanup) { cleanup(); });
            closeForm(true, 'cleanup');
            if (ownsHeader()) {
                headerControls.style.display = 'none';
                headerControls.removeAttribute('data-preference-owner');
                [createButton, editButton, deleteButton].forEach(function(button) {
                    if (button) button.classList.remove('active');
                });
            }
            if (headerActions
                    && headerActions.getAttribute('data-preference-owner') === headerOwner) {
                headerActions.style.display = '';
                headerActions.removeAttribute('data-preference-owner');
                if (admxActions) admxActions.style.display = '';
                if (helpSeparator) helpSeparator.style.display = '';
            }
        };
        return root;
    }

    async function openPreferencesDialog(host, options) {
        var config = options || {};
        var item = config.item || {};
        var closed = false;
        var editor = null;
        var nestedHost = createElement('div', {
            className: ['gp__preference', 'gpo-editor-preferences__modal-host']
        });
        var controls = createElement('div', { className: ['gp__control', 'gpo-security-workbench__toolbar'], children: [
            createElement('button', { className: ['button', 'preferences__btn-create'], attrs: { type: 'button' }, text: t('header.create') }),
            createElement('button', { className: ['button', 'preferences__btn-edit'], attrs: { type: 'button' }, text: t('header.edit') }),
            createElement('button', { className: ['button', 'preferences__btn-delete'], attrs: { type: 'button' }, text: t('header.delete') })
        ] });
        var content = createElement('div', { className: 'gpo-preferences-family-dialog__content', children: [
            controls, createElement('div', { className: 'gpo-editor-empty', text: t('policySearch.loading') })
        ] });
        // The existing controller can own a local toolbar without touching the
        // All Policies header. Keep its controls in the visible dialog content.
        var dialog = editorDialog.open(host, {
            title: item.title || item.document && item.document.label || item.preferenceKind,
            className: ['gpo-preferences-family-dialog'], content: content,
            readOnly: true, cancelLabel: pt('close'),
            canClose: function() { return !editor || !editor.isBusy(); },
            isDirty: function() { return Boolean(editor && editor.hasUnsavedChanges()); },
            onClose: function() {
                closed = true;
                if (editor) editor.cleanup();
                nestedHost.getElement().remove();
                if (config.onClose) config.onClose();
            },
            restoreFocus: config.restoreFocus
        });
        // Place item dialogs beside the family modal within its backdrop:
        // transformed modal bounds must not clip their existing fixed layout.
        dialog.root.getElement().parentElement.appendChild(nestedHost.getElement());
        var localDocument = Object.assign({}, item.document || {});
        if (item.readOnly) localDocument.editable = false;
        editor = await renderPreferencesTemplate({
            item: Object.assign({}, item, { document: localDocument }),
            hideHeading: true,
            header: { getElement: function() { return content.getElement(); } },
            modalHost: nestedHost.getElement(),
            onFormStateChange: function(opened) { dialog.root.getElement().inert = opened; },
            onSaved: config.onSaved,
            isCurrent: function() { return !closed && (typeof config.isCurrent !== 'function' || config.isCurrent()); }
        });
        if (closed || typeof config.isCurrent === 'function' && !config.isCurrent()) {
            editor.cleanup(); dialog.close(); return null;
        }
        content.getElement().replaceChildren(controls.getElement(), editor.getElement());
        return { editor: editor, dialog: dialog };
    }

    return {
        renderPreferencesTemplate: renderPreferencesTemplate,
        openPreferencesDialog: openPreferencesDialog,
        _test: {
            fieldControl: fieldControl,
            mockupFieldControl: mockupFieldControl,
            buildFieldTabs: buildFieldTabs,
            orderedTabEntries: orderedTabEntries,
            isMetadataField: isMetadataField,
            filterKey: filterKey,
            editableFields: editableFields
        }
    };
});
