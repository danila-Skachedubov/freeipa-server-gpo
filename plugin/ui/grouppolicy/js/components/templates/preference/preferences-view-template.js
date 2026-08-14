define([
    '../../../util/element-creator',
    '../../../util/API',
    '../../../util/editor-dto',
    '../../editor-status',
    '../../../locales/translations',
    './layouts/shortcuts'
], function(elementCreator, API, dto, editorStatus, translations, shortcutsLayout) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;
    var nextHeaderOwnerId = 1;
    var nextFieldControlId = 1;
    var PREFERENCE_LAYOUTS = {
        shortcuts: shortcutsLayout
    };

    function pt(key) {
        return t('preferences.editor.' + key);
    }

    function validationMessage(code) {
        if (code === 'required') return pt('validationRequired');
        if (code === 'invalid_number') return pt('validationInvalidNumber');
        if (code === 'unsigned_byte_range') return pt('validationUnsignedByteRange');
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
        function checkboxControl(checked) {
            var controlId = 'gpo-preference-field-' + nextFieldControlId++;
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
        return {
            value: value,
            disabled: disabled,
            controlKind: controlKind,
            input: input,
            inputElement: inputElement,
            errorElement: errorElement,
            read: function() {
                if (disabled || controlKind.indexOf('generated_') === 0) return dto.clone(value);
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
            focus: function() {
                if (inputElement && typeof inputElement.focus === 'function') inputElement.focus();
            }
        };
    }

    function fieldControl(field, forceReadonly, materializeOptionalDefault) {
        var builder = buildControlInput(field, forceReadonly, materializeOptionalDefault, false);
        var element = createElement('div', {
                className: ['gpo-editor-field', builder.disabled ? 'gpo-editor-field--readonly' : null],
                attrs: { 'data-field-id': field.id },
                children: [
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
        return {
            id: field.id,
            field: field,
            element: element,
            read: builder.read,
            setError: function(message) {
                element.getElement().classList.toggle('gpo-editor-field--error', Boolean(message));
                builder.setInputError(message);
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
        return {
            id: field.id,
            field: field,
            element: element,
            read: builder.read,
            setError: function(message) {
                element.getElement().classList.toggle('gpo-editor-field--error', Boolean(message));
                builder.setInputError(message);
            },
            focus: builder.focus
        };
    }

    function valueKindIsSelect(builder) {
        return builder.value.kind === 'action'
            || builder.value.kind === 'filter_combine'
            || builder.controlKind === 'choice';
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

    function filterFieldInventory(showResult) {
        var inventory = new Map();
        var raw = showResult.filter_fields || [];
        if (Array.isArray(raw)) {
            raw.forEach(function(entry) {
                if (entry && Array.isArray(entry.path)) inventory.set(filterKey(entry.path), {
                    fields: entry.fields || [],
                    available: entry.available !== false,
                    error_category: entry.error_category || null
                });
            });
        } else if (raw && typeof raw === 'object') {
            Object.keys(raw).forEach(function(key) {
                inventory.set(key, { fields: raw[key] || [], available: true, error_category: null });
            });
        }
        return inventory;
    }

    function newFilterFields(showResult, kind) {
        var raw = showResult.new_filter_fields || {};
        if (Array.isArray(raw)) {
            var entry = raw.find(function(candidate) { return candidate.kind === kind; });
            return entry ? entry.fields || [] : [];
        }
        if (raw[kind]) return raw[kind];
        var descriptor = (showResult.filter_kinds || []).find(function(candidate) {
            return candidate.kind === kind;
        });
        return descriptor ? descriptor.fields || [] : [];
    }

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
        var createButton = headerControls ? headerControls.querySelector('.preferences__btn-create') : null;
        var editButton = headerControls ? headerControls.querySelector('.preferences__btn-edit') : null;
        var deleteButton = headerControls ? headerControls.querySelector('.preferences__btn-delete') : null;
        var headerOwner = 'preferences-' + nextHeaderOwnerId++;
        var items = [];
        var selectedIdentity = null;
        var modalState = null;
        var opening = false;
        var cleanups = [];
        var formRequestId = 0;
        var itemsRequestId = 0;
        var infoRequestId = 0;
        var itemFieldsCache = new Map();
        var fieldsRequestId = 0;
        var tableRefreshScheduled = false;

        if (headerControls) {
            headerControls.setAttribute('data-preference-owner', headerOwner);
            headerControls.style.display = documentDto.editable ? 'flex' : 'none';
        }
        if (headerActions) {
            headerActions.setAttribute('data-preference-owner', headerOwner);
            headerActions.style.display = 'none';
        }

        function ownsHeader() {
            return Boolean(headerControls
                && headerControls.getAttribute('data-preference-owner') === headerOwner);
        }

        function setHeaderState() {
            if (!ownsHeader()) return;
            var editable = Boolean(documentDto.editable);
            var available = editable && !modalState && !opening;
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
            tableSlot.innerHTML = '';
            if (!items.length) {
                tableSlot.appendChild(createElement('div', {
                    className: 'gpo-editor-empty', text: pt('emptyItems')
                }).getElement());
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
                            selectedIdentity = dto.clone(preferenceItem.identity);
                            renderTable();
                            setHeaderState();
                            void openForm(selectedIdentity);
                        } }
                    })]
                });
            }

            var bodyRows = items.map(function(preferenceItem, index) {
                var selected = selectedIdentity !== null && dto.equal(selectedIdentity, preferenceItem.identity);
                var cells = buildDataCells(preferenceItem, index);
                if (!useTemplate) cells.push(buildActionsCell(preferenceItem));
                return createElement('tr', {
                    className: selected ? 'active' : null,
                    attrs: { tabindex: '0' },
                    children: cells,
                    events: {
                        click: function() {
                            selectedIdentity = dto.clone(preferenceItem.identity);
                            renderTable();
                            setHeaderState();
                            void requestInfoPanel(selectedIdentity);
                        },
                        dblclick: function() {
                            selectedIdentity = dto.clone(preferenceItem.identity);
                            void openForm(selectedIdentity);
                        },
                        keydown: function(event) {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            selectedIdentity = dto.clone(preferenceItem.identity);
                            renderTable();
                            setHeaderState();
                            void openForm(selectedIdentity);
                        }
                    }
                });
            });

            var table = createElement('table', {
                className: 'preference__table',
                children: [
                    createElement('thead', { children: [createElement('tr', { children: headerCells })] }),
                    createElement('tbody', { children: bodyRows })
                ]
            });
            tableSlot.appendChild(table.getElement());
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
            var info = createElement('div', { className: 'preference__info' });
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

        function fieldChecked(field) {
            var v = field && field.value;
            if (v && typeof v === 'object') {
                return v.value === true || v.value === 1;
            }
            return Boolean(v);
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
                var value = fieldChecked(field);
                dataSlot.appendChild(createElement('div', {
                    className: 'preference__settings-item',
                    children: [
                        createElement('div', { className: 'preference__settings-name', text: label + ':' }),
                        createElement('div', { className: 'preference__settings-value', text: value ? pt('yes') : pt('no') })
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
            rootElement.appendChild(buildInfoPanel().getElement());
            rootElement.appendChild(createElement('div', {
                className: 'preference__divider',
                children: [createElement('div', { className: 'divider__line' })]
            }).getElement());
            var dataTable = createElement('div', { className: 'preference__data-table' });
            dataTable.append(createElement('div', {
                className: 'gpo-editor-preferences__header',
                children: [
                    createElement('h2', { text: documentDto.label || item.preferenceKind }),
                    createElement('div', {
                        className: ['gpo-editor-document-state', documentDto.editable ? null : 'gpo-editor-document-state--readonly'],
                        text: documentDto.editable ? pt('documentEditable') : pt('documentReadOnly')
                    })
                ]
            }));
            dataTable.append(createElement('div', { className: 'gpo-editor-preferences__error' }));
            dataTable.append(createElement('div', { className: 'gpo-editor-preferences__table' }));
            dataTable.append(createElement('div', { className: 'gpo-editor-preferences__modal-host' }));
            rootElement.appendChild(dataTable.getElement());
            resetInfoPanel();
        }

        function buildFilterEditor(showResult, formState, readonly) {
            var container = createElement('div', { className: 'gpo-editor-filters' });
            var inventory = filterFieldInventory(showResult);
            var kinds = showResult.filter_kinds || [];
            var sourceFilters = dto.clone(showResult.filters || []);
            var filters = dto.clone(sourceFilters);
            var selectedFilter = null;
            var selectedControls = [];
            var filterDrafts = new Map();
            var originalDrafts = new Map();
            var filterAvailability = new Map();
            var structuralOperation = null;
            var structuralTemporaryId = null;
            var nextTemporaryId = 1;

            sourceFilters.forEach(function(filter) {
                var descriptor = inventory.get(filterKey(filter.path)) || {
                    fields: filter.fields || [], available: true
                };
                var fields = dto.clone(descriptor.fields || []);
                filterDrafts.set(filterKey(filter.path), fields);
                originalDrafts.set(filterKey(filter.path), dto.clone(fields));
                filterAvailability.set(filterKey(filter.path), descriptor.available !== false);
            });

            function keyFor(filter) {
                return filter && filter._temporaryId || filterKey(filter && filter.path);
            }

            function setNotice(message, kind) {
                var slot = container.getElement().querySelector('.gpo-editor-filters__notice');
                if (!slot) return;
                slot.innerHTML = '';
                if (!message) return;
                slot.appendChild(createElement('div', {
                    className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--' + (kind || 'info')],
                    text: message
                }).getElement());
            }

            function captureSelected() {
                if (!selectedFilter) return;
                var key = keyFor(selectedFilter);
                var controls = new Map(selectedControls.map(function(control) {
                    return [control.id, control];
                }));
                var fields = filterDrafts.get(key) || [];
                filterDrafts.set(key, fields.map(function(field) {
                    var control = controls.get(field.id);
                    return Object.assign({}, field, {
                        value: control ? control.read() : dto.clone(field.value)
                    });
                }));
            }

            function structuralTargets(filter) {
                if (!structuralOperation) return true;
                if (filter && filter._temporaryId) {
                    return structuralOperation.op === 'insert'
                        && structuralTemporaryId === filter._temporaryId;
                }
                return Boolean(filter && structuralOperation.path
                    && dto.equal(structuralOperation.path, filter.path));
            }

            function renderFilterFields() {
                var slot = container.getElement().querySelector('.gpo-editor-filters__fields');
                if (!slot) return;
                slot.innerHTML = '';
                selectedControls = [];
                if (!selectedFilter) {
                    slot.textContent = pt('selectFilter');
                    return;
                }
                var key = keyFor(selectedFilter);
                if (filterAvailability.get(key) === false) {
                    slot.appendChild(createElement('div', {
                        className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--warning'],
                        text: pt('unsupportedFilterFields')
                    }).getElement());
                    return;
                }
                (filterDrafts.get(key) || []).forEach(function(field) {
                    var control = fieldControl(
                        field,
                        readonly || formState.busy,
                        Boolean(selectedFilter && selectedFilter._temporaryId)
                    );
                    selectedControls.push(control);
                    slot.appendChild(control.element.getElement());
                });
            }

            function syncToolbar() {
                var selectedUsable = selectedFilter && structuralTargets(selectedFilter);
                kindSelect.getElement().disabled = Boolean(
                    readonly || formState.busy || !kinds.length
                );
                addButton.getElement().disabled = Boolean(
                    readonly || formState.busy || !kinds.length || structuralOperation
                );
                replaceButton.getElement().disabled = Boolean(
                    readonly || formState.busy || !kinds.length || !selectedUsable
                );
                removeButton.getElement().disabled = Boolean(
                    readonly || formState.busy || !selectedUsable
                );
            }

            function selectFilter(filter) {
                if (formState.busy) return;
                captureSelected();
                selectedFilter = filter;
                if (filter && filter.kind && kinds.some(function(info) { return info.kind === filter.kind; })) {
                    kindSelect.getElement().value = filter.kind;
                }
                renderFilterList();
                renderFilterFields();
                syncToolbar();
            }

            function renderFilterList() {
                var slot = container.getElement().querySelector('.gpo-editor-filters__tree');
                if (!slot) return;
                slot.innerHTML = '';
                filters.forEach(function(filter) {
                    slot.appendChild(createElement('button', {
                        className: ['gpo-editor-filter-node', selectedFilter === filter ? 'active' : null],
                        attrs: {
                            type: 'button',
                            disabled: formState.busy ? 'disabled' : null
                        },
                        style: { marginLeft: String((filter.depth || 0) * 16) + 'px' },
                        text: filter.label || filter.kind || filter.element_name || pt('unsupportedFilterFields'),
                        events: { click: function() { selectFilter(filter); } }
                    }).getElement());
                });
            }

            var kindSelect = createElement('select', {
                attrs: { 'aria-label': pt('filterType') },
                children: kinds.map(function(info) {
                    return createElement('option', { attrs: { value: info.kind }, text: info.label || info.kind });
                })
            });
            var addButton = createElement('button', {
                className: ['button', 'gpo-editor-filter-add'],
                attrs: { type: 'button' },
                text: pt('addFilter'),
                events: { click: function() {
                    if (formState.busy) return;
                    captureSelected();
                    if (structuralOperation) {
                        setNotice(pt('oneStructuralChangeLimit'), 'warning');
                        return;
                    }
                    if (selectedFilter && selectedFilter._temporaryId && selectedFilter.supports_children) {
                        setNotice(pt('saveNewCollectionFirst'), 'warning');
                        return;
                    }
                    var kind = kindSelect.getElement().value;
                    var info = kinds.find(function(candidate) { return candidate.kind === kind; }) || {};
                    var parentFilter = selectedFilter && selectedFilter.supports_children
                        ? selectedFilter : null;
                    var collectionPath = parentFilter ? dto.clone(parentFilter.path) : [];
                    var insertionIndex = parentFilter
                        ? Number(parentFilter.child_count || 0)
                        : filters.filter(function(filter) { return Number(filter.depth || 0) === 0; }).length;
                    var temporaryId = 'new-' + nextTemporaryId++;
                    var filter = {
                        _temporaryId: temporaryId,
                        _parentFilter: parentFilter,
                        kind: kind,
                        label: info.label || kind,
                        depth: parentFilter ? Number(parentFilter.depth || 0) + 1 : 0,
                        child_count: 0,
                        supports_children: Boolean(info.supports_children)
                    };
                    var insertAt = filters.length;
                    if (parentFilter) {
                        insertAt = filters.indexOf(parentFilter) + 1;
                        while (insertAt < filters.length
                                && Number(filters[insertAt].depth || 0) > Number(parentFilter.depth || 0)) {
                            insertAt += 1;
                        }
                        parentFilter.child_count = insertionIndex + 1;
                    }
                    filters.splice(insertAt, 0, filter);
                    filterDrafts.set(temporaryId, dto.clone(newFilterFields(showResult, kind)));
                    filterAvailability.set(temporaryId, true);
                    structuralOperation = dto.insertFilterOperation(
                        collectionPath, insertionIndex, kind, []
                    );
                    structuralTemporaryId = temporaryId;
                    formState.dirty = true;
                    setNotice(pt('oneStructuralChangeLimit'), 'info');
                    selectFilter(filter);
                } }
            });
            var replaceButton = createElement('button', {
                className: ['button', 'gpo-editor-filter-replace'],
                attrs: { type: 'button' },
                text: pt('replaceFilter'),
                events: { click: function() {
                    if (formState.busy) return;
                    if (!selectedFilter) return;
                    captureSelected();
                    if (!structuralTargets(selectedFilter)) {
                        setNotice(pt('oneStructuralChangeLimit'), 'warning');
                        return;
                    }
                    var kind = kindSelect.getElement().value;
                    var info = kinds.find(function(candidate) { return candidate.kind === kind; }) || {};
                    var key = keyFor(selectedFilter);
                    if (selectedFilter._temporaryId) {
                        structuralOperation.filter_kind = kind;
                    } else {
                        structuralOperation = dto.replaceFilterOperation(selectedFilter.path, kind, []);
                        structuralTemporaryId = null;
                    }
                    selectedFilter.kind = kind;
                    selectedFilter.label = info.label || kind;
                    selectedFilter.supports_children = Boolean(info.supports_children);
                    var replacedPath = dto.clone(selectedFilter.path || []);
                    filters = filters.filter(function(filter) {
                        return filter === selectedFilter || !filter.path
                            || !dto.pathWithin(filter.path, replacedPath)
                            || dto.equal(filter.path, replacedPath);
                    });
                    selectedFilter.child_count = 0;
                    filterDrafts.set(key, dto.clone(newFilterFields(showResult, kind)));
                    filterAvailability.set(key, true);
                    formState.dirty = true;
                    setNotice(pt('oneStructuralChangeLimit'), 'info');
                    renderFilterList();
                    renderFilterFields();
                    syncToolbar();
                } }
            });
            var removeButton = createElement('button', {
                className: ['button', 'gpo-editor-filter-remove'],
                attrs: { type: 'button' },
                text: pt('removeFilter'),
                events: { click: function() {
                    if (formState.busy) return;
                    if (!selectedFilter) return;
                    captureSelected();
                    if (!structuralTargets(selectedFilter)) {
                        setNotice(pt('oneStructuralChangeLimit'), 'warning');
                        return;
                    }
                    var removing = selectedFilter;
                    if (removing._temporaryId) {
                        if (removing._parentFilter) {
                            removing._parentFilter.child_count = Math.max(
                                0, Number(removing._parentFilter.child_count || 0) - 1
                            );
                        }
                        structuralOperation = null;
                        structuralTemporaryId = null;
                    } else {
                        structuralOperation = dto.removeFilterOperation(removing.path);
                        structuralTemporaryId = null;
                    }
                    filters = filters.filter(function(filter) {
                        if (filter === removing) return false;
                        if (!removing.path || !filter.path) return true;
                        return !dto.pathWithin(filter.path, removing.path);
                    });
                    selectedFilter = null;
                    formState.dirty = true;
                    setNotice(structuralOperation ? pt('oneStructuralChangeLimit') : '', 'info');
                    renderFilterList();
                    renderFilterFields();
                    syncToolbar();
                } }
            });

            container.append(createElement('div', {
                className: ['gpo-editor-filters__toolbar', readonly ? 'gpo-editor-filters__toolbar--disabled' : null],
                children: [
                    createElement('span', { text: pt('filterType') }),
                    kindSelect, addButton, replaceButton, removeButton
                ]
            }));
            container.append(createElement('div', { className: 'gpo-editor-filters__notice' }));
            container.append(createElement('div', {
                className: 'gpo-editor-filters__layout',
                children: [
                    createElement('div', { className: 'gpo-editor-filters__tree' }),
                    createElement('div', { className: 'gpo-editor-filters__fields' })
                ]
            }));
            renderFilterList();
            renderFilterFields();
            syncToolbar();

            formState.readFilterResult = function() {
                captureSelected();
                var validationErrors = [];
                var fieldEdits = sourceFilters.map(function(filter) {
                    var key = filterKey(filter.path);
                    var original = originalDrafts.get(key) || [];
                    var current = filterDrafts.get(key) || original;
                    var discardedByStructure = structuralOperation
                        && (structuralOperation.op === 'remove' || structuralOperation.op === 'replace')
                        && dto.pathWithin(filter.path, structuralOperation.path);
                    if (!discardedByStructure && filterAvailability.get(key) !== false) {
                        current.forEach(function(field) {
                            if (!field.editable) return;
                            var code = dto.validatePreferenceField(field, field.value);
                            if (code) validationErrors.push({ path: filter.path, id: field.id, code: code });
                        });
                    }
                    return {
                        path: filter.path,
                        fields: dto.preferenceFieldEdits(original, current.map(function(field) {
                            return { id: field.id, value: field.value };
                        }), true)
                    };
                });
                var structural = structuralOperation ? dto.clone(structuralOperation) : null;
                if (structural && (structural.op === 'insert' || structural.op === 'replace')) {
                    var key = structural.op === 'insert'
                        ? structuralTemporaryId : filterKey(structural.path);
                    var fields = filterDrafts.get(key) || [];
                    fields.forEach(function(field) {
                        if (!field.editable) return;
                        var code = dto.validatePreferenceField(field, field.value);
                        if (code) validationErrors.push({ path: structural.path || [], id: field.id, code: code });
                    });
                    structural.fields = dto.preferenceFieldEdits(fields, fields.map(function(field) {
                        return { id: field.id, value: field.value };
                    }), false);
                }
                selectedControls.forEach(function(control) { control.setError(''); });
                if (selectedFilter) {
                    validationErrors.filter(function(error) {
                        return dto.equal(error.path, selectedFilter.path || []);
                    }).forEach(function(error) {
                        selectedControls.filter(function(control) { return control.id === error.id; })
                            .forEach(function(control) { control.setError(validationMessage(error.code)); });
                    });
                }
                return {
                    operations: dto.buildPreferenceFilterOperations(fieldEdits, structural),
                    errors: validationErrors
                };
            };
            return container;
        }

        async function openForm(identity) {
            var creating = identity === null || identity === undefined;
            if (creating && !documentDto.editable) return;
            if (opening) return false;
            if (modalState && !closeForm(false, 'close')) return;
            var host = rootElement.querySelector('.gpo-editor-preferences__modal-host');
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
                var buildModalContent = function() {
                    var content = createElement('div', { className: 'preference__modal-content' });
                    content.append(validationSlot);
                    content.append(errorSlot);
                    content.append(createElement('div', { className: 'gpo-editor-fields' }));
                    var filterSection = createElement('div', { className: 'preference__modal-filters' });
                    filterSection.append(createElement('h3', { text: pt('filtersHeading') }));
                    filterSection.append(buildFilterEditor(response, formState, readonly));
                    if (fieldTabs) {
                        content.append(fieldTabs);
                        if (fieldTabs.filtersSlot) {
                            fieldTabs.filtersSlot.append(filterSection);
                            filterSection = null;
                        }
                    }
                    if (filterSection) content.append(filterSection);
                    return content;
                };
                var form = createElement('div', {
                    className: [
                        'preference__modal', 'active', 'gpo-editor-preference-form',
                        readonly ? 'preference__modal--readonly' : null
                    ],
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
                syncFormBusy(modalState);
                setHeaderState();
            } catch (error) {
                if (requestId === formRequestId) showPageError(error);
            } finally {
                if (requestId === formRequestId) setOpening(false);
            }
        }

        function closeForm(force, action) {
            var state = modalState;
            if (state && (state.saving || state.reconciling)
                    && action !== 'saved' && action !== 'cleanup') return false;
            if (!force && state && state.formState.dirty) {
                var key = action === 'cancel' ? 'confirmCancelDiscard' : 'confirmCloseDiscard';
                if (!window.confirm(pt(key))) return false;
            }
            formRequestId += 1;
            var host = rootElement.querySelector('.gpo-editor-preferences__modal-host');
            if (host) host.innerHTML = '';
            modalState = null;
            setHeaderState();
            return true;
        }

        function formInteractiveElements(state) {
            var elements = [];
            ['input', 'select', 'textarea', 'button'].forEach(function(selector) {
                Array.prototype.forEach.call(
                    state.formElement.querySelectorAll(selector),
                    function(element) {
                        if (elements.indexOf(element) === -1) elements.push(element);
                    }
                );
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
                filters: filterResult.operations
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
            if (!documentDto.editable || selectedIdentity === null || modalState || opening) return;
            if (!window.confirm(pt('confirmDelete'))) return;
            var identity = dto.clone(selectedIdentity);
            if (deleteButton) deleteButton.disabled = true;
            try {
                await API.preferenceDelete(item.scope, item.preferenceKind, identity);
                invalidateCachedFields(identity);
                if (dto.equal(selectedIdentity, identity)) selectedIdentity = null;
                await loadItems();
            } catch (error) {
                showPageError(error);
            } finally {
                if (deleteButton && ownsHeader()) deleteButton.disabled = false;
            }
        }

        renderShell();
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
        root.cancelChanges = function() { return closeForm(true, 'navigation'); };
        root.cleanup = function() {
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
            }
        };
        return root;
    }

    return {
        renderPreferencesTemplate: renderPreferencesTemplate,
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
