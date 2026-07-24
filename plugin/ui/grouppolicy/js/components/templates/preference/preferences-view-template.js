define([
    '../../../util/element-creator',
    '../../../util/API',
    '../../../util/editor-dto',
    '../../editor-status',
    '../../../locales/translations'
], function(elementCreator, API, dto, editorStatus, translations) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;
    var nextHeaderOwnerId = 1;
    var nextFieldControlId = 1;

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

    function hiddenFieldControl(field) {
        return {
            id: field.id,
            field: field,
            read: function() { return dto.clone(field.value); },
            setError: function() {},
            focus: function() {}
        };
    }

    function fieldControl(field, forceReadonly, materializeOptionalDefault) {
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
        } else if (value.kind === 'text_list') {
            input = createElement('textarea', {
                attrs: { disabled: disabled ? 'disabled' : null },
                text: Array.isArray(value.value) ? value.value.join('\n') : ''
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
        var element = createElement('div', {
                className: ['gpo-editor-field', disabled ? 'gpo-editor-field--readonly' : null],
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
                    input,
                    disabled ? createElement('span', {
                        className: 'gpo-editor-field__hint', text: pt('readonly')
                    }) : null,
                    errorElement
                ]
            });
        return {
            id: field.id,
            field: field,
            element: element,
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
            setError: function(message) {
                element.getElement().classList.toggle('gpo-editor-field--error', Boolean(message));
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
            var table = createElement('table', {
                className: 'preference__table',
                children: [
                    createElement('thead', { children: [createElement('tr', { children: [
                        createElement('th', { text: pt('itemColumn') }),
                        createElement('th', { text: pt('filtersColumn') }),
                        createElement('th', { text: pt('actionsColumn') })
                    ] })] }),
                    createElement('tbody', { children: items.map(function(preferenceItem) {
                        var selected = selectedIdentity !== null && dto.equal(selectedIdentity, preferenceItem.identity);
                        return createElement('tr', {
                            className: selected ? 'active' : null,
                            attrs: { tabindex: '0' },
                            children: [
                                createElement('td', { text: preferenceItem.label }),
                                createElement('td', { text: preferenceItem.has_filters ? pt('yes') : pt('no') }),
                                createElement('td', {
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
                                })
                            ],
                            events: {
                                click: function() {
                                    selectedIdentity = dto.clone(preferenceItem.identity);
                                    renderTable();
                                    setHeaderState();
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
                    }) })
                ]
            });
            tableSlot.appendChild(table.getElement());
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
            } catch (error) {
                if (requestId !== itemsRequestId
                        || typeof config.isCurrent === 'function' && !config.isCurrent()) return;
                showPageError(error);
            }
        }

        function renderShell() {
            rootElement.innerHTML = '';
            rootElement.appendChild(createElement('div', {
                className: 'gpo-editor-preferences__header',
                children: [
                    createElement('h2', { text: documentDto.label || item.preferenceKind }),
                    createElement('div', {
                        className: ['gpo-editor-document-state', documentDto.editable ? null : 'gpo-editor-document-state--readonly'],
                        text: documentDto.editable ? pt('documentEditable') : pt('documentReadOnly')
                    })
                ]
            }).getElement());
            rootElement.appendChild(createElement('div', { className: 'gpo-editor-preferences__error' }).getElement());
            rootElement.appendChild(createElement('div', { className: 'gpo-editor-preferences__table' }).getElement());
            rootElement.appendChild(createElement('div', { className: 'gpo-editor-preferences__modal-host' }).getElement());
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
                var parentCandidates = creating && Array.isArray(response.parent_candidates)
                    ? dto.clone(response.parent_candidates) : [];
                var controls = [];
                var controlsById = new Map();
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
                    nameField = createElement('label', {
                        className: ['gpo-editor-field', readonly ? 'gpo-editor-field--readonly' : null],
                        attrs: { 'data-field-id': 'name' },
                        children: [
                            createElement('span', {
                                className: 'gpo-editor-field__label',
                                children: [
                                    createElement('span', { text: pt('rename') }),
                                    createElement('span', { className: 'gpo-editor-field__required', text: '*' })
                                ]
                            }),
                            nameInput,
                            readonly ? createElement('span', {
                                className: 'gpo-editor-field__hint', text: pt('readonly')
                            }) : null,
                            nameError
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
                            createElement('div', {
                                className: 'preference__modal-content',
                                children: [
                                    validationSlot,
                                    errorSlot,
                                    createElement('div', { className: 'gpo-editor-fields' }),
                                    createElement('h3', { text: pt('filtersHeading') }),
                                    buildFilterEditor(response, formState, readonly)
                                ]
                            }),
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
                if (nameField) fieldSlot.appendChild(nameField.getElement());
                if (parentField) fieldSlot.appendChild(parentField.getElement());
                fields.forEach(function(field) {
                    var control = field.hidden
                        ? hiddenFieldControl(field)
                        : fieldControl(field, readonly, creating);
                    controls.push(control);
                    if (!controlsById.has(field.id)) controlsById.set(field.id, []);
                    controlsById.get(field.id).push(control);
                    if (control.element) fieldSlot.appendChild(control.element.getElement());
                });
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
        _test: { fieldControl: fieldControl, filterKey: filterKey, editableFields: editableFields }
    };
});
