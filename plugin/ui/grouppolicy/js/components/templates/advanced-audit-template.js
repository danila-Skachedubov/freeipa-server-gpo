define([
    '../../util/element-creator', '../../util/API', '../../locales/translations',
    '../editor-status', './advanced-audit/model', './security/dialog', './security/header-actions',
    './all-policies/model', '../list-navigation'
], function(elementCreator, API, translations, editorStatus, auditModel, dialogs, headerActions, searchModel, listNavigation) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;

    function tr(key, fallback) {
        var value = t(key);
        return value && value !== key ? value : fallback;
    }

    function configured(row) {
        return row.configured !== false && row.kind !== 'preserved';
    }

    function label(row) {
        if (row.kind === 'subcategory') return row.display_name || row.guid;
        if (row.kind === 'option') return row.display_name || row.machine_name || row.option;
        if (row.kind === 'global_sacl') return row.object_kind === 'registry'
            ? tr('security.advancedAudit.registrySacl', 'Registry global SACL')
            : tr('security.advancedAudit.fileSacl', 'File global SACL');
        return tr('security.advancedAudit.preserved', 'Preserved source row');
    }

    function summary(row) {
        if (!configured(row)) return tr('security.notConfigured', 'Not configured');
        if (row.kind === 'subcategory') {
            var setting = row.setting || {};
            if (setting.kind === 'system') return systemSettingLabel(setting.value);
            var enabled = [];
            if (setting.none) enabled.push(tr('security.advancedAudit.none', 'No auditing'));
            if (setting.include_success) enabled.push(tr('security.advancedAudit.includeSuccess', 'Include success'));
            if (setting.exclude_success) enabled.push(tr('security.advancedAudit.excludeSuccess', 'Exclude success'));
            if (setting.include_failure) enabled.push(tr('security.advancedAudit.includeFailure', 'Include failure'));
            if (setting.exclude_failure) enabled.push(tr('security.advancedAudit.excludeFailure', 'Exclude failure'));
            return enabled.join(', ');
        }
        if (row.kind === 'option') return row.enabled
            ? tr('security.enabled', 'Enabled') : tr('security.disabled', 'Disabled');
        if (row.kind === 'global_sacl') return row.sddl
                ? tr('security.permissionsDefined', 'Permissions defined')
            : tr('security.notConfigured', 'Not configured');
        return tr('security.advancedAudit.unknownPreserved', 'Unknown row preserved');
    }

    function systemSettingLabel(value) {
        var labels = {
            unchanged: tr('security.advancedAudit.unchanged', 'Leave unchanged'),
            success: tr('security.advancedAudit.success', 'Success'),
            failure: tr('security.advancedAudit.failure', 'Failure'),
            success_and_failure: tr('security.advancedAudit.successAndFailure', 'Success and failure'),
            none: tr('security.advancedAudit.none', 'No auditing')
        };
        return labels[value] || String(value || '');
    }

    function emptyRequest() {
        return {
            set_subcategories: [], clear_subcategories: [],
            set_options: [], clear_options: [],
            set_global_sacls: [], clear_global_sacls: []
        };
    }

    async function renderAdvancedAuditTemplate(options) {
        var config = options || {};
        var item = config.item || {};
        if (item.advancedAuditError) return createElement('div', { className: 'gpo-security-error', text: tr('security.auditUnavailable', 'Advanced Audit is temporarily unavailable. Other security settings remain available.') });
        var response = item.advancedAuditResponse || await API.advancedAuditShow();
        if (typeof config.isCurrent === 'function' && !config.isCurrent()) return null;
        var family = auditModel.familyById(response, item.advancedAuditFamilyId);
        var externalHost = config.dialogHost;
        var disposed = false;
        var root = externalHost ? {} : createElement('div', { className: ['gp__preference', 'gpo-security-workbench'] });
        var activeDialog = null;
        var dirty = function() { return false; };
        var applyCurrent = null;
        var selection = null;
        var selectedId = null, navigation;
        var modalHost = externalHost || createElement('div');
        var errorSlot, body, search, actions;
        if (!externalHost) {
            var data = createElement('div', {
                className: 'gpo-security-workbench__panel',
                attrs: { 'data-advanced-audit-view': item.advancedAuditFamilyId || '' }
            });
            errorSlot = createElement('div', { className: 'gpo-editor-preferences__error' });
            body = createElement('tbody');
            var table = createElement('table', { className: ['preference__table', 'gpo-catalog-table', 'gpo-security-table'], children: [
                createElement('thead', { children: [createElement('tr', { children: [
                    createElement('th', { text: tr('security.policy', 'Policy') }),
                    createElement('th', { text: tr('security.policySetting', 'Policy setting') })
                ] })] }), body
            ] });
            var listState = item.auditListState || (item.auditListState = { query: '' });
            search = createElement('input', { attrs: {
                type: 'search', value: listState.query || '',
                placeholder: t('policySearch.categoryPlaceholder'),
                'aria-label': t('policySearch.categoryPlaceholder'),
                'data-policy-filter': ''
            } });
            var toolbar = createElement('div', { className: 'gpo-security-workbench__toolbar',
                children: [config.hideHeading ? null : createElement('h2', { text: config.categoryPath || family && family.label || '',
                    attrs: { 'data-category-path': '' } }), search] });
            actions = headerActions.bind(config.header, toolbar, { edit: function() { if (selection) edit(selection.row); } });
            data.append(toolbar);
            data.append(errorSlot); data.append(table); data.append(modalHost); root.append(data);
            navigation = listNavigation.bind(table.getElement(), {
                rows: function() { return Array.from(body.getElement().querySelectorAll('[data-advanced-audit-kind]')); },
                selected: function() { return selection && selection.element; },
                select: function(row) { row.__select(); }, activate: function(row) { edit(row.__auditRow); },
                busy: function() { return disposed || Boolean(activeDialog); }
            });
        }
        function syncActions() { if (actions) actions.update(selection && { edit: true }, Boolean(activeDialog)); }
        function onClose() {
            activeDialog = null; applyCurrent = null; dirty = function() { return false; }; syncActions();
            if (config.onClose) config.onClose();
        }

        function close() { if (activeDialog) activeDialog.close(); }

        function edit(row) {
            if (activeDialog || disposed || typeof config.isCurrent === 'function' && !config.isCurrent()) return null;
            if (!row.editable || row.kind === 'preserved') {
                activeDialog = dialogs.open(modalHost, { title: label(row), readOnly: true,
                    content: createElement('div', { children: [createElement('p', { text: tr('security.preservedReadOnly', 'This setting is preserved and is read-only.') }), createElement('pre', { className: 'gpo-security-preserved-value', text: row.sddl || row.raw || (row.fields && row.fields.join('\n')) || row.reason || summary(row) })] }),
                    restoreFocus: config.restoreFocus || function() { return selection && selection.element || search && search.getElement(); }, onClose: onClose });
                syncActions();
                return activeDialog;
            }
            var isConfigured = configured(row);
            var define = createElement('input', { attrs: { type: 'checkbox',
                checked: isConfigured ? 'checked' : null } });
            var fields = createElement('div', { className: 'gpo-editor-advanced-audit__fields' });
            var machineName = createElement('input', { attrs: { type: 'text',
                value: row.machine_name || auditModel.state(response).suggested_machine_name || '',
                'data-advanced-audit-machine': '' } });
            var controls = [machineName.getElement()];
            // Machine name is source-file metadata, not a policy target. Keep
            // an existing value; the native API allows it to be empty for new rows.
            var requestForRow;
            if (row.kind === 'subcategory') {
                var setting = row.setting || { kind: 'system', value: 'unchanged' };
                var system = setting.kind !== 'user';
                fields.append(createElement('div', { className: 'gpo-editor-security-record-identity',
                    children: [createElement('dt', { text: 'GUID' }),
                        createElement('dd', { text: row.guid || '' }),
                        createElement('dt', { text: tr('security.advancedAudit.target', 'Target') }),
                        createElement('dd', { text: system
                            ? tr('security.advancedAudit.system', 'System')
                            : tr('security.advancedAudit.user', 'User SID') + ': ' + row.target.sid })] }));
                if (system) {
                    var mode = createElement('select', { attrs: { 'data-advanced-audit-setting': '' },
                        children: ['unchanged', 'success', 'failure', 'success_and_failure', 'none']
                            .map(function(value) { return createElement('option', {
                                attrs: { value: value }, text: systemSettingLabel(value)
                            }); }) });
                    mode.getElement().value = setting.value || 'unchanged';
                    fields.append(createElement('label', { className: 'gpo-editor-security-record__field',
                        children: [createElement('span', { text: tr('security.advancedAudit.auditSetting', 'Audit setting') }), createElement('span', { className: 'field__element', children: [mode] })] }));
                    controls.push(mode.getElement());
                    requestForRow = function() { return { kind: 'system', value: mode.getElement().value }; };
                } else {
                    var flags = ['include_success', 'exclude_success', 'include_failure', 'exclude_failure', 'none'];
                    var flagInputs = {};
                    flags.forEach(function(flag) {
                        var input = createElement('input', { attrs: { type: 'checkbox',
                            checked: setting[flag] ? 'checked' : null,
                            'data-advanced-audit-flag': flag } });
                        flagInputs[flag] = input.getElement(); controls.push(input.getElement());
                        fields.append(createElement('label', { className: ['field', 'field__checkbox'],
                            children: [input, createElement('span', { text: tr('security.advancedAudit.' + flag, flag.replace(/_/g, ' ')) })] }));
                    });
                    requestForRow = function() {
                        var result = { kind: 'user' };
                        flags.forEach(function(flag) { result[flag] = flagInputs[flag].checked; });
                        return result;
                    };
                }
            } else if (row.kind === 'global_sacl') {
                var descriptor = createElement('textarea', { attrs: { rows: '5', spellcheck: 'false', 'data-advanced-audit-sddl': '', 'aria-label': tr('security.securityDescriptor', 'Security descriptor (SDDL)') } });
                descriptor.getElement().value = row.sddl || '';
                controls.push(descriptor.getElement());
                fields.append(createElement('label', { className: 'gpo-editor-security-record__field', children: [createElement('span', { text: tr('security.securityDescriptor', 'Security descriptor (SDDL)') }), createElement('span', { className: 'field__element', children: [descriptor] })] }));
                fields.append(createElement('p', { text: tr('security.saclHelp', 'Supply the complete SACL in SDDL format. Applying replaces the global audit descriptor for this object type.') }));
                requestForRow = function() { return descriptor.getElement().value; };
            } else {
                var enabled = createElement('input', { attrs: { type: 'checkbox',
                    checked: row.enabled ? 'checked' : null, 'data-advanced-audit-enabled': '' } });
                controls.push(enabled.getElement());
                fields.append(createElement('label', { className: ['field', 'field__checkbox'],
                    children: [enabled, createElement('span', {
                        text: tr('security.advancedAudit.enableOption', 'Enable this audit option')
                    })] }));
                requestForRow = function() { return enabled.getElement().checked; };
            }
            function sync() {
                controls.forEach(function(control) { control.disabled = !define.getElement().checked; });
            }
            define.on('change', sync); sync();
            var validation = createElement('div', { className: 'gpo-security-error', attrs: { role: 'alert' } });
            function draftValue() { return JSON.stringify([define.getElement().checked, machineName.getElement().value, requestForRow()]); }
            var baseline = draftValue();
            dirty = function() { return baseline !== draftValue(); };
            applyCurrent = async function() {
                var request = emptyRequest();
                if (!define.getElement().checked) {
                    if (row.kind === 'subcategory') request.clear_subcategories.push({
                        target: row.target, guid: row.guid
                    });
                    else if (row.kind === 'global_sacl') request.clear_global_sacls.push(row.object_kind);
                    else request.clear_options.push(row.option);
                } else if (row.kind === 'subcategory') {
                    request.set_subcategories.push({ machine_name: machineName.getElement().value.trim(),
                        target: row.target, guid: row.guid, setting: requestForRow() });
                } else if (row.kind === 'global_sacl') {
                    var sddl = requestForRow();
                    if (!sddl.trim() || /[\r\n\0]/.test(sddl)) {
                        validation.getElement().textContent = tr('security.validationDescriptor', 'Enter one security descriptor without line breaks.');
                        descriptor.getElement().focus(); return false;
                    }
                    request.set_global_sacls.push({ machine_name: machineName.getElement().value,
                        object_kind: row.object_kind, sddl: sddl });
                } else {
                    request.set_options.push({ machine_name: machineName.getElement().value.trim(),
                        option: row.option, enabled: requestForRow() });
                }
                try {
                    response = await API.advancedAuditUpdate(request);
                    if (!item.searchReturnTo) item.advancedAuditResponse = response;
                    family = auditModel.familyById(response, item.advancedAuditFamilyId);
                    renderRows();
                    if (config.onSaved) config.onSaved(response);
                    return true;
                } catch (error) {
                    validation.getElement().innerHTML = '';
                    validation.append(editorStatus.renderError(error));
                    return false;
                }
            };
            var settingsPanel = createElement('div', { children: [
                    createElement('label', { className: ['field', 'field__checkbox', 'gpo-security-policy-editor__define'], children: [define, createElement('span', { text: tr('security.defineSetting', 'Define this policy setting') })] }), fields, validation]
            });
            var explanation = row.explain_text || row.description || (row.kind === 'global_sacl' ? tr('security.saclHelp', 'Supply the complete SACL in SDDL format. Applying replaces the global audit descriptor for this object type.') : tr('security.noExplanation', 'No explanation is available for this setting.'));
            var explanationPanel = createElement('div', { className: 'gpo-security-explanation', children: [createElement('h3', { text: label(row) }), createElement('p', { text: explanation })] });
            activeDialog = dialogs.open(modalHost, { title: label(row), content: createElement('div', {
                className: 'gpo-security-policy-editor', attrs: { 'data-advanced-audit-form': '' }, children: [dialogs.tabs(settingsPanel, explanationPanel)]
            }), isDirty: dirty, onApply: applyCurrent, restoreFocus: config.restoreFocus || function() { return selection && selection.element || search && search.getElement(); }, onClose: onClose });
            syncActions();
            return activeDialog;
        }

        function renderRows() {
            if (externalHost || disposed) return;
            var heldFocus = body.getElement().contains(document.activeElement);
            selection = null; syncActions();
            body.getElement().innerHTML = '';
            (family && family.rows || []).filter(function(row) {
                return label(row).toLocaleLowerCase().includes(listState.query.trim().toLocaleLowerCase());
            }).slice().sort(function(a, b) { return label(a).localeCompare(label(b)); }).forEach(function(row, index) {
                var id = searchModel.auditIdentity(row) + ':' + index;
                var tableRow = createElement('tr', { attrs: {
                    tabindex: '-1',
                    'aria-selected': 'false',
                    'data-advanced-audit-kind': row.kind,
                    'data-advanced-audit-id': row.guid || row.option || row.object_kind || ''
                }, children: [createElement('td', { attrs: { title: label(row) }, text: label(row) }),
                    createElement('td', { attrs: { title: summary(row) }, text: summary(row) })] });
                function select() {
                    if (selection) { selection.element.classList.remove('active'); selection.element.setAttribute('aria-selected', 'false'); }
                    selection = { row: row, element: tableRow.getElement() };
                    selectedId = id;
                    tableRow.getElement().classList.add('active'); tableRow.getElement().setAttribute('aria-selected', 'true');
                    syncActions();
                    navigation.sync();
                }
                tableRow.getElement().__select = select;
                tableRow.getElement().__auditRow = row;
                tableRow.on('click', function() { select(); navigation.focusSelected(); });
                tableRow.on('dblclick', function() { if (!activeDialog && !disposed) { select(); edit(row); } });
                body.append(tableRow);
                if (selectedId === id) select();
            });
            if (!selection) selectedId = null;
            navigation.sync(); if (heldFocus) navigation.focusSelected();
        }

        if (search) {
            search.on('input', function() { listState.query = search.getElement().value; renderRows(); });
            search.on('keydown', function(event) {
                if (event.key === 'Escape') { search.getElement().value = ''; listState.query = ''; renderRows(); }
            });
        }
        renderRows();
        root.hasUnsavedChanges = function() { return dirty(); };
        root.applyChanges = async function() { if (!applyCurrent) return true; var saved = await applyCurrent(); if (saved) close(); return saved; };
        root.cancelChanges = function() { close(); return true; };
        root.openPolicyDialog = function() {
            if (!item.advancedAuditTarget) return null;
            var matches = (family && family.rows || []).filter(function(row) {
                return searchModel.auditIdentity(row) === item.advancedAuditTarget;
            });
            var row = matches[item.advancedAuditOccurrence || 0];
            if (row) return edit(row);
            var error = new Error(t('policySearch.targetUnavailable'));
            if (errorSlot) errorSlot.append(editorStatus.renderError(error));
            else throw error;
            return null;
        };
        root.onMounted = function() { if (item.openPolicyDialog) root.openPolicyDialog(); };
        root.cleanup = function() { disposed = true; if (navigation) navigation.cleanup(); close(); if (actions) actions.cleanup(); };
        return root;
    }

    async function openAdvancedAuditDialog(host, options) {
        var editor = await renderAdvancedAuditTemplate(Object.assign({}, options, { dialogHost: host }));
        if (!editor) return null;
        var dialog = editor.openPolicyDialog();
        if (!dialog) { editor.cleanup(); return null; }
        return { editor: editor, dialog: dialog };
    }

    return { renderAdvancedAuditTemplate: renderAdvancedAuditTemplate, openAdvancedAuditDialog: openAdvancedAuditDialog };
});
