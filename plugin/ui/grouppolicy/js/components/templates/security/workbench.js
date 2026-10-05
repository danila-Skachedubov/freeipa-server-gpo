define(['../../../util/element-creator', '../../../util/API', '../../../locales/translations', './model', './value-editor', './dialog', './header-actions', '../../editor-status', '../../list-navigation'], function(elements, API, translations, modelTools, values, dialogs, headerActions, editorStatus, listNavigation) {
    'use strict';
    var create = elements.createElement;
    function tr(key, fallback) { var text = translations.t('security.' + key); return text && text !== 'security.' + key ? text : fallback; }
    function typedSummary(definition, state) {
        if (!state || state.state !== 'set') return tr('notConfigured', 'Not configured');
        var value = state.value.value;
        if (state.value.kind === 'boolean') return value ? tr('enabled', 'Enabled') : tr('disabled', 'Disabled');
        if (state.value.kind === 'enum' || state.value.kind === 'flags') {
            var selected = Array.isArray(value) ? value : [value];
            return selected.map(function(id) { var option = (definition.options || []).find(function(option) { return option.id === id; }); return option ? option.display_name || id : id; }).join(', ');
        }
        if (state.value.kind === 'sddl') return tr('permissionsDefined', 'Permissions defined');
        if (Array.isArray(value)) return value.length ? value.join(', ') : tr('emptyValue', 'Empty list');
        return String(value);
    }
    function policySummary(policy) {
        if (policy.state.state !== 'defined') return tr('notConfigured', 'Not configured');
        return (policy.definition.elements || []).filter(function(definition) {
            var state = policy.state.elements && policy.state.elements[definition.id];
            return state && state.state === 'set';
        }).map(function(definition) { return typedSummary(definition, policy.state.elements[definition.id]); }).join('; ') || '—';
    }
    function configuredRows(policy, definition) {
        var state = modelTools.elementState(policy, definition.id);
        return state.state === 'set' ? state.value.value || [] : [];
    }
    async function openPolicyDialog(host, options, renderEditor) {
        var config = options || {}, item = config.item || {};
        var model = item.securityModel || modelTools.buildSecurityModel(await API.securityDefinitionsShow());
        if (config.isCurrent && !config.isCurrent()) return null;
        var policy = modelTools.policy(model, item.securityPolicy);
        if (!policy) throw new Error(tr('missingPolicy', 'The security definition is no longer available.'));
        var definition = item.securityCollection && modelTools.collectionElement(policy);
        var title = policy.definition.display_name || policy.policyId;
        var editor;
        if (config.browseCollection && definition) {
            editor = await render({ item: Object.assign({}, item, { securityModel: model }),
                embedded: true, isCurrent: config.isCurrent, onSaved: config.onSaved }, renderEditor);
        } else {
            editor = await renderEditor({ item: Object.assign({}, item, { securityModel: model }),
                collectionElement: definition, rowIndex: config.rowIndex, initialRow: config.initialRow,
                isCurrent: config.isCurrent, onSaved: config.onSaved });
            if (definition) {
                var row = config.rowIndex === undefined ? config.initialRow : configuredRows(policy, definition)[config.rowIndex];
                var key = row && values.rowKey(definition, row);
                title = key ? String(key.value) : tr('addItem', 'Add item') + ' — ' + title;
            }
        }
        if (!editor) return null;
        if (config.isCurrent && !config.isCurrent()) { if (editor.cleanup) editor.cleanup(); return null; }
        var readOnly = Boolean(config.browseCollection && definition) || editor.readOnly;
        var dialog = dialogs.open(host, { title: title, content: editor, readOnly: readOnly,
            cancelLabel: readOnly ? tr('close', 'Close') : undefined,
            restoreFocus: config.restoreFocus,
            isDirty: editor.hasUnsavedChanges, onApply: editor.applyChanges,
            onClose: function() { if (editor.cleanup) editor.cleanup(); if (config.onClose) config.onClose(); } });
        return { editor: editor, dialog: dialog };
    }
    async function render(options, renderEditor) {
        var config = options || {}, item = config.item || {};
        var model = !item.searchReturnTo && item.securityModel
            || modelTools.buildSecurityModel(await API.securityDefinitionsShow());
        if (config.isCurrent && !config.isCurrent()) return null;
        if (!item.searchReturnTo) item.securityModel = model;
        if (item.securityPreserved) return renderEditor(config);
        var root = create('div', { className: ['gp__preference', 'gpo-security-workbench', config.embedded ? 'gpo-security-workbench--embedded' : null] });
        var panel = create('div', { className: 'gpo-security-workbench__panel' });
        var toolbar = create('div', { className: 'gpo-security-workbench__toolbar' });
        var table = create('table', { className: ['preference__table', 'gpo-catalog-table', 'gpo-security-table'] });
        var body = create('tbody');
        var error = create('div', { className: 'gpo-security-error', attrs: { role: 'alert' } });
        var modalHost = create('div');
        var activeDialog = null, activeEditor = null, disposed = false, opening = false;
        var selection = null;
        var selectedId = null, pendingNeighbor = null;
        var search = create('input', { attrs: { type: 'search', 'data-policy-filter': '', placeholder: tr('filter', 'Filter settings'), 'aria-label': tr('filter', 'Filter settings') } });
        if (!config.embedded && !config.hideHeading) toolbar.append(create('h2', { text: config.categoryPath || item.title || tr('title', 'Security Settings'),
            attrs: { 'data-category-path': '' } }));
        toolbar.append(search);
        panel.append(toolbar); panel.append(error); panel.append(table); root.append(panel); root.append(modalHost);
        function selectedPolicy() { return modelTools.policy(model, item.securityPolicy); }
        var collection = item.securityCollection && modelTools.collectionElement(selectedPolicy());
        var collectionWritable = collection && collection.unique_by && modelTools.writableElement(selectedPolicy(), collection.id);
        var actions = headerActions.bind(config.header, toolbar, {
            create: collectionWritable ? function() { void edit(item); } : null,
            edit: function() { if (selection) selection.open(); },
            delete: collectionWritable ? function() { if (selection && selection.remove) selection.remove(); } : null
        });
        function syncActions() { actions.update(selection && { edit: true, delete: Boolean(selection.remove) }, opening || Boolean(activeDialog)); }
        var policies = item.securityCategory ? (item.children || []).filter(function(child) { return child.securityPolicy && !child.securityCollection; }) : collection ? [] : [item];
        function updateModel(response) { var next = modelTools.buildSecurityModel(response); Object.keys(next).forEach(function(key) { model[key] = next[key]; }); }
        async function edit(node, rowIndex, initialRow) {
            if (activeDialog || opening || disposed) return;
            var returnLabel = selection && selection.element.getAttribute('data-security-row');
            opening = true; syncActions();
            try {
                var opened = await openPolicyDialog(modalHost, {
                    item: Object.assign({}, node, { securityModel: model }), rowIndex: rowIndex, initialRow: initialRow,
                    isCurrent: function() { return !disposed; },
                    restoreFocus: function() {
                        var rows = Array.from(body.getElement().querySelectorAll('[data-security-row]'));
                        return rows.find(function(row) { return row.getAttribute('data-security-row') === returnLabel; })
                            || rows[Math.min(rowIndex || 0, rows.length - 1)] || search.getElement();
                    },
                    onSaved: function(response) { renderRows(); if (config.onSaved) config.onSaved(response); },
                    onClose: function() { activeEditor = null; activeDialog = null; syncActions(); navigation.sync(); }
                }, renderEditor);
                if (opened) { activeEditor = opened.editor; activeDialog = opened.dialog; }
            } catch (problem) {
                if (!disposed) { error.getElement().replaceChildren(); error.append(editorStatus.renderError(problem)); }
            } finally { opening = false; syncActions(); }
        }
        function removeRow(index) {
            if (activeDialog || opening || disposed || !collectionWritable) return;
            var policy = selectedPolicy();
            var key = values.rowKey(collection, configuredRows(policy, collection)[index]);
            var content = create('div', { children: [create('p', { text: tr('removeQuestion', 'Remove this item from the policy?') }), create('p', { text: String(key.value) })] });
            var failure = create('div', { className: 'gpo-security-error', attrs: { role: 'alert' } }); content.append(failure);
            var beforeIds = Array.from(body.getElement().querySelectorAll('[data-list-id]')).map(function(row) { return row.getAttribute('data-list-id'); });
            var removedId = selectedId;
            activeDialog = dialogs.open(modalHost, { title: tr('removeItem', 'Remove item'), content: content, applyLabel: tr('remove', 'Remove'), onApply: async function() {
                try {
                    var response = await API.securityDefinitionsUpdate({ expected_semantic_revision: model.catalog.semantic_revision, policies: [{ namespace: policy.namespace, policy_id: policy.policyId, elements: [{ element_id: collection.id, action: 'rows', rows: [{ action: 'delete', key: key }] }] }] });
                    if (disposed || config.isCurrent && !config.isCurrent()) return false;
                    updateModel(response);
                    if (config.onSaved) config.onSaved(response);
                    pendingNeighbor = { before: beforeIds, removed: [removedId] };
                    renderRows(); return true;
                } catch (problem) { failure.getElement().replaceChildren(); failure.append(editorStatus.renderError(problem)); return false; }
            }, restoreFocus: function() { return selection && selection.element || table.getElement(); },
                onClose: function() { activeDialog = null; syncActions(); navigation.sync(); } });
            syncActions();
        }
        function addRow(label, setting, onOpen, onRemove, id) {
            if (search.getElement().value && (label + ' ' + setting).toLocaleLowerCase().indexOf(search.getElement().value.toLocaleLowerCase()) === -1) return;
            var row = create('tr', { attrs: { tabindex: '-1', 'data-security-row': label, 'data-list-id': id || label, 'aria-selected': 'false' }, children: [create('td', { attrs: { title: label }, text: label }), create('td', { attrs: { title: setting }, text: setting })] });
            function select() {
                if (selection) { selection.element.classList.remove('active'); selection.element.setAttribute('aria-selected', 'false'); }
                selection = { element: row.getElement(), open: onOpen, remove: onRemove };
                selectedId = row.getElement().getAttribute('data-list-id');
                row.getElement().classList.add('active'); row.getElement().setAttribute('aria-selected', 'true');
                syncActions();
                navigation.sync();
            }
            row.getElement().__select = select;
            row.getElement().__open = onOpen;
            row.getElement().__remove = onRemove;
            row.on('click', function() { select(); navigation.focusSelected(); });
            row.on('dblclick', function() { if (!activeDialog && !opening && !disposed) { select(); onOpen(); } });
            body.append(row);
            if (selectedId === row.getElement().getAttribute('data-list-id')) select();
        }
        function serviceCatalog() { return Array.isArray(model.response.security_service_catalog) ? model.response.security_service_catalog : []; }
        function renderRows() {
            selection = null; syncActions();
            var heldFocus = table.getElement().contains(document.activeElement);
            body.getElement().innerHTML = '';
            if (collection) {
                var policy = selectedPolicy();
                var rows = configuredRows(policy, collection);
                var names = new Set();
                rows.map(function(row, index) { return { row: row, index: index }; }).sort(function(a, b) { return String(values.rowKey(collection, a.row).value).localeCompare(String(values.rowKey(collection, b.row).value)); }).forEach(function(entry) {
                    var key = values.rowKey(collection, entry.row); names.add(String(key.value).toLowerCase());
                    var summaries = collection.fields.filter(function(field) { return field.id !== collection.unique_by; }).map(function(field) { return typedSummary(field.element, entry.row[field.id]); });
                    addRow(String(key.value), summaries.join('; '), function() { void edit(item, entry.index); }, collectionWritable ? function() { removeRow(entry.index); } : null, 'row:' + String(key.value));
                });
                if (collection.unique_by === 'service_name') serviceCatalog().slice().sort(function(a, b) { return (a.display_name || a.name).localeCompare(b.display_name || b.name); }).forEach(function(service) {
                    if (names.has(service.name.toLowerCase())) return;
                    var row = values.newRow(collection);
                    row.service_name = { state: 'set', value: { kind: 'service_name', value: service.name } };
                    if (service.startup_mode) row.startup_mode = { state: 'set', value: { kind: 'enum', value: service.startup_mode } };
                    if (service.sddl) row.sddl = { state: 'set', value: { kind: 'sddl', value: service.sddl } };
                    addRow(service.display_name ? service.display_name + ' (' + service.name + ')' : service.name, tr('notConfigured', 'Not configured'), function() { void edit(item, undefined, row); }, null, 'service:' + service.name);
                });
            } else {
                (item.children || []).filter(function(child) { return child.type === 'folder'; }).forEach(function(child) {
                    addRow(child.title, tr('folder', 'Folder'), function() { if (config.onNavigate) config.onNavigate(child); }, null, 'folder:' + (child.id || child.title));
                });
                policies.forEach(function(node) { var policy = modelTools.policy(model, node.securityPolicy); if (policy) addRow(policy.definition.display_name || policy.policyId, policySummary(policy), function() { void edit(node); }, null, 'policy:' + policy.namespace + ':' + policy.policyId); });
            }
            if (pendingNeighbor) {
                var all = Array.from(body.getElement().querySelectorAll('[data-list-id]'));
                selectedId = listNavigation.neighbor(pendingNeighbor.before, pendingNeighbor.removed, all.map(function(row) { return row.getAttribute('data-list-id'); }));
                if (selection) { selection.element.classList.remove('active'); selection.element.setAttribute('aria-selected', 'false'); }
                selection = null;
                var neighbor = all.find(function(row) { return row.getAttribute('data-list-id') === selectedId; });
                if (neighbor) neighbor.__select();
                pendingNeighbor = null;
            }
            if (!selection) selectedId = null;
            if (!body.getElement().children.length) body.append(create('tr', { children: [create('td', { attrs: { colspan: '2' }, className: 'gpo-security-table__empty', text: search.getElement().value ? tr('noMatches', 'No matching settings.') : tr('noItems', 'No items are configured.') })] }));
            navigation.sync(); if (heldFocus) navigation.focusSelected();
        }
        if (collection) {
            if (collection.unique_by === 'service_name' && !serviceCatalog().length) panel.append(create('p', { className: 'gpo-security-workbench__notice', text: tr('serviceCatalogMissing', 'The service catalog has not been supplied. Configured services are shown below; additional services can be added by name.') }));
        }
        table.append(create('thead', { children: [create('tr', { children: [create('th', { text: collection ? tr('item', 'Item') : tr('policy', 'Policy') }), create('th', { text: tr('policySetting', 'Policy setting') })] })] }));
        table.append(body);
        var navigation = listNavigation.bind(table.getElement(), {
            rows: function() { return Array.from(body.getElement().querySelectorAll('[data-list-id]')); },
            selected: function() { return selection && selection.element; },
            select: function(row) { row.__select(); }, activate: function(row) { row.__open(); },
            remove: function(row) { if (row.__remove) row.__remove(); },
            canRemove: function(row) { return Boolean(row.__remove); },
            busy: function() { return disposed || opening || Boolean(activeDialog); }
        });
        search.on('input', renderRows); renderRows();
        root.hasUnsavedChanges = function() { return Boolean(activeEditor && activeEditor.hasUnsavedChanges()); };
        root.applyChanges = async function() { if (!activeEditor) return true; var saved = await activeEditor.applyChanges(); if (saved && activeDialog) activeDialog.close(); return saved; };
        root.cancelChanges = function() { if (activeDialog) activeDialog.close(); return true; };
        root.onMounted = function() {
            if (item.openPolicyDialog && item.securityPolicy && !collection && !disposed) {
                void edit(item);
            }
        };
        root.cleanup = function() { disposed = true; navigation.cleanup(); if (activeDialog) activeDialog.close(); actions.cleanup(); };
        return root;
    }
    return { render: render, openPolicyDialog: openPolicyDialog, policySummary: policySummary };
});
