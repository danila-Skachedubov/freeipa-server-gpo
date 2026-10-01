define(['../../../locales/translations'], function(translations) {
    "use strict";

    function identity(namespace, id) {
        return String(namespace || '') + '\u0000' + String(id || '');
    }

    function reference(value) {
        if (Array.isArray(value)) {
            return { namespace: value[0], id: value[1] };
        }
        return value || { namespace: '', id: '' };
    }

    function inferredControl(element) {
        var kind = element.value_type === 'string' ? 'text_box' : element.value_type;
        return {
            kind: kind,
            element_id: element.id,
            label: element.id,
            read_only: false,
            children: []
        };
    }

    function controlElement(policy, control) {
        return (policy.elements || []).find(function(element) {
            return element.id === control.element_id;
        }) || null;
    }

    function buildSecurityModel(response) {
        var result = response || {};
        var catalog = result.security_catalog || {};
        var snapshot = result.security_snapshot || {};
        var states = new Map();
        (snapshot.policies || []).forEach(function(state) {
            states.set(identity(state.namespace, state.policy_id), state);
        });

        var categories = new Map();
        (catalog.categories || []).forEach(function(category) {
            categories.set(identity(category.namespace, category.id), {
                namespace: category.namespace,
                id: category.id,
                label: category.display_name || category.id,
                parent: category.parent ? reference(category.parent) : null,
                categories: [],
                policies: []
            });
        });

        var policies = new Map();
        (catalog.policies || []).forEach(function(definition) {
            var key = identity(definition.namespace, definition.policy_id);
            var category = reference(definition.category);
            var policy = {
                namespace: definition.namespace,
                policyId: definition.policy_id,
                definition: definition,
                state: states.get(key) || {
                    namespace: definition.namespace,
                    policy_id: definition.policy_id,
                    state: 'undefined'
                },
                controls: (definition.controls || []).length
                    ? definition.controls
                    : (definition.elements || []).map(inferredControl),
                diagnostics: (snapshot.diagnostics || []).filter(function(diagnostic) {
                    return !diagnostic.policy_id
                        || diagnostic.policy_id === definition.policy_id;
                })
            };
            policies.set(key, policy);
            var owner = categories.get(identity(category.namespace, category.id));
            if (owner) owner.policies.push(policy);
        });

        var roots = [];
        categories.forEach(function(category) {
            var parent = category.parent && categories.get(identity(
                category.parent.namespace, category.parent.id
            ));
            if (parent && parent !== category) parent.categories.push(category);
            else roots.push(category);
        });
        function compare(left, right) {
            return String(left.label || left.definition && left.definition.display_name || '')
                .localeCompare(String(right.label || right.definition && right.definition.display_name || ''));
        }
        categories.forEach(function(category) {
            category.categories.sort(compare);
            category.policies.sort(compare);
        });
        roots.sort(compare);

        return {
            response: result,
            catalog: catalog,
            snapshot: snapshot,
            categories: roots,
            policies: policies,
            preserved: snapshot.preserved || [],
            diagnostics: snapshot.diagnostics || []
        };
    }

    function policyNode(model, policy) {
        var collection = collectionElement(policy);
        return {
            title: policy.definition.display_name || policy.policyId,
            type: collection ? 'folder' : 'file',
            icon: collection ? 'ico-folder' : 'ico-file',
            template: 'security',
            showInTree: Boolean(collection),
            children: collection ? [] : undefined,
            securityCollection: collection ? collection.id : undefined,
            securityModel: model,
            securityPolicy: {
                namespace: policy.namespace,
                policy_id: policy.policyId
            },
            help: policy.definition.explain_text || undefined
        };
    }

    function collectionElement(policy) {
        var elements = policy && policy.definition.elements || [];
        return elements.length === 1 && elements[0].value_type === 'collection'
            ? elements[0] : null;
    }

    function writableElement(policy, id) {
        var matched = false, writable = false;
        function visit(controls, inherited) {
            (controls || []).forEach(function(control) {
                var readOnly = inherited || control.read_only;
                if (control.element_id === id) { matched = true; writable = writable || !readOnly; }
                visit(control.children, readOnly);
            });
        }
        visit(policy.controls, false);
        return !matched || writable;
    }

    function categoryNodes(model, categories) {
        var groups = new Map();
        (categories || []).forEach(function(category) {
            // A catalog category is qualified by its SDMX namespace. Several
            // BaseALT definition files can nevertheless contribute to the
            // same folder. Keep third-party namespaces separate even when
            // their IDs and translated labels happen to be identical.
            var namespace = String(category.namespace || '');
            var key = namespace.indexOf('urn:altlinux:sdmx:policies:') === 0
                ? 'basealt\u0000' + identity(category.id, category.label)
                : 'qualified\u0000' + identity(namespace, category.id);
            var group = groups.get(key);
            if (!group) {
                group = { label: category.label, categories: [], policies: [] };
                groups.set(key, group);
            }
            group.categories.push.apply(group.categories, category.categories);
            group.policies.push.apply(group.policies, category.policies);
        });
        return Array.from(groups.values()).map(function(group) {
            group.policies.sort(function(left, right) {
                return String(left.definition.display_name || left.policyId)
                    .localeCompare(String(right.definition.display_name || right.policyId));
            });
            if (!group.categories.length && group.policies.length === 1
                    && collectionElement(group.policies[0])) {
                var collectionNode = policyNode(model, group.policies[0]);
                collectionNode.title = group.label;
                return collectionNode;
            }
            return {
                title: group.label,
                type: 'folder',
                opened: false,
                icon: 'ico-folder',
                template: 'security',
                securityCategory: true,
                securityModel: model,
                children: categoryNodes(model, group.categories).concat(
                    group.policies.map(function(policy) {
                        return policyNode(model, policy);
                    })
                )
            };
        }).sort(function(left, right) {
            return left.title.localeCompare(right.title);
        });
    }

    function navigationNodes(response) {
        var model = buildSecurityModel(response);
        var nodes = categoryNodes(model, model.categories);
        if (model.preserved.length || model.diagnostics.length) {
            nodes.push({
                title: translations ? translations.t('security.preservedTitle') : 'Preserved and diagnostic records',
                type: 'file',
                icon: 'ico-file',
                template: 'security',
                showInTree: true,
                securityModel: model,
                securityPreserved: true,
                readOnly: true
            });
        }
        return nodes.sort(function(left, right) { return left.title.localeCompare(right.title); });
    }

    function policy(model, ref) {
        return model && ref
            ? model.policies.get(identity(ref.namespace, ref.policy_id)) || null
            : null;
    }

    function element(policyModel, elementId) {
        return policyModel && (policyModel.definition.elements || []).find(function(item) {
            return item.id === elementId;
        }) || null;
    }

    function elementState(policyModel, elementId) {
        if (!policyModel || policyModel.state.state !== 'defined') {
            return { state: 'unset' };
        }
        return policyModel.state.elements && policyModel.state.elements[elementId]
            || { state: 'unset' };
    }

    function typedValue(state) {
        return state && state.state === 'set' ? state.value : null;
    }

    function collectionKey(elementDefinition, row) {
        if (!elementDefinition || !elementDefinition.unique_by || !row) return null;
        return typedValue(row[elementDefinition.unique_by]);
    }

    return {
        identity: identity,
        buildSecurityModel: buildSecurityModel,
        navigationNodes: navigationNodes,
        policy: policy,
        element: element,
        controlElement: controlElement,
        elementState: elementState,
        typedValue: typedValue,
        collectionKey: collectionKey,
        collectionElement: collectionElement,
        writableElement: writableElement
    };
});
