define([], function() {
    'use strict';

    // These are the cross-policy constraints in the bundled SDMX 1.0 catalog.
    // Keep the namespace in the match: other vendors may use the same policy ID.
    var BASE = 'urn:altlinux:sdmx:policies:';
    var AGE_BASED = 'overwrite_events_older_than_the_retention_period';
    var AS_NEEDED = 'overwrite_events_as_needed';
    var SHAPES = {
        'account.password.maximum_password_age': ['integer', [[0, 999]], []],
        'account.password.minimum_password_age': ['integer', [[0, 998]], []],
        'account.kerberos.max_ticket_age': ['integer', [[0, 99999]], []],
        'account.kerberos.max_service_age': ['integer', [[0, 0], [10, 99999]], []],
        'account.kerberos.max_renew_age': ['integer', [[0, 99999]], []],
        'account.lockout.lockout_bad_count': ['integer', [[0, 999]], []],
        'account.lockout.reset_lockout_count': ['integer', [[1, 99999]], []],
        'account.lockout.lockout_duration': ['integer', [[0, 99999]], []],
        'account.lockout.allow_administrator_lockout': ['boolean', [], []],
        'event_log.security_log_audit_log_retention_period': ['enum', [], []],
        'event_log.security_log_retention_days': ['integer', [[1, 365]], []],
        'event_log.application_log_audit_log_retention_period': ['enum', [], []],
        'event_log.application_log_retention_days': ['integer', [[1, 365]], []],
        'event_log.system_log_audit_log_retention_period': ['enum', [], []],
        'event_log.system_log_retention_days': ['integer', [[1, 365]], []]
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function sameRanges(actual, expected) {
        if (!Array.isArray(actual) || actual.length !== expected.length) return false;
        if (actual.some(function(range) { return !range || typeof range !== 'object'; })) return false;
        var sorted = actual.map(function(range) { return [range.min, range.max]; })
            .sort(function(left, right) { return left[0] - right[0] || left[1] - right[1]; });
        var wanted = expected.slice().sort(function(left, right) {
            return left[0] - right[0] || left[1] - right[1];
        });
        return sorted.every(function(range, index) {
            return Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1]) &&
                range[0] === wanted[index][0] && range[1] === wanted[index][1];
        });
    }

    function compatible(element, shape) {
        if (!element || element.id !== 'value' || element.value_type !== shape[0] ||
                element.required !== true || !element.initial ||
                element.initial.kind !== shape[0] ||
                !sameRanges(element.ranges, shape[1]) ||
                !Array.isArray(element.options)) return false;
        if (!sameRanges(element.input_ranges, shape[2])) return false;
        var initial = element.initial.value;
        if (shape[0] === 'integer') {
            var domain = element.input_ranges.length
                ? element.input_ranges.map(function(range) { return [range.min, range.max]; })
                : shape[1];
            return Number.isSafeInteger(initial) && domain.some(function(range) {
                return initial >= range[0] && initial <= range[1];
            }) && !element.options.length;
        }
        if (shape[0] === 'boolean') {
            return typeof initial === 'boolean' && !element.options.length;
        }
        var options = element.options;
        if (!Array.isArray(options) || options.some(function(option) {
            return !option || typeof option.id !== 'string';
        })) return false;
        var choices = options.map(function(option) { return option.id; });
        return typeof initial === 'string' && choices.indexOf(initial) !== -1 &&
            choices.indexOf(AGE_BASED) !== -1 && choices.indexOf(AS_NEEDED) !== -1;
    }

    function group(model, namespace, prefix, names) {
        if (!model || !model.policies || typeof model.policies.get !== 'function') return null;
        var policies = {};
        for (var i = 0; i < names.length; i += 1) {
            var id = prefix + '.' + names[i];
            var policy = model.policies.get(namespace + '\u0000' + id);
            var elements = policy && policy.definition && policy.definition.elements;
            if (!policy || policy.namespace !== namespace || policy.policyId !== id ||
                    !Array.isArray(elements) || elements.length !== 1 ||
                    !SHAPES[id] || !compatible(elements[0], SHAPES[id])) return null;
            policies[names[i]] = policy;
        }
        return policies;
    }

    function draftFor(policy) {
        var defined = policy.state && policy.state.state === 'defined';
        var current = defined && policy.state.elements || {};
        var elements = {};
        (policy.definition.elements || []).forEach(function(element) {
            elements[element.id] = defined
                ? clone(current[element.id] || { state: 'unset' })
                : element.initial
                    ? { state: 'set', value: clone(element.initial) }
                    : { state: 'unset' };
        });
        return { defined: defined, elements: elements };
    }

    function valueOf(draft) {
        var state = draft && draft.defined && draft.elements && draft.elements.value;
        return state && state.state === 'set' && state.value
            ? state.value.value : null;
    }

    function initialOf(policy) {
        var element = (policy.definition.elements || []).find(function(item) {
            return item.id === 'value';
        });
        return element && element.initial ? element.initial.value : null;
    }

    function set(draft, policy, value) {
        var element = policy.definition.elements.find(function(item) {
            return item.id === 'value';
        });
        draft.defined = true;
        draft.elements.value = {
            state: 'set', value: { kind: element.value_type, value: value }
        };
    }

    function unset(draft) {
        draft.defined = false;
    }

    function number(draft, policy) {
        var value = valueOf(draft);
        return Number.isSafeInteger(value) ? value : initialOf(policy);
    }

    function finish(policies, names, primaryName, desired) {
        var changes = names.filter(function(name) {
            if (name === primaryName) return false;
            var previous = draftFor(policies[name]);
            var next = desired[name];
            return previous.defined !== next.defined || next.defined &&
                JSON.stringify(previous.elements) !== JSON.stringify(next.elements);
        }).map(function(name) {
            return { policy: policies[name], draft: desired[name] };
        });
        return changes.length ? { changes: changes } : null;
    }

    function begin(policies, names, primaryName, primaryDraft) {
        var desired = {};
        names.forEach(function(name) { desired[name] = draftFor(policies[name]); });
        desired[primaryName] = clone(primaryDraft);
        return desired;
    }

    function password(model, policy, draft) {
        var names = ['maximum_password_age', 'minimum_password_age'];
        var policies = group(model, BASE + 'account-password', 'account.password', names);
        if (!policies) return null;
        var primary = names.find(function(name) { return policies[name] === policy; });
        if (!primary) return null;
        var other = names.find(function(name) { return name !== primary; });
        var desired = begin(policies, names, primary, draft);
        if (!draft.defined) {
            unset(desired[other]);
            return finish(policies, names, primary, desired);
        }
        var chosen = valueOf(draft);
        if (!Number.isSafeInteger(chosen)) return null;
        var counterpart = number(desired[other], policies[other]);
        if (primary === 'maximum_password_age') {
            if (chosen < 0 || chosen > 999) return null;
            counterpart = Math.max(0, Math.min(998, counterpart));
            if (chosen !== 0) counterpart = Math.min(counterpart, chosen - 1);
        } else {
            if (chosen < 0 || chosen > 998) return null;
            counterpart = Math.max(0, Math.min(999, counterpart));
            if (counterpart !== 0) counterpart = Math.max(counterpart, chosen + 1);
        }
        set(desired[other], policies[other], counterpart);
        return finish(policies, names, primary, desired);
    }

    function kerberos(model, policy, draft) {
        var names = ['max_ticket_age', 'max_service_age', 'max_renew_age'];
        var policies = group(model, BASE + 'account-kerberos', 'account.kerberos', names);
        if (!policies) return null;
        var primary = names.find(function(name) { return policies[name] === policy; });
        if (!primary) return null;
        var desired = begin(policies, names, primary, draft);
        if (!draft.defined) {
            names.forEach(function(name) { if (name !== primary) unset(desired[name]); });
            return finish(policies, names, primary, desired);
        }
        var chosen = valueOf(draft);
        if (!Number.isSafeInteger(chosen)) return null;
        var ticket = number(desired.max_ticket_age, policies.max_ticket_age);
        var service = number(desired.max_service_age, policies.max_service_age);
        var renew = number(desired.max_renew_age, policies.max_renew_age);
        // Unlimited user tickets require unlimited service and renewal values.
        if (primary === 'max_ticket_age' && ticket === 0) {
            service = 0;
            renew = 0;
        } else {
            if (ticket === 0 && (service > 0 || renew > 0)) {
                if (primary === 'max_service_age' && service === 0) renew = 0;
                else ticket = Math.max(initialOf(policies.max_ticket_age),
                    Math.ceil(service / 60));
            }
            if (service > ticket * 60) {
                if (primary === 'max_ticket_age') service = ticket * 60;
                else ticket = Math.ceil(service / 60);
            }
        }
        if (ticket < 0 || service < 0 || service > 99999 || ticket > 99999 ||
                (service > 0 && service < 10) ||
                (ticket === 0 && (service !== 0 || renew !== 0)) ||
                renew < 0 || renew > 99999) return null;
        names.forEach(function(name) {
            var next = name === 'max_ticket_age' ? ticket
                : name === 'max_service_age' ? service : renew;
            if (name !== primary) set(desired[name], policies[name], next);
        });
        return finish(policies, names, primary, desired);
    }

    function lockout(model, policy, draft) {
        var names = ['lockout_bad_count', 'reset_lockout_count', 'lockout_duration',
            'allow_administrator_lockout'];
        var policies = group(model, BASE + 'account-lockout', 'account.lockout', names);
        if (!policies) return null;
        var primary = names.find(function(name) { return policies[name] === policy; });
        if (!primary) return null;
        var desired = begin(policies, names, primary, draft);
        var threshold = number(desired.lockout_bad_count, policies.lockout_bad_count);
        if (primary === 'lockout_bad_count' && draft.defined &&
                !Number.isSafeInteger(valueOf(draft))) return null;
        if (primary === 'lockout_bad_count' && (!draft.defined || threshold === 0) ||
                primary !== 'lockout_bad_count' && !draft.defined) {
            // Removing any member of an active lockout group requires disabling
            // lockout explicitly. The UI must disclose this before submitting.
            if (primary !== 'lockout_bad_count' && desired.lockout_bad_count.defined &&
                    threshold > 0) set(desired.lockout_bad_count, policies.lockout_bad_count, 0);
            names.forEach(function(name) {
                if (name !== primary && name !== 'lockout_bad_count') unset(desired[name]);
            });
            return finish(policies, names, primary, desired);
        }
        if (primary !== 'lockout_bad_count' && !Number.isSafeInteger(valueOf(draft)) &&
                primary !== 'allow_administrator_lockout') return null;
        if (!desired.lockout_bad_count.defined || threshold === 0) {
            threshold = initialOf(policies.lockout_bad_count);
        }
        var reset = number(desired.reset_lockout_count, policies.reset_lockout_count);
        var duration = number(desired.lockout_duration, policies.lockout_duration);
        var administrator = valueOf(desired.allow_administrator_lockout);
        if (typeof administrator !== 'boolean') {
            administrator = initialOf(policies.allow_administrator_lockout);
        }
        if (duration > 0 && duration < reset) {
            if (primary === 'lockout_duration') reset = duration;
            else duration = reset;
        }
        if (threshold < 1 || threshold > 999 || reset < 1 || reset > 99999 ||
                duration < 0 || duration > 99999) return null;
        var planned = { lockout_bad_count: threshold, reset_lockout_count: reset,
            lockout_duration: duration, allow_administrator_lockout: administrator };
        names.forEach(function(name) {
            if (name !== primary) set(desired[name], policies[name], planned[name]);
        });
        return finish(policies, names, primary, desired);
    }

    function eventLog(model, policy, draft) {
        var namespace = BASE + 'event-log';
        for (var i = 0; i < 3; i += 1) {
            var stream = ['security', 'application', 'system'][i];
            var names = [stream + '_log_audit_log_retention_period', stream + '_log_retention_days'];
            var policies = group(model, namespace, 'event_log', names);
            if (!policies) continue;
            var primary = names.find(function(name) { return policies[name] === policy; });
            if (!primary) continue;
            var other = names.find(function(name) { return name !== primary; });
            var desired = begin(policies, names, primary, draft);
            if (primary === names[0]) {
                if (draft.defined && valueOf(draft) === AGE_BASED) {
                    set(desired[other], policies[other], number(desired[other], policies[other]));
                } else {
                    unset(desired[other]);
                }
            } else if (draft.defined) {
                set(desired[other], policies[other], AGE_BASED);
            } else if (desired[other].defined && valueOf(desired[other]) === AGE_BASED) {
                set(desired[other], policies[other], AS_NEEDED);
            }
            return finish(policies, names, primary, desired);
        }
        return null;
    }

    function plan(model, policy, draft) {
        if (!policy || !draft) return null;
        return password(model, policy, draft) || kerberos(model, policy, draft) ||
            lockout(model, policy, draft) || eventLog(model, policy, draft);
    }

    return { plan: plan };
});
