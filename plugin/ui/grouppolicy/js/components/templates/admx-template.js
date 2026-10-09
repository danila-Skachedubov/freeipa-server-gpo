define([
    '../../util/element-creator',
    '../../util/API',
    '../../util/editor-dto',
    '../editor-status',
    '../../locales/translations',
    '../collection-control',
    '../editor-dialog',
    './security/dialog',
    '../confirmation-dialog'
], function(elementCreator, API, dto, editorStatus, translations, collectionControls, editorDialog, policyTabs, confirmationDialog) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;
    var nextParameterControlId = 1;

    function appendLines(container, text) {
        String(text || '').split(/\r?\n/).forEach(function(line, index) {
            if (index) container.appendChild(document.createElement('br'));
            container.appendChild(document.createTextNode(line));
        });
    }

    function inputValue(value) {
        var payload = dto.valuePayload(value);
        return Array.isArray(payload) ? payload.join('\n') : (payload === null || payload === undefined ? '' : payload);
    }

    function createParameterControl(parameter, editable) {
        var knownKinds = ['boolean', 'decimal', 'enum', 'text', 'list'];
        var unsupportedValue = parameter.value && parameter.value.kind === 'unsupported';
        var unsupportedDefault = (parameter.value === null || parameter.value === undefined)
            && parameter.default_value
            && parameter.default_value.kind === 'unsupported';
        var unsupported = unsupportedValue || knownKinds.indexOf(parameter.kind) === -1;
        var disabled = !editable || parameter.editable === false || unsupported;
        var input;
        var inputElement = null;
        var collectionControl = null;
        var renderedValue = parameter.value === null || parameter.value === undefined
            ? (unsupportedDefault ? null : parameter.default_value)
            : parameter.value;
        var choices = parameter.choices || [];

        if (unsupported) {
            input = createElement('pre', {
                className: ['gpo-editor-unsupported', 'field__element'],
                text: JSON.stringify(
                    renderedValue && renderedValue.value !== undefined
                        ? renderedValue.value
                        : { kind: parameter.kind, value: renderedValue },
                    null,
                    2
                )
            });
        } else if (parameter.kind === 'boolean') {
            var checkboxId = 'gpo-editor-parameter-' + nextParameterControlId++;
            var checkbox = createElement('input', {
                attrs: {
                    id: checkboxId,
                    type: 'checkbox',
                    disabled: disabled ? 'disabled' : null
                }
            });
            inputElement = checkbox.getElement();
            inputElement.checked = Boolean(inputValue(renderedValue));
            input = createElement('span', {
                className: 'gpo-editor-boolean',
                children: [
                    checkbox,
                    createElement('label', {
                        attrs: {
                            for: checkboxId,
                            'aria-label': parameter.label || parameter.id
                        }
                    })
                ]
            });
        } else if (parameter.kind === 'enum') {
            input = createElement('select', {
                attrs: { disabled: disabled ? 'disabled' : null },
                children: [
                    !parameter.required ? createElement('option', { attrs: { value: '' }, text: '—' }) : null
                ].concat(choices.map(function(choice, index) {
                    return createElement('option', {
                        attrs: {
                            value: String(index),
                            disabled: choice.value && choice.value.kind === 'unsupported' ? 'disabled' : null
                        },
                        text: choice.label || String(dto.valuePayload(choice.value))
                    });
                }))
            });
            var selectedIndex = choices.findIndex(function(choice) {
                return dto.equal(choice.value, renderedValue);
            });
            input.getElement().value = selectedIndex < 0 ? '' : String(selectedIndex);
        } else if (parameter.kind === 'list') {
            collectionControl = collectionControls.createControl(parameter, renderedValue, !disabled);
            input = collectionControl.element;
            inputElement = collectionControl.button;
        } else {
            input = createElement('input', {
                attrs: {
                    type: parameter.kind === 'decimal' ? 'number' : 'text',
                    min: parameter.min_value,
                    max: parameter.max_value,
                    maxlength: parameter.max_length,
                    required: parameter.required ? 'required' : null,
                    disabled: disabled ? 'disabled' : null,
                    value: inputValue(renderedValue)
                }
            });
        }

        if (!inputElement) inputElement = input.getElement();
        if (!unsupported && !collectionControl) inputElement.setAttribute('aria-label', parameter.label || parameter.id);
        var stateDisabled = false;

        function syncControlState() {
            var unavailable = disabled || unsupported || stateDisabled;
            if (collectionControl) collectionControl.setEditable(!unavailable);
            else inputElement.disabled = unavailable;
        }
        syncControlState();

        function read() {
            if (unsupported) return dto.clone(parameter.value);
            if (collectionControl) return collectionControl.read();
            if (parameter.kind === 'enum') {
                return dto.policyChoiceValue(choices, inputElement.value);
            }
            return dto.typedValueFromInput(
                parameter.value,
                parameter.kind,
                inputElement.value,
                inputElement.checked
            );
        }

        return {
            element: createElement('div', {
                className: [
                    'gp__admx-options',
                    collectionControl ? 'gp__admx-options--collection' : null,
                    unsupported ? 'gpo-editor-field--unsupported' : null,
                    unsupportedDefault ? 'gpo-editor-field--unsupported-default' : null
                ],
                attrs: { 'data-field-id': parameter.id },
                children: [
                    input,
                    unsupportedDefault ? createElement('span', {
                        className: 'gpo-editor-field__diagnostic',
                        text: t('policies.unsupportedDefault')
                    }) : null
                ]
            }),
            read: read,
            input: inputElement,
            destroy: function() { if (collectionControl) collectionControl.destroy(); },
            hasOpenDialog: function() { return Boolean(collectionControl && collectionControl.hasOpenDialog()); },
            hasUnsavedDialogChanges: function() { return Boolean(collectionControl && collectionControl.hasUnsavedChanges()); },
            setDisabled: function(shouldDisable) {
                stateDisabled = Boolean(shouldDisable);
                syncControlState();
            }
        };
    }

    function renderPolicyContents(root, policy, handlers) {
        var capabilities = policy.capabilities || {};
        var unknown = policy.state === 'unknown_raw_values';
        var controls = new Map();
        var stateNames = {
            not_configured: t('policies.notConfigured'),
            enabled: t('policies.enabled'),
            disabled: t('policies.disabled')
        };

        var stateControls = Object.keys(stateNames).map(function(state) {
            var allowed = dto.canSelectPolicyState(policy, state);
            var radio = createElement('input', {
                attrs: {
                    type: 'radio',
                    name: 'admx-state',
                    value: state,
                    checked: policy.state === state ? 'checked' : null,
                    disabled: allowed ? null : 'disabled'
                }
            });
            return createElement('label', {
                className: ['gp__admx-radio', allowed ? null : 'gpo-editor-control--disabled'],
                children: [radio, createElement('span', { text: stateNames[state] })]
            });
        });

        var parameterRows = (capabilities.inspect_parameters ? policy.parameters || [] : []).map(function(parameter) {
            // Compatibility with installed bindings that predate list metadata.
            if (parameter.kind === 'list' && !parameter.collection
                    && dto.policyStateAction(policy, 'enabled').mode === 'dynamic_list_values') {
                parameter = Object.assign({}, parameter, { collection: {
                    mode: parameter.value && parameter.value.kind === 'key_value_list' ? 'key_value' : 'list',
                    unique_keys: true, key_case_sensitive: false, allow_empty_values: false, min_items: 1
                } });
            }
            var control = createParameterControl(
                parameter,
                Boolean(capabilities.edit_parameters) && !unknown
            );
            if (handlers.modalLayout) control.element.addClass('field__element');
            controls.set(parameter.id, control);
            return createElement('div', {
                className: 'gp__admx-item',
                children: [
                    createElement('div', {
                        className: 'gp__admx-description',
                        text: parameter.label || parameter.id
                    }),
                    control.element
                ]
            });
        });

        var comment = createElement('textarea', {
            attrs: {
                name: 'comment',
                disabled: capabilities.edit_comments && !unknown ? null : 'disabled'
            },
            text: policy.comment ? policy.comment.text : ''
        });
        var errorSlot = createElement('div', { className: 'gpo-editor-form__error' });
        var wrapper = createElement('div', {
            className: 'gp__admx-wrapper',
            children: [
                handlers.categoryPath ? createElement('div', { className: 'gpo-security-workbench__toolbar', children: [
                    createElement('h2', { text: handlers.categoryPath, attrs: { 'data-category-path': '' } })
                ] }) : null,
                errorSlot,
                unknown ? createElement('div', {
                    className: ['gpo-editor-status', 'gpo-editor-status--unsupported'],
                    attrs: { role: 'status' },
                    text: t('policies.unsupportedSource')
                }) : null,
                createElement('div', {
                    className: ['gp__admx', (policy.parameters || []).some(function(parameter) {
                        return parameter.kind === 'list';
                    }) ? 'gp__admx--collections' : null],
                    children: [
                        createElement('div', {
                            className: 'gp__admx-settings',
                            children: [
                                createElement('div', {
                                    className: 'title',
                                    children: [t('policies.policy') + ' ', createElement('span', {
                                        className: 'title__name', text: policy.label || policy.policy_id
                                    })]
                                }),
                                createElement('div', {
                                    className: 'gp__admx-state-policy-title',
                                    text: t('policies.policyState')
                                }),
                                createElement('div', {
                                    className: 'gp__admx-state-policy',
                                    children: stateControls
                                }),
                                createElement('div', { className: 'field__line' })
                            ]
                        }),
                        createElement('div', {
                            className: 'gp__admx-info',
                            children: parameterRows.length ? [
                                createElement('div', {
                                    className: 'gp__admx-item',
                                    children: [
                                        createElement('div', { className: 'gp__admx-description', text: t('common.description') }),
                                        createElement('div', { className: 'gp__admx-options', text: t('common.options') })
                                    ]
                                })
                            ].concat(parameterRows) : []
                        })
                    ]
                }),
                createElement('div', {
                    className: ['gp__admx-help', handlers.isHelpOpen ? 'is-open' : null],
                    children: [
                        createElement('div', {
                            className: 'gp__admx-supported',
                            children: [
                                createElement('div', { className: 'title', text: t('policies.supportedOn') }),
                                createElement('div', { className: 'gp__admx-content', text: policy.supported_on || '' })
                            ]
                        }),
                        createElement('div', {
                            className: 'gp__admx-comment',
                            children: [createElement('div', { className: 'title', text: t('common.comment') }), comment]
                        }),
                        createElement('div', {
                            className: 'gp__admx-text-help',
                            children: [
                                createElement('div', { className: 'title', text: t('common.help') }),
                                createElement('div', { className: 'gp__admx-content' })
                            ]
                        })
                    ]
                })
            ]
        });
        root.innerHTML = '';
        if (handlers.modalLayout) {
            var settings = createElement('div', {
                className: 'gpo-admx-dialog__settings',
                children: [
                    errorSlot,
                    unknown ? createElement('div', {
                        className: ['gpo-editor-status', 'gpo-editor-status--unsupported'],
                        attrs: { role: 'status' }, text: t('policies.unsupportedSource')
                    }) : null,
                    createElement('div', {
                        className: 'gp__admx-settings',
                        children: [
                            createElement('div', { className: 'gp__admx-state-policy-title', text: t('policies.policyState') }),
                            createElement('div', { className: 'gp__admx-state-policy', children: stateControls })
                        ]
                    })
                ].concat(parameterRows, [createElement('div', {
                    className: 'gpo-admx-dialog__comment',
                    children: [
                        createElement('label', { text: t('common.comment'), attrs: { for: 'admx-comment-' + nextParameterControlId } }),
                        createElement('div', { className: 'field__element', children: [comment] })
                    ]
                })])
            });
            comment.getElement().id = 'admx-comment-' + nextParameterControlId++;
            var supported = createElement('p');
            appendLines(supported.getElement(), policy.supported_on || '—');
            var help = createElement('p');
            appendLines(help.getElement(), policy.explain_text || t('security.noExplanation'));
            var explanation = createElement('div', {
                className: 'gpo-admx-dialog__explanation',
                children: [
                    createElement('h3', { text: t('policies.supportedOn') }), supported,
                    createElement('h3', { text: t('security.explanationTab') }), help
                ]
            });
            var tabs = policyTabs.tabs(settings, explanation);
            tabs.getElement().querySelector('[role="tab"]').textContent = t('policies.parametersTab');
            root.appendChild(tabs.getElement());
        } else {
            root.appendChild(wrapper.getElement());
            appendLines(root.querySelector('.gp__admx-text-help .gp__admx-content'), policy.explain_text || '');
        }

        function selectedState() {
            var selected = root.querySelector('input[name="admx-state"]:checked');
            return selected ? selected.value : policy.state;
        }

        function syncPolicyState() {
            var editable = dto.canEditPolicyParameters(policy, selectedState());
            controls.forEach(function(control) {
                control.setDisabled(!editable);
            });
            return editable;
        }

        syncPolicyState();

        function readDraft() {
            return {
                state: selectedState(),
                parameters: (policy.parameters || []).map(function(parameter) {
                    return {
                        parameter_id: parameter.id,
                        value: controls.has(parameter.id) ? controls.get(parameter.id).read() : dto.clone(parameter.value)
                    };
                }),
                comment: comment.getElement().value
            };
        }

        return {
            readDraft: readDraft,
            syncPolicyState: syncPolicyState,
            errorSlot: errorSlot.getElement(),
            controls: controls,
            hasOpenDialog: function() {
                return Array.from(controls.values()).some(function(control) { return control.hasOpenDialog(); });
            },
            hasUnsavedDialogChanges: function() {
                return Array.from(controls.values()).some(function(control) { return control.hasUnsavedDialogChanges(); });
            },
            destroy: function() { controls.forEach(function(control) { control.destroy(); }); }
        };
    }

    async function renderAdmxTemplate(options) {
        var config = options || {};
        var item = config.item || {};
        var root = createElement('div', { className: 'gpo-editor-policy' });
        var headerElement = config.header && config.header.getElement ? config.header.getElement() : null;
        var actions = headerElement ? headerElement.querySelector('.gp__control-actions') : null;
        var preferenceActions = headerElement ? headerElement.querySelector('.gp__control') : null;
        var applyButton = headerElement ? headerElement.querySelector('.admx__btn-apply') : null;
        var cancelButton = headerElement ? headerElement.querySelector('.admx__btn-cancel') : null;
        var policy;
        var view;
        var baseline;
        var saving = false;

        if (actions) actions.style.display = 'flex';
        if (preferenceActions) preferenceActions.style.display = 'none';

        try {
            var response = await API.policyShow(item.scope, item.policyId);
            policy = response.policy || response;
        } catch (error) {
            root.append(editorStatus.renderError(error, {
                onRefresh: config.onLoadRefresh || function() { window.location.reload(); },
                onReconcile: function() { API.reconcile(); }
            }));
            root.cleanup = function() {
                if (actions) actions.style.display = 'none';
            };
            return root;
        }

        if (typeof config.isCurrent === 'function' && !config.isCurrent()) {
            if (actions) actions.style.display = 'none';
            return root;
        }

        function render() {
            if (view) view.destroy();
            view = renderPolicyContents(root.getElement(), policy, {
                isHelpOpen: config.isHelpOpen, categoryPath: config.categoryPath, modalLayout: config.modalLayout
            });
            baseline = view.readDraft();
            refreshButtons();
            if (config.onRendered) config.onRendered(policy);
        }

        function hasUnsavedPolicyChanges() {
            return Boolean(view) && !dto.equal(view.readDraft(), baseline);
        }

        function hasUnsavedChanges() {
            return hasUnsavedPolicyChanges() || Boolean(view && view.hasUnsavedDialogChanges());
        }

        function refreshButtons() {
            var active = !saving && hasUnsavedPolicyChanges();
            if (applyButton) applyButton.classList.toggle('active', active);
            if (cancelButton) cancelButton.classList.toggle('active', active);
        }

        function showError(error) {
            if (!view || !view.errorSlot) return;
            view.errorSlot.innerHTML = '';
            var category = dto.errorCategory(error);
            var errorActions = {
                onReconcile: async function(event) {
                    event.currentTarget.disabled = true;
                    try { await API.reconcile(); }
                    catch (reconcileError) { showError(reconcileError); }
                    finally { event.currentTarget.disabled = false; }
                }
            };
            if (category === 'storage_conflict' || category === 'publication_conflict' || category === 'not_found') {
                errorActions.onRefresh = async function() {
                    var confirmed = config.confirmRefresh
                        ? await config.confirmRefresh()
                        : window.confirm(t('collections.discardQuestion'));
                    if (!confirmed) return;
                    try {
                        var response = await API.policyShow(item.scope, item.policyId);
                        policy = response.policy || response;
                        render();
                    } catch (refreshError) {
                        showError(refreshError);
                    }
                };
            }
            view.errorSlot.appendChild(editorStatus.renderError(error, errorActions).getElement());
            if (error && error.field) {
                view.controls.forEach(function(control, id) {
                    if (error.field === id || String(error.field).indexOf(id) !== -1) {
                        control.element.getElement().classList.add('gpo-editor-field--error');
                    }
                });
            }
        }

        async function applyChanges() {
            if (saving) return false;
            // Finish the collection dialog first, even if it is still clean:
            // otherwise new edits during an in-flight save would be lost when
            // its response replaces the form. OK/Cancel still belongs to it.
            if (view.hasOpenDialog()) return false;
            var draft = view.readDraft();
            var validationError = dto.validatePolicyDraft(policy, draft);
            if (validationError) {
                showError(validationError);
                return false;
            }
            var request = dto.buildPolicyUpdate(policy, draft, baseline);
            if (!dto.hasOperations(request)) return true;
            saving = true;
            root.getElement().inert = true;
            refreshButtons();
            try {
                var outcome = await dto.submitPreservingDraft(draft, function() {
                    return API.policyUpdate(item.scope, item.policyId, request);
                });
                if (!outcome.ok) {
                    showError(outcome.error);
                    return false;
                }
                policy = outcome.response.policy || outcome.response;
                render();
                if (config.onSaved) config.onSaved(outcome.response);
                return true;
            } finally {
                saving = false;
                root.getElement().inert = false;
                refreshButtons();
            }
        }

        function cancelChanges() {
            render();
        }

        function handleChange() {
            if (view && typeof view.syncPolicyState === 'function') view.syncPolicyState();
            refreshButtons();
            if (config.onDraftChange) config.onDraftChange();
        }
        function handleApply() { if (applyButton && applyButton.classList.contains('active')) void applyChanges(); }
        function handleCancel() { if (cancelButton && cancelButton.classList.contains('active')) cancelChanges(); }
        root.getElement().addEventListener('input', handleChange);
        root.getElement().addEventListener('change', handleChange);
        if (applyButton) applyButton.addEventListener('click', handleApply);
        if (cancelButton) cancelButton.addEventListener('click', handleCancel);

        root.hasUnsavedChanges = hasUnsavedChanges;
        root.applyChanges = applyChanges;
        root.cancelChanges = cancelChanges;
        root.canApply = function() {
            return Boolean(policy && policy.state !== 'unknown_raw_values' && (
                policy.capabilities && policy.capabilities.edit_comments
                || ['enabled', 'disabled', 'not_configured'].some(function(state) { return dto.canSelectPolicyState(policy, state); })
                || dto.canEditPolicyParameters(policy)
            ));
        };
        root.cleanup = function() {
            if (view) view.destroy();
            root.getElement().removeEventListener('input', handleChange);
            root.getElement().removeEventListener('change', handleChange);
            if (applyButton) applyButton.removeEventListener('click', handleApply);
            if (cancelButton) cancelButton.removeEventListener('click', handleCancel);
            if (actions) actions.style.display = 'none';
            if (applyButton) applyButton.classList.remove('active');
            if (cancelButton) cancelButton.classList.remove('active');
        };
        render();
        return root;
    }

    function openAdmxDialog(host, options) {
        var config = options || {};
        var item = config.item || {};
        var content = createElement('div', { className: 'gpo-admx-dialog__content', children: [
            createElement('div', { className: 'gpo-admx-dialog__loading', attrs: { role: 'status' }, text: t('treeView.loadingPolicies') })
        ] });
        var currentEditor = null;
        var closed = false;
        var refreshConfirmation = null;
        var finishRefreshConfirmation = null;
        var loadSequence = 0;
        function isCurrent() {
            return !closed && (!config.isCurrent || config.isCurrent());
        }
        function cleanupEditor() {
            if (closed) return;
            closed = true;
            if (refreshConfirmation) refreshConfirmation.close();
            if (finishRefreshConfirmation) finishRefreshConfirmation(false);
            if (currentEditor && currentEditor.cleanup) currentEditor.cleanup();
            currentEditor = null;
            if (config.onClose) config.onClose();
        }
        var editor = {
            getElement: function() { return content.getElement(); },
            hasUnsavedChanges: function() { return Boolean(!closed && currentEditor && currentEditor.hasUnsavedChanges && currentEditor.hasUnsavedChanges()); },
            applyChanges: function() { return isCurrent() && currentEditor && currentEditor.applyChanges ? currentEditor.applyChanges() : Promise.resolve(false); },
            cancelChanges: function() { if (currentEditor && currentEditor.cancelChanges) currentEditor.cancelChanges(); },
            isReady: function() { return Boolean(currentEditor && currentEditor.applyChanges); },
            cleanup: function() { dialog.close(); }
        };
        var dialog = editorDialog.open(host, {
            title: item.title || item.label || item.policyId,
            className: ['gpo-admx-dialog'], content: content,
            applyLabel: t('security.apply'), cancelLabel: t('security.cancel'),
            applyDisabled: true,
            restoreFocus: config.restoreFocus,
            isDirty: editor.hasUnsavedChanges,
            onApply: editor.applyChanges,
            onClose: cleanupEditor
        });
        function confirmRefresh() {
            if (!isCurrent() || refreshConfirmation) return Promise.resolve(false);
            return new Promise(function(resolve) {
                var modal = dialog.root.getElement();
                var previousFocus = document.activeElement;
                modal.inert = true;
                modal.classList.add('gpo-editor-dialog--confirming');
                finishRefreshConfirmation = function(confirmed) {
                    refreshConfirmation = null;
                    finishRefreshConfirmation = null;
                    modal.inert = false;
                    modal.classList.remove('gpo-editor-dialog--confirming');
                    if (!closed && previousFocus && previousFocus.isConnected) previousFocus.focus();
                    resolve(confirmed);
                };
                refreshConfirmation = confirmationDialog.open(modal.parentElement, {
                    message: t('collections.discardQuestion'),
                    onConfirm: function() { finishRefreshConfirmation(true); },
                    onCancel: function() { finishRefreshConfirmation(false); }
                });
            });
        }
        function load() {
            var sequence = ++loadSequence;
            function ownsLoad() { return isCurrent() && sequence === loadSequence; }
            return renderAdmxTemplate({
                item: item, modalLayout: true, isCurrent: ownsLoad, confirmRefresh: confirmRefresh,
                onSaved: function(response) { if (ownsLoad() && config.onSaved) config.onSaved(response); },
                onLoadRefresh: function() {
                    if (!ownsLoad()) return;
                    if (currentEditor && currentEditor.cleanup) currentEditor.cleanup();
                    currentEditor = null;
                    dialog.setApplyDisabled(true);
                    content.getElement().replaceChildren(createElement('div', {
                        className: 'gpo-admx-dialog__loading', attrs: { role: 'status' }, text: t('treeView.loadingPolicies')
                    }).getElement());
                    editor.ready = load();
                },
                onRendered: function(policy) {
                    if (!ownsLoad()) return;
                    var title = dialog.root.getElement().querySelector('.preference__modal-header .title');
                    title.textContent = policy.label || item.title || policy.policy_id;
                }
            }).then(function(loaded) {
                if (!ownsLoad()) {
                    if (loaded.cleanup) loaded.cleanup();
                    if (!closed && !isCurrent()) dialog.close();
                    return false;
                }
                currentEditor = loaded;
                content.getElement().replaceChildren(loaded.getElement());
                dialog.setApplyDisabled(!loaded.canApply || !loaded.canApply());
                return Boolean(loaded.applyChanges);
            }).catch(function(error) {
                if (ownsLoad()) content.getElement().replaceChildren(editorStatus.renderError(error).getElement());
                else if (!closed && !isCurrent()) dialog.close();
                return false;
            });
        }
        editor.ready = load();
        return { editor: editor, dialog: dialog };
    }

    return { renderAdmxTemplate: renderAdmxTemplate, openAdmxDialog: openAdmxDialog, _test: { createParameterControl: createParameterControl } };
});
