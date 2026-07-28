/** Pure helpers for preserving libadmix discriminated values in browser forms. */
define([], function() {
    "use strict";

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function equal(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function valuePayload(value) {
        if (!value || typeof value !== "object") return value;
        if (value.kind === "registry") return value.value ? value.value.value : null;
        if (value.kind === "unsupported") return null;
        return value.value;
    }

    function typedValueFromInput(original, kind, raw, checked) {
        if (original && original.kind === "unsupported") return clone(original);
        if (kind === "boolean") return { kind: "boolean", value: Boolean(checked) };
        if (kind === "decimal") {
            return { kind: "integer", value: raw === "" ? null : Number(raw) };
        }
        if (kind === "list") {
            return {
                kind: "text_list",
                value: String(raw || "").split(/\r?\n/).filter(function(item) { return item !== ""; })
            };
        }
        return {
            kind: "text",
            value: String(raw === undefined || raw === null ? "" : raw)
        };
    }

    function preferenceValueFromInput(original, raw, checked) {
        var value = clone(original || { kind: "text", value: "" });
        switch (value.kind) {
            case "boolean":
                value.value = Boolean(checked);
                break;
            case "optional_boolean":
                value.value = raw === "" ? null : raw === "true";
                break;
            case "integer":
            case "unsigned_byte":
                value.value = raw === "" ? null : Number(raw);
                break;
            case "optional_unsigned_byte":
                value.value = raw === "" ? null : Number(raw);
                break;
            case "text_list":
                value.value = String(raw || "").split(/\r?\n/).filter(function(item) { return item !== ""; });
                break;
            case "optional_text":
                value.value = raw === "" ? null : String(raw);
                break;
            default:
                value.value = String(raw === undefined || raw === null ? "" : raw);
        }
        return value;
    }

    function buildPolicyUpdate(policy, draft, baselineDraft) {
        var request = {};
        var originalState = baselineDraft ? baselineDraft.state : policy.state;
        if (draft.state !== originalState) request.state = draft.state;

        var baseline = new Map(baselineDraft
            ? (baselineDraft.parameters || []).map(function(parameter) {
                return [parameter.parameter_id, parameter.value];
            })
            : (policy.parameters || []).map(function(parameter) {
                return [parameter.id, parameter.value];
            }));
        var sets = [];
        var clears = [];
        if (draft.state === 'enabled') {
            (draft.parameters || []).forEach(function(parameter) {
                var oldValue = baseline.get(parameter.parameter_id);
                if (equal(oldValue, parameter.value)) return;
                if (parameter.value === null) clears.push(parameter.parameter_id);
                else sets.push({ parameter_id: parameter.parameter_id, value: clone(parameter.value) });
            });

            var enableAction = policyStateAction(policy, 'enabled');
            if (draft.state !== originalState && enableAction.requires_parameters) {
                var alreadyEdited = new Set(sets.map(function(item) { return item.parameter_id; }));
                clears.forEach(function(parameterId) { alreadyEdited.add(parameterId); });
                var draftById = new Map((draft.parameters || []).map(function(parameter) {
                    return [parameter.parameter_id, parameter.value];
                }));
                (policy.parameters || []).forEach(function(parameter) {
                    if (parameter.value !== null && parameter.value !== undefined) return;
                    if (parameter.default_value === null || parameter.default_value === undefined) return;
                    if (parameter.default_value.kind === 'unsupported') return;
                    if (alreadyEdited.has(parameter.id)) return;
                    var value = draftById.get(parameter.id);
                    if (value === null || value === undefined) return;
                    if (value.kind === 'unsupported') return;
                    sets.push({ parameter_id: parameter.id, value: clone(value) });
                    alreadyEdited.add(parameter.id);
                });
            }
        }
        if (sets.length) request.set_parameters = sets;
        if (clears.length) request.clear_parameters = clears;

        var oldComment = baselineDraft
            ? baselineDraft.comment
            : (policy.comment ? policy.comment.text : "");
        if (draft.comment !== oldComment) {
            var source = policy.comment && policy.comment.source;
            var target = source === "locale"
                ? { kind: "locale", locale: policy.comment.locale }
                : "embedded";
            request.comment = draft.comment === ""
                ? { action: "clear", target: target }
                : { action: "set", target: target, text: draft.comment };
        }
        return request;
    }

    function hasOperations(request) {
        return request && Object.keys(request).length > 0;
    }

    function policyChoiceValue(choices, selectedIndex) {
        var index = Number(selectedIndex);
        return selectedIndex === '' || !Array.isArray(choices) || !choices[index]
            ? null
            : clone(choices[index].value);
    }

    function legacyStateCapability(policy, state) {
        var capability = state === 'not_configured'
            ? 'clear'
            : (state === 'enabled' ? 'enable' : 'disable');
        return Boolean(policy && policy.capabilities && policy.capabilities[capability]);
    }

    function policyStateAction(policy, state) {
        var hasStateActions = Boolean(policy
            && Object.prototype.hasOwnProperty.call(policy, 'state_actions'));
        var action = hasStateActions && policy.state_actions
            ? policy.state_actions[state]
            : null;
        if (action && typeof action === 'object') {
            return {
                available: Boolean(action.available),
                mode: action.mode || null,
                requires_parameters: Boolean(action.requires_parameters)
            };
        }
        if (hasStateActions) {
            return { available: false, mode: null, requires_parameters: false };
        }
        return {
            available: legacyStateCapability(policy, state),
            mode: null,
            requires_parameters: false
        };
    }

    function canSelectPolicyState(policy, state) {
        return Boolean(policy
            && policy.state !== 'unknown_raw_values'
            && policyStateAction(policy, state).available);
    }

    function canEditPolicyParameters(policy, draftState) {
        var selectedState = draftState === undefined ? policy && policy.state : draftState;
        var hasStateActions = Boolean(policy
            && Object.prototype.hasOwnProperty.call(policy, 'state_actions'));
        return Boolean(policy
            && policy.state !== 'unknown_raw_values'
            && selectedState === 'enabled'
            && (!hasStateActions || policyStateAction(policy, 'enabled').available)
            && policy.capabilities
            && policy.capabilities.edit_parameters);
    }

    function insertFilterOperation(collectionPath, index, filterKind, fields) {
        return {
            op: 'insert',
            collection_path: clone(collectionPath || []),
            index: Number(index),
            filter_kind: filterKind,
            fields: clone(fields || [])
        };
    }

    function editFilterOperation(path, fields) {
        return { op: 'edit', path: clone(path), fields: clone(fields || []) };
    }

    function replaceFilterOperation(path, filterKind, fields) {
        return {
            op: 'replace', path: clone(path), filter_kind: filterKind, fields: clone(fields || [])
        };
    }

    function removeFilterOperation(path) {
        return { op: 'remove', path: clone(path) };
    }

    function optionalTextValue(present, text) {
        return { kind: 'optional_text', value: present ? String(text) : null };
    }

    function preferenceFieldIds(fields) {
        var seen = new Set();
        var duplicates = new Set();
        (fields || []).forEach(function(field) {
            if (!field || typeof field.id !== 'string') return;
            if (seen.has(field.id)) duplicates.add(field.id);
            seen.add(field.id);
        });
        return { seen: seen, duplicates: Array.from(duplicates) };
    }

    function preferenceValueIsEmpty(value) {
        if (!value || typeof value !== 'object') return true;
        if (value.value === null || value.value === undefined) return true;
        if (typeof value.value === 'string') return value.value.trim() === '';
        if (Array.isArray(value.value)) return value.value.length === 0;
        return false;
    }

    function validatePreferenceField(field, value) {
        if (!field || !value || typeof value !== 'object' || typeof value.kind !== 'string') {
            return 'invalid_value';
        }
        if (field.control === 'choice') {
            if (!Array.isArray(field.choices)
                    || !field.choices.every(function(choice) {
                        return choice && typeof choice.key === 'string' && choice.key !== ''
                            && typeof choice.label === 'string';
                    })
                    || value.kind !== 'text'
                    || !field.choices.some(function(choice) { return choice.key === value.value; })) {
                return 'invalid_value';
            }
        }
        if (field.required && preferenceValueIsEmpty(value)) return 'required';
        if (value.kind === 'integer' || value.kind === 'unsigned_byte'
                || value.kind === 'optional_unsigned_byte') {
            if (value.value === null && value.kind === 'optional_unsigned_byte') return null;
            if (!Number.isFinite(value.value) || !Number.isInteger(value.value)) {
                return 'invalid_number';
            }
            if ((value.kind === 'unsigned_byte' || value.kind === 'optional_unsigned_byte')
                    && (value.value < 0 || value.value > 255)) {
                return 'unsigned_byte_range';
            }
        }
        if (value.kind === 'action'
                && ['create', 'replace', 'update', 'delete'].indexOf(value.value) === -1) {
            return 'invalid_value';
        }
        if (value.kind === 'filter_combine'
                && ['and', 'or'].indexOf(value.value) === -1) {
            return 'invalid_value';
        }
        return null;
    }

    function preferenceFieldEdits(descriptors, draftFields, changedOnly) {
        var draft = new Map((draftFields || []).map(function(field) {
            return [field.id, field.value];
        }));
        var result = [];
        (descriptors || []).forEach(function(field) {
            if (!field || !field.editable) return;
            var value = draft.has(field.id) ? draft.get(field.id) : field.value;
            if (!changedOnly || !equal(value, field.value)) {
                result.push({ id: field.id, value: clone(value) });
            }
        });
        return result;
    }

    function preferenceParentIdentity(candidates, selectedIndex) {
        var index = Number(selectedIndex);
        if (!Number.isInteger(index) || index < 0) return null;
        var candidate = (candidates || [])[index];
        if (!candidate || candidate.identity === null) return null;
        return Array.isArray(candidate.identity) && candidate.identity.length
            ? clone(candidate.identity) : null;
    }

    function buildPreferenceRequest(options) {
        var config = options || {};
        var descriptors = config.descriptors || [];
        var ids = preferenceFieldIds(descriptors);
        var draftFields = config.fields || [];
        var draft = new Map(draftFields.map(function(field) {
            return [field.id, field.value];
        }));
        var errors = ids.duplicates.map(function(id) {
            return { id: id, code: 'duplicate_descriptor' };
        });

        descriptors.forEach(function(field) {
            if (!field || !field.editable || ids.duplicates.indexOf(field.id) !== -1) return;
            var value = draft.has(field.id) ? draft.get(field.id) : field.value;
            var code = validatePreferenceField(field, value);
            if (code) errors.push({ id: field.id, code: code });
        });

        var creating = Boolean(config.creating);
        var nextName = config.name === undefined || config.name === null
            ? null
            : String(config.name);
        var originalName = config.originalName === undefined || config.originalName === null
            ? null
            : String(config.originalName);
        if (!creating && nextName !== null && nextName !== originalName && nextName.trim() === '') {
            errors.push({ id: 'name', code: 'required' });
        }
        if (errors.length) return { request: null, errors: errors, changed: false };

        var request = creating ? {} : { identity: clone(config.identity) };
        var edits = preferenceFieldEdits(descriptors, draftFields, !creating);
        if (creating || edits.length) request.fields = edits;
        if (creating && Array.isArray(config.parent) && config.parent.length) {
            request.parent = clone(config.parent);
        }
        if (!creating && nextName !== null && nextName !== originalName) request.name = nextName;
        var filters = clone(config.filters || []);
        if (filters.length) request.filters = filters;

        var changed = creating || Object.keys(request).some(function(key) {
            return key !== 'identity';
        });
        return { request: changed ? request : null, errors: [], changed: changed };
    }

    function pathWithin(path, ancestor) {
        var candidate = Array.isArray(path) ? path : [];
        var parent = Array.isArray(ancestor) ? ancestor : [];
        if (candidate.length < parent.length) return false;
        return parent.every(function(value, index) { return candidate[index] === value; });
    }

    function buildPreferenceFilterOperations(fieldEdits, structuralOperation) {
        var structural = structuralOperation ? clone(structuralOperation) : null;
        var result = [];
        (fieldEdits || []).forEach(function(edit) {
            if (!edit || !Array.isArray(edit.path) || !Array.isArray(edit.fields)
                    || edit.fields.length === 0) return;
            if (structural && structural.op === 'remove'
                    && pathWithin(edit.path, structural.path)) return;
            if (structural && structural.op === 'replace'
                    && pathWithin(edit.path, structural.path)) return;
            result.push(editFilterOperation(edit.path, edit.fields));
        });
        if (structural) result.push(structural);
        return result;
    }

    function submitPreservingDraft(draft, submit) {
        var preservedDraft = clone(draft);
        return Promise.resolve().then(submit).then(function(response) {
            return { ok: true, response: response, draft: preservedDraft };
        }).catch(function(error) {
            return { ok: false, error: error, draft: preservedDraft };
        });
    }

    function errorCategory(error) {
        return String((error && (error.category || error.code)) || "operational").toLowerCase();
    }

    return {
        clone: clone,
        equal: equal,
        valuePayload: valuePayload,
        typedValueFromInput: typedValueFromInput,
        preferenceValueFromInput: preferenceValueFromInput,
        buildPolicyUpdate: buildPolicyUpdate,
        hasOperations: hasOperations,
        policyChoiceValue: policyChoiceValue,
        policyStateAction: policyStateAction,
        canSelectPolicyState: canSelectPolicyState,
        canEditPolicyParameters: canEditPolicyParameters,
        insertFilterOperation: insertFilterOperation,
        editFilterOperation: editFilterOperation,
        replaceFilterOperation: replaceFilterOperation,
        removeFilterOperation: removeFilterOperation,
        optionalTextValue: optionalTextValue,
        preferenceFieldIds: preferenceFieldIds,
        validatePreferenceField: validatePreferenceField,
        preferenceFieldEdits: preferenceFieldEdits,
        preferenceParentIdentity: preferenceParentIdentity,
        buildPreferenceRequest: buildPreferenceRequest,
        pathWithin: pathWithin,
        buildPreferenceFilterOperations: buildPreferenceFilterOperations,
        submitPreservingDraft: submitPreservingDraft,
        errorCategory: errorCategory
    };
});
