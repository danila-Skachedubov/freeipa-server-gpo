define(['../../locales/translations', '../../util/API'], function(translations, API) {
    "use strict";

    var t = translations.t;

    function payloadList(result, key) {
        if (Array.isArray(result)) return result;
        return result && Array.isArray(result[key]) ? result[key] : [];
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
                children: [],
                loadChildren: function() {
                    return API.children(scope, node.id).then(function(result) {
                        return payloadList(result, 'children').map(function(child) {
                            return policyNode(scope, child);
                        });
                    });
                }
            };
        }

        return {
            title: node.label || node.id,
            type: 'file',
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
            children: [],
            loadChildren: function() {
                return API.children(scope, null).then(function(result) {
                    return payloadList(result, 'children').map(function(node) {
                        return policyNode(scope, node);
                    });
                });
            }
        };
    }

    function preferenceNode(document) {
        return {
            title: document.label || document.kind,
            type: 'file',
            icon: 'ico-file',
            template: 'preferences',
            scope: document.scope,
            preferenceKind: document.kind,
            document: document,
            readOnly: !document.editable
        };
    }

    function scopeNode(scope, documents) {
        var isComputer = scope === 'computer';
        var preferenceChildren = documents
            .filter(function(document) { return document.scope === scope; })
            .map(preferenceNode);
        var children = [administrativeTemplates(scope)];

        if (preferenceChildren.length) {
            children.push({
                title: t('preferences.title'),
                type: 'folder',
                opened: false,
                icon: 'ico-folder',
                children: preferenceChildren,
                help: t('preferences.description')
            });
        }

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
        policyNode: policyNode
    };
});
