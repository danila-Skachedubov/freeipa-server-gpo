define(['../../../locales/translations', '../security/model', '../advanced-audit/model', '../../editor-icons'], function(translations, securityModel, auditModel, editorIcons) {
    'use strict';

    function text(key, fallback) {
        var value = translations && translations.t(key);
        return value && value !== key ? value : fallback;
    }

    function language() {
        return translations && typeof translations.getLanguage === 'function'
            ? translations.getLanguage() : undefined;
    }

    function pathLabels(path) {
        return Array.isArray(path) ? path.map(function(label) { return String(label); }) : [];
    }

    function identity(kind, scope, parts) {
        return kind + ':' + JSON.stringify([scope].concat(parts));
    }

    function row(kind, scope, parts, title, path, properties) {
        var categoryPath = [text(scope === 'computer' ? 'policies.machine' : 'policies.user', scope)];
        if (kind !== 'preferences') categoryPath.push(text('policies.title', 'Policies'));
        if (kind === 'security' || kind === 'advanced_audit') categoryPath.push(text('policies.windowsSettings', 'System Settings'));
        categoryPath = categoryPath.concat(pathLabels(path));
        if (kind === 'preferences') categoryPath.push(String(title));
        return {
            id: identity(kind, scope, parts),
            title: String(title),
            path: pathLabels(path),
            target: Object.assign({
                title: String(title), type: 'file', icon: 'ico-file',
                showInTree: false, template: kind, scope: scope, categoryPath: categoryPath
            }, properties || {})
        };
    }

    function admxRows(result, scope) {
        if (!result || !Array.isArray(result.policies)) {
            throw new TypeError(text('policySearch.invalidIndex', 'Invalid policy index'));
        }
        var policies = result.policies;
        return policies.map(function(policy) {
            return row('admx', scope, [policy.id], policy.label || policy.id,
                [text('policies.adminTemplates', 'Administrative Templates')].concat(pathLabels(policy.path)),
                { policyId: policy.id });
        });
    }

    function reference(value) {
        return Array.isArray(value) ? { namespace: value[0], id: value[1] } : value;
    }

    function securityRows(response, scope) {
        if (scope !== 'computer') return [];
        if (!response || !response.security_catalog
                || !Array.isArray(response.security_catalog.categories)
                || !Array.isArray(response.security_catalog.policies)) {
            throw new TypeError(text('policySearch.invalidIndex', 'Invalid policy index'));
        }
        var model = securityModel.buildSecurityModel(response);
        var categories = new Map();
        var catalog = response && response.security_catalog || {};
        (catalog.categories || []).forEach(function(category) {
            categories.set(securityModel.identity(category.namespace, category.id), category);
        });
        function categoryPath(policy) {
            var path = [];
            var current = reference(policy.definition.category);
            var visited = new Set();
            while (current) {
                var key = securityModel.identity(current.namespace, current.id);
                if (visited.has(key)) break;
                visited.add(key);
                var category = categories.get(key);
                if (!category) break;
                path.unshift(category.display_name || category.id);
                current = reference(category.parent);
            }
            return [text('security.title', 'Security Settings')].concat(path);
        }
        return Array.from(model.policies.values()).map(function(policy) {
            var collection = securityModel.collectionElement(policy);
            var properties = {
                securityPolicy: { namespace: policy.namespace, policy_id: policy.policyId },
                openPolicyDialog: !collection
            };
            if (collection) properties.securityCollection = collection.id;
            return row('security', scope, [policy.namespace, policy.policyId],
                policy.definition.display_name || policy.policyId, categoryPath(policy), properties);
        });
    }

    function auditIdentity(value) {
        var item = value || {};
        if (item.kind === 'subcategory') {
            var target = item.target || { kind: 'system' };
            return JSON.stringify([item.kind, String(item.guid || '').replace(/[{}]/g, '').toLowerCase(),
                target.kind, target.sid || '']);
        }
        if (item.kind === 'option') return JSON.stringify([item.kind, item.option]);
        if (item.kind === 'global_sacl') return JSON.stringify([item.kind, item.object_kind]);
        return JSON.stringify([item.kind, item.fields || [], item.raw || '', item.reason || '']);
    }

    function auditTitle(item) {
        if (item.kind === 'subcategory') return item.display_name || item.guid;
        if (item.kind === 'option') return item.display_name || item.machine_name || item.option;
        if (item.kind === 'global_sacl') return item.object_kind === 'registry'
            ? text('security.advancedAudit.registrySacl', 'Registry global SACL')
            : text('security.advancedAudit.fileSacl', 'File global SACL');
        return text('security.advancedAudit.preserved', 'Preserved source row');
    }

    function auditRows(response, scope) {
        if (scope !== 'computer') return [];
        if (!response || !response.advanced_audit
                || !Array.isArray(response.advanced_audit.rows)
                || !Array.isArray(response.advanced_audit.subcategory_catalog)) {
            throw new TypeError(text('policySearch.invalidIndex', 'Invalid policy index'));
        }
        var rows = [];
        var duplicates = new Map();
        auditModel.families(response).forEach(function(family) {
            family.rows.forEach(function(item) {
                var key = auditIdentity(item);
                var parts = [family.id, key];
                var occurrenceKey = JSON.stringify(parts);
                var occurrence = duplicates.get(occurrenceKey) || 0;
                duplicates.set(occurrenceKey, occurrence + 1);
                if (occurrence) parts.push(occurrence);
                var path = [text('security.title', 'Security Settings'),
                    text('security.advancedAudit.title', 'Advanced Audit Policy Configuration'), family.label];
                if (item.kind === 'subcategory' && item.target && item.target.kind === 'user') {
                    path.push(item.target.sid || item.target.kind);
                }
                rows.push(row('advanced_audit', scope, parts, auditTitle(item), path, {
                    advancedAuditFamilyId: family.id,
                    advancedAuditTarget: key,
                    advancedAuditOccurrence: occurrence,
                    openPolicyDialog: true,
                    readOnly: item.kind === 'preserved' || item.editable === false
                }));
            });
        });
        return rows;
    }

    function scriptRows(scope) {
        var events = scope === 'computer' ? ['startup', 'shutdown'] : scope === 'user' ? ['logon', 'logoff'] : [];
        var labels = { startup: 'startupScripts', shutdown: 'shutdownScripts', logon: 'logonScript', logoff: 'logoffScript' };
        return events.map(function(event) {
            return row('scripts', scope, [event], text('systemSettings.' + labels[event], event), [
                text('policies.windowsSettings', 'System Settings'),
                text(scope === 'computer' ? 'policies.scriptsComputer' : 'policies.scriptsUser', 'Scripts')
            ], { scriptEvent: event, icon: editorIcons.scriptEvent(event), openPolicyDialog: true });
        });
    }

    function preferenceCategory(document) {
        var id = document.category_id || 'other_settings';
        if (id === 'system_settings') return text('preferences.windowsSettings', 'System Settings');
        if (id === 'control_panel_settings') return text('preferences.controlPanelSettings', 'Component Settings');
        if (id === 'other_settings') return text('preferences.otherSettings', 'Other settings');
        return document.category_label || id;
    }

    function preferenceRows(documents, scope) {
        return (Array.isArray(documents) ? documents : []).filter(function(document) {
            return document.scope === scope;
        }).map(function(document) {
            return row('preferences', scope, [document.kind], document.label || document.kind,
                [text('preferences.title', 'Preferences'), preferenceCategory(document)], {
                    preferenceKind: document.kind,
                    icon: editorIcons.preference(document.kind),
                    document: JSON.parse(JSON.stringify(document)),
                    readOnly: !document.editable || document.applicable === false
                });
        });
    }

    function normalized(value) {
        return String(value === undefined || value === null ? '' : value).normalize('NFC')
            .toLocaleLowerCase(language()).replace(/\s+/g, ' ').trim();
    }

    function matches(item, query) {
        var needle = normalized(query);
        if (!needle) return true;
        return normalized([item && item.title || ''].concat(pathLabels(item && item.path)).join(' '))
            .indexOf(needle) !== -1;
    }

    function sortRows(rows) {
        var locale = language();
        return (Array.isArray(rows) ? rows : []).slice().sort(function(left, right) {
            return String(left.title).localeCompare(String(right.title), locale)
                || pathLabels(left.path).join(' / ').localeCompare(pathLabels(right.path).join(' / '), locale)
                || String(left.id).localeCompare(String(right.id), locale);
        });
    }

    return {
        admxRows: admxRows,
        securityRows: securityRows,
        auditRows: auditRows,
        auditIdentity: auditIdentity,
        scriptRows: scriptRows,
        preferenceRows: preferenceRows,
        matches: matches,
        sortRows: sortRows
    };
});
