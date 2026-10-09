define(['../../locales/translations', '../../util/API', '../templates/security/model', '../templates/advanced-audit/model', '../editor-icons'], function(translations, API, securityModel, auditModel, editorIcons) {
    "use strict";

    var t = translations.t;

    function payloadList(result, key) {
        if (Array.isArray(result)) return result;
        return result && Array.isArray(result[key]) ? result[key] : [];
    }

    function policyChildren(scope, result) {
        var language = typeof translations.getLanguage === 'function' ? translations.getLanguage() : undefined;
        return payloadList(result, 'children').map(function(node) {
            return policyNode(scope, node);
        }).sort(function(left, right) {
            if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
            return left.title.localeCompare(right.title, language);
        });
    }

    function policyNode(scope, node) {
        if (node.kind === 'category') {
            return {
                title: node.label || node.id,
                type: 'folder',
                opened: false,
                icon: 'ico-folder',
                scope: scope,
                categoryId: node.id,
                lazy: true,
                help: node.explain_text || undefined,
                children: [],
                loadChildren: function() {
                    return API.children(scope, node.id).then(function(result) {
                        return policyChildren(scope, result);
                    });
                }
            };
        }

        return {
            title: node.label || node.id,
            type: 'file',
            showInTree: false,
            icon: 'ico-file',
            template: 'admx',
            scope: scope,
            policyId: node.id
        };
    }

    function administrativeTemplates(scope) {
        return {
            title: t('policies.adminTemplates'),
            type: 'folder',
            opened: false,
            icon: 'ico-folder',
            scope: scope,
            lazy: true,
            help: t(scope === 'computer' ? 'policies.machineAdminTemplates' : 'policies.userAdminTemplates'),
            children: [],
            loadChildren: function() {
                return API.children(scope, null).then(function(result) {
                    return policyChildren(scope, result);
                });
            }
        };
    }

    function preferenceNode(document) {
        return {
            title: document.label || document.kind,
            type: 'file',
            icon: editorIcons.preference(document.kind),
            template: 'preferences',
            scope: document.scope,
            preferenceKind: document.kind,
            document: document,
            readOnly: !document.editable || document.applicable === false
        };
    }

    function scriptsNode(scope) {
        var isComputer = scope === 'computer';
        return {
            title: t(isComputer ? 'policies.scriptsComputer' : 'policies.scriptsUser'),
            type: 'file',
            icon: editorIcons.scripts(),
            template: 'scripts',
            scope: scope
        };
    }

    function windowsPolicySettingsNode(scope) {
        var children = [scriptsNode(scope)];
        if (scope === 'computer') children.push(securityNode());
        return {
            title: t('policies.windowsSettings'),
            type: 'folder',
            opened: false,
            icon: 'ico-folder',
            scope: scope,
            children: children
        };
    }

    function securityNode() {
        return {
            title: t('security.title'), type: 'folder', opened: false, icon: 'ico-folder',
            lazy: true, children: [], loadChildren: function() {
                return Promise.all([API.securityDefinitionsShow(), API.advancedAuditShow().then(function(value) { return { value: value }; }, function(error) { return { error: error }; })]).then(function(responses) {
                    var nodes = securityModel.navigationNodes(responses[0]);
                    if (responses[1].value) nodes.push(auditModel.navigationNode(responses[1].value));
                    else nodes.push({ title: t('security.auditUnavailable'), type: 'file', icon: 'ico-file', showInTree: false, template: 'advanced_audit', advancedAuditError: responses[1].error });
                    return nodes.sort(function(left, right) { return left.title.localeCompare(right.title); });
                });
            }
        };
    }

    function preferenceCategoryTitle(category) {
        if (category.id === 'system_settings') return t('preferences.windowsSettings');
        if (category.id === 'control_panel_settings') return t('preferences.controlPanelSettings');
        if (category.id === 'other_settings') return t('preferences.otherSettings');
        return category.label || category.id;
    }

    function preferenceOrder(value) {
        return value === undefined || value === null || value === '' || !Number.isFinite(Number(value))
            ? 999 : Number(value);
    }

    function preferenceCategories(scope, documents) {
        var categories = new Map();
        documents.filter(function(document) { return document.scope === scope; }).forEach(function(document) {
            var id = document.category_id || 'other_settings';
            var category = categories.get(id);
            if (!category) {
                category = {
                    id: id,
                    label: document.category_label,
                    order: preferenceOrder(document.category_order),
                    documents: []
                };
                categories.set(id, category);
            }
            category.documents.push(document);
        });
        return Array.from(categories.values()).sort(function(left, right) {
            return left.order - right.order || preferenceCategoryTitle(left).localeCompare(preferenceCategoryTitle(right));
        }).map(function(category) {
            category.documents.sort(function(left, right) {
                var leftOrder = preferenceOrder(left.display_order);
                var rightOrder = preferenceOrder(right.display_order);
                return leftOrder - rightOrder || (left.label || left.kind).localeCompare(right.label || right.kind);
            });
            return {
                title: preferenceCategoryTitle(category),
                type: 'folder',
                opened: false,
                icon: editorIcons.preferenceCategory(category.id),
                scope: scope,
                preferenceCategoryId: category.id,
                children: category.documents.map(preferenceNode)
            };
        });
    }

    function scopeNode(scope, documents) {
        var isComputer = scope === 'computer';
        var preferenceChildren = preferenceCategories(scope, documents);
        var children = [{
            title: t('policies.allPolicies'),
            type: 'folder',
            opened: false,
            icon: 'ico-folder',
            template: 'all_policies',
            scope: scope,
            children: [],
            preferenceDocuments: documents.filter(function(document) { return document.scope === scope; }),
            includePreferences: true,
            help: t('policySearch.description')
        }, {
            title: t('policies.title'),
            type: 'folder',
            opened: false,
            icon: 'ico-folder',
            scope: scope,
            children: [windowsPolicySettingsNode(scope), administrativeTemplates(scope)]
        }];
        if (preferenceChildren.length) children.push({
            title: t('preferences.title'),
            type: 'folder',
            opened: false,
            icon: editorIcons.preferencesRoot(),
            scope: scope,
            children: preferenceChildren,
            help: t('preferences.description')
        });

        return {
            title: isComputer ? t('policies.machine') : t('policies.user'),
            type: 'folder',
            opened: false,
            icon: isComputer ? 'ico-computer' : 'ico-user',
            help: isComputer ? t('policies.machineLevelPolicies') : t('policies.userLevelPolicies'),
            children: children
        };
    }

    function buildTreeViewList(openResult) {
        var result = openResult || {};
        var documents = payloadList(result, 'preference_documents');
        var gpo = result.gpo || {};
        return [{
            title: gpo.displayname || API.getDisplayName() || t('policies.localGroupPolicy'),
            type: 'folder',
            opened: true,
            help: t('policies.localGroupPolicies'),
            children: [
                scopeNode('computer', documents),
                scopeNode('user', documents)
            ]
        }];
    }

    function loadTreeViewList() {
        return API.open().then(buildTreeViewList);
    }

    return {
        buildTreeViewList: buildTreeViewList,
        loadTreeViewList: loadTreeViewList,
        policyNode: policyNode,
        preferenceCategories: preferenceCategories
    };
});
