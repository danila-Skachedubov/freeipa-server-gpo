define([
    '../../util/element-creator',
    '../../util/API',
    '../../util/editor-dto',
    '../editor-status',
    '../../locales/translations'
], function(elementCreator, API, dto, editorStatus, translations) {
    "use strict";

    var createElement = elementCreator.createElement;
    var t = translations.t;

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
            input = createElement('input', {
                attrs: { type: 'checkbox', disabled: disabled ? 'disabled' : null }
            });
            input.getElement().checked = Boolean(inputValue(renderedValue));
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
            input = createElement('textarea', {
                attrs: {
                    disabled: disabled ? 'disabled' : null,
                    maxlength: parameter.max_length
                },
                text: inputValue(renderedValue)
            });
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

        var inputElement = input.getElement();
        var clear = !parameter.required && !unsupported ? createElement('label', {
            className: 'gpo-editor-field__clear',
            children: [
                createElement('input', {
                    attrs: { type: 'checkbox', disabled: disabled ? 'disabled' : null }
                }),
                createElement('span', { text: 'Очистить значение' })
            ]
        }) : null;
        var clearInput = clear ? clear.getElement().querySelector('input') : null;

        function read() {
            if (unsupported) return dto.clone(parameter.value);
            if (clearInput && clearInput.checked) return null;
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
                    unsupported ? 'gpo-editor-field--unsupported' : null,
                    unsupportedDefault ? 'gpo-editor-field--unsupported-default' : null
                ],
                attrs: { 'data-field-id': parameter.id },
                children: [
                    input,
                    clear,
                    unsupportedDefault ? createElement('span', {
                        className: 'gpo-editor-field__diagnostic',
                        text: 'Значение по умолчанию шаблона не поддерживается; выберите значение явно.'
                    }) : null
                ]
            }),
            read: read,
            input: inputElement,
            clear: clearInput,
            setDisabled: function(shouldDisable) {
                inputElement.disabled = disabled || unsupported || Boolean(shouldDisable);
                if (clearInput) clearInput.disabled = disabled || unsupported || Boolean(shouldDisable);
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
            var control = createParameterControl(
                parameter,
                Boolean(capabilities.edit_parameters) && !unknown
            );
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
                errorSlot,
                unknown ? createElement('div', {
                    className: ['gpo-editor-status', 'gpo-editor-status--unsupported'],
                    attrs: { role: 'status' },
                    text: 'Политика содержит неподдерживаемые исходные значения и доступна только для чтения.'
                }) : null,
                createElement('div', {
                    className: 'gp__admx',
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
        root.appendChild(wrapper.getElement());
        var explanation = root.querySelector('.gp__admx-text-help .gp__admx-content');
        appendLines(explanation, policy.explain_text || '');

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
            controls: controls
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
                onRefresh: function() { window.location.reload(); },
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
            view = renderPolicyContents(root.getElement(), policy, { isHelpOpen: config.isHelpOpen });
            baseline = view.readDraft();
            refreshButtons();
        }

        function hasUnsavedChanges() {
            return Boolean(view) && !dto.equal(view.readDraft(), baseline);
        }

        function refreshButtons() {
            var active = !saving && hasUnsavedChanges();
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
                    if (!window.confirm('Обновить форму и отбросить текущий черновик?')) return;
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
            var draft = view.readDraft();
            var request = dto.buildPolicyUpdate(policy, draft, baseline);
            if (!dto.hasOperations(request)) return true;
            saving = true;
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
                return true;
            } finally {
                saving = false;
                refreshButtons();
            }
        }

        function cancelChanges() {
            render();
        }

        function handleChange() {
            if (view && typeof view.syncPolicyState === 'function') view.syncPolicyState();
            refreshButtons();
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
        root.cleanup = function() {
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

    return { renderAdmxTemplate: renderAdmxTemplate, _test: { createParameterControl: createParameterControl } };
});
