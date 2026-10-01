define([
    '../../util/element-creator',
    '../../util/API',
    '../../locales/translations',
    '../editor-status',
    './security/model',
    './security/value-editor',
    './security/dependency-plan',
    './security/workbench',
    './security/dialog',
    '../confirmation-dialog'
], function(elementCreator, API, translations, editorStatus, securityModel, values, dependencies, workbench, dialogs, confirmationDialog) {
    "use strict";

    var createElement = elementCreator.createElement;

    function tr(key, fallback) {
        var translated = translations.t(key);
        return translated && translated !== key ? translated : fallback;
    }

    function stateFor(policy, element) {
        if (policy.state.state === 'defined') {
            return policy.state.elements && policy.state.elements[element.id]
                ? values.clone(policy.state.elements[element.id])
                : { state: 'unset' };
        }
        return element.initial
            ? { state: 'set', value: values.clone(element.initial) }
            : { state: 'unset' };
    }

    function initialDraft(policy) {
        var elements = {};
        (policy.definition.elements || []).forEach(function(element) {
            elements[element.id] = stateFor(policy, element);
        });
        return {
            defined: policy.state.state === 'defined',
            elements: elements
        };
    }

    function canCreateRow(collection, controls) {
        var writable = new Set();
        function visit(items, parentReadOnly) {
            (items || []).forEach(function(control) {
                var readOnly = parentReadOnly || control.read_only;
                if (control.element_id && !readOnly) writable.add(control.element_id);
                visit(control.children, readOnly);
            });
        }
        visit(controls, false);
        return (collection.fields || []).every(function(field) {
            return !field.required || field.element.initial || writable.has(field.id);
        });
    }

    function registerBinding(bindings, id, binding) {
        if (!bindings.has(id)) bindings.set(id, []);
        bindings.get(id).push(binding);
    }

    function syncBindings(bindings, id, source, state) {
        (bindings.get(id) || []).forEach(function(binding) {
            binding.update(state, binding === source);
        });
    }

    function controlLabel(control, element, state) {
        var label = control.label || element.id;
        if (label === 'value') label = tr('security.value', 'Value');
        if (!state || state.state !== 'set' || element.value_type !== 'integer') {
            return label;
        }
        var match = (control.labels_when || []).find(function(item) {
            return Number(item[0]) === state.value.value;
        });
        return match ? match[1] : label;
    }

    function rangeText(control, element) {
        if (element.value_type !== 'integer' || control.show_range !== true) return null;
        var ranges = element.input_ranges && element.input_ranges.length
            ? element.input_ranges : element.ranges || [];
        return ranges.map(function(range) {
            return range.min === range.max
                ? String(range.min) : String(range.min) + '–' + String(range.max);
        }).join(', ') || null;
    }

    function elementAction(element, before, after) {
        if (values.same(before, after)) return null;
        if (after.state === 'unset') {
            return { element_id: element.id, action: 'unset' };
        }
        if (element.value_type === 'collection' && before.state === 'set') {
            var rows = values.rowActions(
                element, before.value.value || [], after.value.value || []
            );
            return rows.length
                ? { element_id: element.id, action: 'rows', rows: rows }
                : null;
        }
        return {
            element_id: element.id,
            action: 'set',
            value: values.clone(after.value)
        };
    }

    function updateRequest(model, policy, baseline, draft) {
        var update = {
            namespace: policy.namespace,
            policy_id: policy.policyId,
            elements: []
        };
        if (baseline.defined !== draft.defined) {
            update.transition = draft.defined ? 'define' : 'undefine';
        }
        if (!draft.defined) {
            return {
                expected_semantic_revision: model.catalog.semantic_revision,
                policies: [update]
            };
        }
        (policy.definition.elements || []).forEach(function(element) {
            var action = elementAction(
                element,
                baseline.elements[element.id] || { state: 'unset' },
                draft.elements[element.id] || { state: 'unset' }
            );
            if (action) update.elements.push(action);
        });
        return {
            expected_semantic_revision: model.catalog.semantic_revision,
            policies: [update]
        };
    }

    function validateDraft(policy, draft) {
        if (!draft.defined) return null;
        function validateState(element, state, label, required) {
            if (state.state !== 'set') return required
                ? label + ': ' + tr('security.validationRequired', 'A value is required.')
                : null;
            var typeError = values.validationError(element, state.value);
            if (typeError) return label + ': ' + typeError;
            if (element.value_type !== 'collection') return null;
            if (!Array.isArray(state.value.value)) {
                return label + ': ' + tr('security.validationRows', 'Enter valid collection rows.');
            }
            if (!state.value.value.length) return tr('security.validationRows', 'Add at least one item, or leave this policy not configured.');
            var seen = new Set();
            for (var row of state.value.value) {
                if (element.unique_by === 'group' && (element.fields || []).some(function(field) { return field.id === 'members'; })
                        && (!row.members || row.members.state !== 'set') && (!row.member_of || row.member_of.state !== 'set')) {
                    return tr('security.validationGroupRelationship', 'Define Members or Member of. An explicitly empty list is allowed.');
                }
                if (element.unique_by) {
                    var key = values.rowKey(element, row);
                    if (!key) return label + ': ' + tr(
                        'security.validationKey', 'Every row requires its unique key.'
                    );
                    var encoded = JSON.stringify(key);
                    if (seen.has(encoded)) return element.duplicate_message
                        || tr('security.validationDuplicate', 'Collection row keys must be unique.');
                    seen.add(encoded);
                }
                for (var field of element.fields || []) {
                    var fieldError = validateState(
                        field.element, row && row[field.id] || { state: 'unset' },
                        field.display_name || field.id, field.required
                    );
                    if (fieldError) return fieldError;
                }
            }
            return null;
        }
        for (var element of policy.definition.elements || []) {
            var error = validateState(
                element, draft.elements[element.id] || { state: 'unset' },
                element.id, element.required
            );
            if (error) return error;
        }
        return null;
    }

    function renderPreserved(model) {
        var root = createElement('div', {
            className: ['gp__preference', 'gpo-editor-preferences'],
            attrs: { 'data-security-preserved': '' }
        });
        root.append(createElement('h2', {
            text: tr('security.preservedTitle', 'Preserved and diagnostic records')
        }));
        if ((model.diagnostics || []).length) root.append(editorStatus.renderDiagnostics(model.diagnostics));
        var list = createElement('dl', { className: 'gpo-editor-security-preserved' });
        (model.preserved || []).forEach(function(record) {
            list.append(createElement('dt', {
                text: record.section + ' — ' + record.identity
            }));
            list.append(createElement('dd', {
                children: [createElement('p', { text: record.damaged
                    ? tr('security.damaged', 'Damaged record')
                    : tr('security.preservedReadOnly', 'This setting is preserved and is read-only.') }),
                    editorStatus.renderDiagnostics([{ message: record.reason }])]
            }));
        });
        root.append(list);
        return root;
    }

    async function renderPolicyEditor(options) {
        var config = options || {};
        var item = config.item || {};
        var model = item.securityModel;
        if (!model) {
            model = securityModel.buildSecurityModel(
                await API.securityDefinitionsShow()
            );
            if (typeof config.isCurrent === 'function' && !config.isCurrent()) return null;
            item.securityModel = model;
        }
        if (item.securityPreserved) return renderPreserved(model);

        var policy = securityModel.policy(model, item.securityPolicy);
        if (!policy) {
            return createElement('div', {
                className: 'gpo-editor-preferences__error',
                text: tr('security.missingPolicy', 'The security definition is no longer available.')
            });
        }

        var root = createElement('div', {
            className: 'gpo-security-policy-editor',
            attrs: {
                'data-security-policy': policy.policyId,
                'data-security-namespace': policy.namespace
            }
        });
        var baseline = initialDraft(policy);
        var draft = values.clone(baseline);
        var rowElement = config.collectionElement;
        var rowWritable = !rowElement || Boolean(rowElement.unique_by) && securityModel.writableElement(policy, rowElement.id);
        var editedRow = null;
        if (rowElement) {
            var rowState = draft.elements[rowElement.id];
            var rowValues = rowState && rowState.state === 'set' ? rowState.value.value : [];
            draft.defined = true;
            draft.elements[rowElement.id] = { state: 'set', value: { kind: 'collection', value: rowValues } };
            if (config.rowIndex !== undefined && config.rowIndex !== null) editedRow = rowValues[config.rowIndex];
            else { editedRow = values.clone(config.initialRow || values.newRow(rowElement)); rowValues.push(editedRow); }
            (rowElement.fields || []).forEach(function(field) {
                if (rowWritable && securityModel.writableElement(policy, field.id) && field.required && (!editedRow[field.id] || editedRow[field.id].state !== 'set')) {
                    editedRow[field.id] = { state: 'set', value: field.element.value_type === 'enum' && !field.element.initial
                        ? { kind: 'enum', value: '' } : values.defaultTyped(field.element) };
                }
            });
        }
        var saving = false;
        var pendingConfirmation = null;
        var errorSlot;
        var rootBindings = new Map();

        function isDirty() { return !values.same(baseline, draft); }

        function scalarControl(control, element, context) {
            var state = context.getState(element.id);
            var writable = context.writable && !control.read_only;
            var required = element.required === true;
            var configured = createElement('input', { attrs: { type: 'checkbox' } });
            var labelText = createElement('span', {
                text: controlLabel(control, element, state)
            });
            configured.getElement().checked = state.state === 'set' || required;
            configured.getElement().disabled = !writable;
            var editor = values.inputFor(
                element,
                control,
                state.state === 'set' ? state.value : values.defaultTyped(element),
                !writable || (!required && state.state !== 'set')
            );
            editor.root.getElement().setAttribute('aria-label', controlLabel(control, element, state));
            var binding = { update: function(next, source) {
                configured.getElement().checked = next.state === 'set' || required;
                configured.getElement().disabled = !writable;
                labelText.getElement().textContent = controlLabel(control, element, next);
                if (!source) editor.write(next.state === 'set'
                    ? next.value : values.defaultTyped(element));
                editor.setDisabled(!writable || (!required && next.state !== 'set'));
            } };
            registerBinding(context.bindings, element.id, binding);
            function changed() {
                var next = configured.getElement().checked
                    ? { state: 'set', value: editor.read() }
                    : { state: 'unset' };
                context.setState(element.id, next);
                syncBindings(context.bindings, element.id, binding, next);
            }
            configured.on('change', changed);
            editor.root.getElement().addEventListener('input', changed);
            editor.root.getElement().addEventListener('change', changed);
            return createElement('div', {
                className: ['gpo-editor-field', !writable ? 'gpo-editor-field--readonly' : null],
                attrs: { 'data-security-element': element.id },
                children: [
                    createElement('label', {
                        className: ['field', 'field__checkbox'],
                        children: [required ? null : configured, labelText]
                    }),
                    createElement('div', {
                        className: 'field__element', children: [editor.root]
                    }),
                    control.integer_suffix ? createElement('span', {
                        className: 'gpo-editor-security-suffix', text: control.integer_suffix
                    }) : null,
                    rangeText(control, element) ? createElement('span', {
                        className: 'gpo-editor-security-range',
                        text: rangeText(control, element)
                    }) : null
                ]
            });
        }

        function collectionControl(control, element, context) {
            var container = createElement('div', {
                className: 'gpo-editor-security-collection',
                attrs: { 'data-security-element': element.id }
            });
            var writable = context.writable && !control.read_only && Boolean(element.unique_by);
            var state = context.getState(element.id);
            var configured = createElement('input', { attrs: { type: 'checkbox' } });
            configured.getElement().checked = state.state === 'set';
            configured.getElement().disabled = !writable;
            var rows = state.state === 'set'
                ? values.clone(state.value.value || []) : [];
            var rowsHost = createElement('div', { className: 'gpo-editor-security-collection__rows' });
            var add = createElement('button', {
                className: 'button', attrs: { type: 'button' },
                text: tr('security.addRow', 'Add row')
            });
            var binding = { update: function(next, source) {
                configured.getElement().checked = next.state === 'set';
                if (!source) {
                    rows = next.state === 'set' ? values.clone(next.value.value || []) : [];
                    renderRows();
                }
                add.getElement().disabled = !writable || !configured.getElement().checked
                    || !canCreateRow(element, control.children);
            } };
            registerBinding(context.bindings, element.id, binding);

            function sync() {
                var next = configured.getElement().checked
                    ? { state: 'set', value: { kind: 'collection', value: values.clone(rows) } }
                    : { state: 'unset' };
                context.setState(element.id, next);
                syncBindings(context.bindings, element.id, binding, next);
            }

            function renderRows() {
                rowsHost.getElement().innerHTML = '';
                rows.forEach(function(row, rowIndex) {
                    var rowRoot = createElement('div', {
                        className: 'gpo-editor-security-collection__row'
                    });
                    var fields = (element.fields || []).map(function(field) {
                        return Object.assign({}, field.element, { id: field.id });
                    });
                    var rowContext = {
                        writable: writable && configured.getElement().checked,
                        bindings: new Map(),
                        getState: function(id) { return row[id] || { state: 'unset' }; },
                        setState: function(id, next) { row[id] = next; sync(); }
                    };
                    (control.children || []).forEach(function(child) {
                        rowRoot.append(renderControl(child, fields, rowContext));
                    });
                    rowRoot.append(createElement('button', {
                        className: 'button',
                        attrs: { type: 'button', disabled: rowContext.writable ? null : 'disabled' },
                        text: tr('security.removeRow', 'Remove row'),
                        events: { click: function() {
                            rows.splice(rowIndex, 1); sync(); renderRows();
                        } }
                    }));
                    rowsHost.append(rowRoot);
                });
            }

            configured.on('change', function() {
                if (configured.getElement().checked && !rows.length) rows = [];
                sync();
                renderRows();
            });
            add.getElement().disabled = !writable || !configured.getElement().checked
                || !canCreateRow(element, control.children);
            add.on('click', function() {
                if (add.getElement().disabled) return;
                rows.push(values.newRow(element)); sync(); renderRows();
            });
            container.append(createElement('label', {
                className: ['field', 'field__checkbox'],
                children: [configured, createElement('span', {
                    text: control.label || element.id
                })]
            }));
            if (!element.unique_by) container.append(createElement('div', {
                className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--warning'],
                text: tr('security.readOnlyCollection',
                    'This collection has no stable row key and is read-only.')
            }));
            container.append(rowsHost);
            container.append(add);
            renderRows();
            return container;
        }

        function renderControl(control, elements, context) {
            if (control.kind === 'text') {
                return createElement('p', { text: control.text || control.label || '' });
            }
            if (control.kind === 'group') {
                var childContext = Object.assign({}, context, {
                    writable: context.writable && !control.read_only
                });
                return createElement('fieldset', {
                    className: 'gpo-editor-security-group',
                    children: [control.label ? createElement('legend', {
                        text: control.label
                    }) : null].concat((control.children || []).map(function(child) {
                        return renderControl(child, elements, childContext);
                    }))
                });
            }
            var element = (elements || []).find(function(item) {
                return item.id === control.element_id;
            });
            if (!element) return createElement('div', {
                className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--warning'],
                text: tr('security.unresolvedElement', 'This setting cannot be displayed:') + ' ' + (control.element_id || '')
            });
            return element.value_type === 'collection'
                ? collectionControl(control, element, context)
                : scalarControl(control, element, context);
        }

        function proposedUnit(policyId) {
            if (/^account\.password\.(minimum|maximum)_password_age$/.test(policyId)
                    || /^account\.kerberos\.max_renew_age$/.test(policyId)
                    || /^event_log\.(security|application|system)_log_retention_days$/.test(policyId)) {
                return tr('security.dependency.days', 'day(s)');
            }
            if (/^account\.kerberos\.max_ticket_age$/.test(policyId)) {
                return tr('security.dependency.hours', 'hour(s)');
            }
            if (/^account\.kerberos\.max_service_age$/.test(policyId)
                    || /^account\.lockout\.(reset_lockout_count|lockout_duration)$/.test(policyId)) {
                return tr('security.dependency.minutes', 'minute(s)');
            }
            if (/^account\.lockout\.lockout_bad_count$/.test(policyId)) {
                return tr('security.dependency.attempts', 'attempt(s)');
            }
            return '';
        }

        function proposedValue(change) {
            if (!change.draft.defined) return tr('security.dependency.notConfigured', 'Not configured');
            var parts = (change.policy.definition.elements || []).filter(function(element) {
                return change.draft.elements[element.id]
                    && change.draft.elements[element.id].state === 'set';
            }).map(function(element) {
                var typed = change.draft.elements[element.id].value;
                if (typed.kind === 'boolean') return typed.value
                    ? tr('security.enabled', 'Enabled') : tr('security.disabled', 'Disabled');
                if (typed.kind === 'enum') {
                    var option = (element.options || []).find(function(item) { return item.id === typed.value; });
                    return option ? option.display_name || option.id : typed.value;
                }
                if (typed.kind === 'integer') {
                    var unit = proposedUnit(change.policy.policyId);
                    return String(typed.value) + (unit ? ' ' + unit : '');
                }
                return String(typed.value);
            });
            return parts.join('; ') || '—';
        }

        function confirmDependencies(changes) {
            return new Promise(function(resolve) {
                var host = root.getElement().closest('.gpo-security-dialog-host');
                if (!host) { resolve(false); return; }
                var modal = root.getElement().closest('.gpo-security-dialog');
                var table = createElement('table', {
                    className: ['preference__table', 'gpo-security-table'],
                    children: [
                        createElement('thead', { children: [createElement('tr', { children: [
                            createElement('th', { text: tr('security.dependency.policy', 'Policy') }),
                            createElement('th', { text: tr('security.dependency.value', 'Value') })
                        ] })] }),
                        createElement('tbody', { children: changes.map(function(change) {
                            return createElement('tr', { children: [
                                createElement('td', { text: change.policy.definition.display_name || change.policy.policyId }),
                                createElement('td', { text: proposedValue(change) })
                            ] });
                        }) })
                    ]
                });
                var content = createElement('div', { children: [
                    createElement('p', { text: tr('security.dependency.intro',
                        'To save this policy, apply the following related settings as well.') }),
                    table
                ] });
                function finish(confirmed) {
                    if (modal) {
                        modal.inert = false;
                        modal.classList.remove('gpo-security-dialog--confirming');
                    }
                    pendingConfirmation = null;
                    resolve(confirmed);
                }
                pendingConfirmation = {
                    dialog: confirmationDialog.open(host, {
                        title: tr('security.dependency.title', 'Related policy settings'),
                        content: content,
                        confirmLabel: tr('security.dependency.apply', 'Apply changes'),
                        cancelLabel: tr('security.dependency.cancel', 'Cancel'),
                        onConfirm: function() { finish(true); },
                        onCancel: function() { finish(false); }
                    }),
                    cancel: function() { this.dialog.close(); finish(false); }
                };
                if (modal) {
                    modal.inert = true;
                    modal.classList.add('gpo-security-dialog--confirming');
                }
            });
        }

        async function save() {
            if (saving || !isDirty()) return true;
            var error = validateDraft(policy, draft);
            if (error) {
                errorSlot.getElement().textContent = error;
                errorSlot.getElement().focus();
                return false;
            }
            saving = true;
            try {
                var plan = dependencies.plan(model, policy, draft);
                var changes = plan && plan.changes || [];
                for (var change of changes) {
                    var dependentError = validateDraft(change.policy, change.draft);
                    if (dependentError) {
                        errorSlot.getElement().textContent = dependentError;
                        errorSlot.getElement().focus();
                        return false;
                    }
                }
                if (changes.length && !await confirmDependencies(changes)) return false;
                var request = updateRequest(model, policy, baseline, draft);
                changes.forEach(function(change) {
                    var previous = initialDraft(change.policy);
                    request.policies.push(updateRequest(model, change.policy, previous, change.draft).policies[0]);
                });
                var response = await API.securityDefinitionsUpdate(
                    request
                );
                var refreshed = securityModel.buildSecurityModel(response);
                Object.keys(refreshed).forEach(function(key) { model[key] = refreshed[key]; });
                policy = securityModel.policy(model, item.securityPolicy);
                baseline = initialDraft(policy);
                draft = values.clone(baseline);
                if (config.onSaved) config.onSaved(response);
                return true;
            } catch (failure) {
                errorSlot.getElement().innerHTML = '';
                errorSlot.append(editorStatus.renderError(failure));
                var diagnostics = failure && failure.details
                    && Array.isArray(failure.details.diagnostics)
                    ? failure.details.diagnostics : [];
                if (diagnostics.length) errorSlot.append(editorStatus.renderDiagnostics(diagnostics));
                return false;
            } finally {
                saving = false;
            }
        }

        function renderContent() {
            root.getElement().innerHTML = '';
            rootBindings = new Map();
            errorSlot = createElement('div', { className: 'gpo-editor-preferences__error', attrs: { role: 'alert', tabindex: '-1' } });
            (policy.definition.notices || []).forEach(function(notice) {
                root.append(createElement('div', {
                    className: ['gpo-editor-preference-notice', 'gpo-editor-preference-notice--warning'],
                    text: notice
                }));
            });
            if (policy.diagnostics.length) root.append(editorStatus.renderDiagnostics(policy.diagnostics));
            root.append(errorSlot);
            var defined = createElement('input', { attrs: { type: 'checkbox', 'data-security-define': '' } });
            defined.getElement().checked = draft.defined;
            defined.on('change', function() {
                draft.defined = defined.getElement().checked;
                if (draft.defined) (policy.definition.elements || []).forEach(function(element) {
                    if (element.required && securityModel.writableElement(policy, element.id) && draft.elements[element.id].state !== 'set') {
                        draft.elements[element.id] = { state: 'set', value: values.defaultTyped(element) };
                    }
                });
                renderContent();
                var currentDefine = root.getElement().querySelector('[data-security-define]');
                if (currentDefine) currentDefine.focus();
            });
            if (!rowElement) root.append(createElement('label', {
                className: ['field', 'field__checkbox', 'gpo-security-policy-editor__define'],
                children: [defined, createElement('span', {
                    text: tr('security.definePolicy', 'Define this policy')
                })]
            }));
            var displayedControls = policy.controls;
            var displayedElements = policy.definition.elements;
            if (rowElement) {
                var collectionControlDefinition;
                function findCollection(controls) {
                    (controls || []).forEach(function(control) {
                        if (control.element_id === rowElement.id) collectionControlDefinition = control;
                        findCollection(control.children);
                    });
                }
                findCollection(policy.controls);
                displayedControls = collectionControlDefinition && collectionControlDefinition.children || [];
                displayedElements = rowElement.fields.map(function(field) { return Object.assign({}, field.element, { id: field.id, required: field.required }); });
                if (!displayedControls.length) displayedControls = rowElement.fields.map(function(field) { return { element_id: field.id, label: field.display_name || field.id }; });
            }
            var controls = createElement('div', {
                className: 'gpo-editor-security-controls',
                children: displayedControls.map(function(control) {
                    return renderControl(control, displayedElements, {
                        writable: draft.defined && rowWritable,
                        bindings: rootBindings,
                        getState: function(id) {
                            return (editedRow || draft.elements)[id] || { state: 'unset' };
                        },
                        setState: function(id, next) { (editedRow || draft.elements)[id] = next; }
                    });
                })
            });
            root.append(controls);
            var explanation = [policy.definition.explain_text, policy.definition.allowed_values, policy.definition.default_text].filter(Boolean);
            var settingsPanel = createElement('div');
            while (root.getElement().firstChild) settingsPanel.getElement().appendChild(root.getElement().firstChild);
            var explanationPanel = createElement('div', { className: 'gpo-security-explanation', children: [
                createElement('h3', { text: policy.definition.display_name || policy.policyId })
            ].concat((explanation.length ? explanation : [tr('security.noExplanation', 'No explanation is available for this setting.')]).map(function(text) { return createElement('p', { text: text }); })) });
            root.append(dialogs.tabs(settingsPanel, explanationPanel));
        }

        renderContent();
        root.hasUnsavedChanges = isDirty;
        root.readOnly = Boolean(rowElement && !rowWritable);
        root.applyChanges = save;
        root.cancelChanges = function() {
            draft = values.clone(baseline); renderContent(); return true;
        };
        root.cleanup = function() {
            if (pendingConfirmation) pendingConfirmation.cancel();
        };
        return root;
    }

    return {
        renderSecurityTemplate: function(options) { return workbench.render(options, renderPolicyEditor); },
        openSecurityDialog: function(host, options) { return workbench.openPolicyDialog(host, options, renderPolicyEditor); },
        _test: {
            initialDraft: initialDraft,
            updateRequest: updateRequest,
            validateDraft: validateDraft,
            controlLabel: controlLabel,
            rangeText: rangeText
        }
    };
});
