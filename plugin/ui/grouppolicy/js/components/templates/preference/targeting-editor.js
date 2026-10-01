define([
    '../../../util/element-creator',
    '../../../util/editor-dto',
    '../../../util/targeting-tree-draft',
    '../../list-navigation',
    '../../editor-icons',
    './targeting-presentations',
    './targeting-operand-editor'
], function(elementCreator, dto, targetingDraft, listNavigation, editorIcons, presentations, operandEditor) {
    'use strict';
    var create = elementCreator.createElement;

    function render(options) {
        var pt = options.pt;
        var readonly = Boolean(options.readonly);
        var formState = options.formState;
        var kinds = options.showResult.filter_kinds || [];
        var accepted = targetingDraft.create(options.showResult);
        var draft = accepted.clone();
        var selectedId = null;
        var selectedControls = [];
        var selectedOperands = null;
        var combineTouched = false;
        var notTouched = false;
        var language = options.language || 'en';
        var collapsed = new Set();
        var errorIds = new Set();
        var dragId = null;
        var dropTarget = null;
        var navigation = null;
        var container = create('div', { className: 'gpo-editor-filters' });
        var toolbar = create('div', { className: 'gpo-editor-filters__toolbar' });
        var notice = create('div', { className: 'gpo-editor-filters__notice', attrs: { role: 'status', 'aria-live': 'polite' } });
        var tree = create('div', { className: 'gpo-editor-filters__tree', attrs: { role: 'tree', 'aria-label': pt('targettingTitle') } });
        var properties = create('div', { className: 'gpo-editor-filters__fields' });
        var menu = create('div', { className: 'gpo-editor-filters__menu', attrs: { role: 'menu', hidden: 'hidden' } });
        var collectionKind = kinds.find(function(kind) { return kind.supports_children || kind.kind === 'collection'; });
        var createButton = create('button', {
            className: ['button', 'gpo-editor-filter-add'],
            attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
            text: pt('createTargetingItem') + ' ▾'
        });
        var addCollection = create('button', { className: 'button', attrs: { type: 'button' }, text: pt('addTargetingCollection') });
        var combineSelect = create('select', { attrs: { 'aria-label': pt('targetingOperator') }, children: [
            create('option', { attrs: { value: 'and' }, text: pt('targetingAnd') }),
            create('option', { attrs: { value: 'or' }, text: pt('targetingOr') })
        ] });
        var notCheckbox = create('input', { attrs: { type: 'checkbox', 'aria-label': pt('targetingNot') } });
        var removeButton = create('button', { className: ['button', 'gpo-editor-filter-remove'], attrs: {
            type: 'button', 'aria-label': pt('removeFilter'), title: pt('removeFilter')
        }, children: [create('span', { attrs: { 'aria-hidden': 'true' }, html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>' })] });
        var shortcutHelp = create('span', { className: 'gpo-editor-visually-hidden', id: 'gpo-targeting-shortcuts', text: pt('targetingKeyboardHelp') });
        tree.setAttr('aria-describedby', 'gpo-targeting-shortcuts');

        function blocked() { return readonly || formState.busy; }
        function locate(id, nodes, parent) {
            var list = nodes || draft.roots;
            for (var i = 0; i < list.length; i += 1) {
                if (list[i].id === id) return { node: list[i], parent: parent || null, siblings: list, index: i };
                var child = locate(id, list[i].children, list[i]);
                if (child) return child;
            }
            return null;
        }
        function descendant(node, id) {
            return node.id === id || node.children.some(function(child) { return descendant(child, id); });
        }
        function capture() {
            var location = locate(selectedId);
            var node = location && location.node;
            if (!node || !node.available) return;
            var operands = new Map((selectedOperands ? selectedOperands.readFields() : []).map(function(field) { return [field.id, field]; }));
            var common = ['filter.bool', 'filter.not', 'filter.combine', 'filter.negate', 'filter.hidden'];
            draft.updateFields(node.id, node.fields.map(function(current) {
                var field = common.indexOf(current.id) === -1 && operands.has(current.id) ? operands.get(current.id) : current;
                var value = dto.clone(field.value);
                if (combineTouched && location.index > 0 && (field.id === 'filter.bool' || field.id === 'filter.combine') && field.editable !== false) value.value = combineSelect.getElement().value;
                if (notTouched && (field.id === 'filter.not' || field.id === 'filter.negate') && field.editable !== false) value.value = notCheckbox.getElement().checked;
                return Object.assign({}, field, { value: value });
            }));
        }
        function setNotice(message) { notice.setText(message || ''); }
        function hideMenu() {
            menu.getElement().hidden = true;
            createButton.setAttr('aria-expanded', 'false');
        }
        function syncToolbar() {
            createButton.getElement().disabled = blocked() || !kinds.length;
            addCollection.getElement().disabled = blocked() || !collectionKind;
            removeButton.getElement().disabled = blocked() || !selectedId;
            var location = locate(selectedId);
            var node = location && location.node;
            var combine = node && node.fields.find(function(field) { return field.id === 'filter.bool' || field.id === 'filter.combine'; });
            var negate = node && node.fields.find(function(field) { return field.id === 'filter.not' || field.id === 'filter.negate'; });
            combineSelect.getElement().disabled = blocked() || !node || location.index === 0 || !node.available || !combine || combine.editable === false;
            notCheckbox.getElement().disabled = blocked() || !node || !node.available || !negate || negate.editable === false;
            combineSelect.getElement().value = combine ? dto.valuePayload(combine.value) : 'and';
            notCheckbox.getElement().checked = Boolean(negate && dto.valuePayload(negate.value));
            combineTouched = false; notTouched = false;
        }
        function focusNode(id) {
            var row = Array.from(tree.getElement().querySelectorAll('[data-targeting-id]')).find(function(element) {
                return element.getAttribute('data-targeting-id') === id;
            });
            if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
        }
        function select(id, focus) {
            capture(); selectedId = id;
            var current = locate(id);
            while (current && current.parent) { collapsed.delete(current.parent.id); current = locate(current.parent.id); }
            renderTree(); renderFields(); syncToolbar();
            if (focus) focusNode(id);
        }
        function focusOperands(id) {
            if (blocked()) return;
            if (selectedId !== id) select(id);
            var control = properties.getElement().querySelector('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),[contenteditable="true"]');
            if (control) control.focus({ preventScroll: true });
            else { properties.setAttr('tabindex', '-1'); properties.getElement().focus({ preventScroll: true }); }
        }
        function fieldPayload(node, id) {
            var field = node.fields.find(function(candidate) { return candidate.id === id; });
            return field ? dto.valuePayload(field.value) : null;
        }
        function summary(node) {
            if (node.kind === 'ip_range' && fieldPayload(node, 'filter.useIPv6') === true) {
                var address = fieldPayload(node, 'filter.min'), prefix = fieldPayload(node, 'filter.max');
                return address ? address + (prefix === null || prefix === undefined || prefix === '' ? '' : '/' + prefix) : '';
            }
            var common = ['filter.bool', 'filter.not', 'filter.combine', 'filter.negate', 'filter.hidden', 'filter.displayName', 'filter.useIPv6'];
            var values = node.fields.filter(function(field) { return common.indexOf(field.id) === -1 && field.editable; })
                .map(function(field) {
                    var value = dto.valuePayload(field.value);
                    var choices = presentations.choices(node.kind, field.id, language) || field.choices || [];
                    var choice = choices.find(function(candidate) { return candidate.key === value; });
                    if (field.id === 'filter.languageLocale') return fieldPayload(node, 'filter.displayName') || choice && choice.label || value;
                    return choice ? choice.label : value;
                })
                .filter(function(value) { return value !== null && value !== undefined && value !== '' && typeof value !== 'boolean'; });
            return values.length ? values.map(function(value) { return Array.isArray(value) ? value.join(', ') : String(value); }).join(' · ') : node.detail || '';
        }
        function clearDrop() {
            tree.getElement().querySelectorAll('.targeting-drop-before, .targeting-drop-after, .targeting-drop-inside, .targeting-drop-invalid').forEach(function(row) {
                row.classList.remove('targeting-drop-before', 'targeting-drop-after', 'targeting-drop-inside', 'targeting-drop-invalid');
            });
            dropTarget = null;
        }
        function endDrag() {
            clearDrop(); dragId = null; container.removeClass('is-dragging');
        }
        function destination(node, event, row) {
            var box = row.getBoundingClientRect();
            var offset = (event.clientY - box.top) / Math.max(1, box.height);
            var where = node.supports_children && offset > 0.25 && offset < 0.75 ? 'inside' : offset > 0.5 ? 'after' : 'before';
            var location = locate(node.id);
            var parent = where === 'inside' ? node : location.parent;
            var index = where === 'inside' ? node.children.length : location.index + (where === 'after' ? 1 : 0);
            var source = locate(dragId);
            if (source && source.parent === parent && source.index < index) index -= 1;
            return { parentId: parent && parent.id, index: index, where: where, valid: Boolean(source && node.id !== dragId && (!parent || !descendant(source.node, parent.id))) };
        }
        function applyMove(parentId, index) {
            if (blocked() || !selectedId) return;
            capture();
            try {
                var source = locate(selectedId);
                var noop = source && (source.parent && source.parent.id || null) === (parentId || null) && source.index === index;
                var changed = draft.move(selectedId, parentId, index);
                if (parentId) collapsed.delete(parentId);
                setNotice(changed ? pt('targetingMoved') : noop ? '' : pt('targetingDepthLimit'));
                renderTree(); syncToolbar(); focusNode(selectedId);
            } catch (_) { setNotice(pt('invalidTargetingMove')); }
        }
        function renderTree() {
            tree.getElement().innerHTML = '';
            var first = true;
            function append(nodes, depth) {
                nodes.forEach(function(node, index) {
                    var combine = String(fieldPayload(node, 'filter.bool') || fieldPayload(node, 'filter.combine') || node.combine || 'and').toLowerCase();
                    var logic = index === 0 ? '' : pt(combine === 'or' ? 'targetingOr' : 'targetingAnd') + ' ';
                    var negate = fieldPayload(node, 'filter.not');
                    if (negate === null || negate === undefined) negate = fieldPayload(node, 'filter.negate');
                    if (negate === null || negate === undefined) negate = node.negate;
                    if (negate) logic += pt('targetingNot') + ' ';
                    var row = create('div', {
                        className: ['gpo-editor-filter-node', node.id === selectedId ? 'active' : null, fieldPayload(node, 'filter.hidden') ? 'is-hidden-filter' : null, errorIds.has(node.id) ? 'gpo-editor-filter-node--error' : null],
                        attrs: { role: 'treeitem', 'data-targeting-id': node.id, 'aria-level': depth + 1,
                            'aria-selected': String(node.id === selectedId), 'aria-expanded': node.supports_children ? String(!collapsed.has(node.id)) : null,
                            tabindex: node.id === selectedId || !selectedId && first ? '0' : '-1' },
                        style: { paddingLeft: (depth * 18 + 4) + 'px' }
                    });
                    first = false;
                    var handle = create('button', {
                        className: 'gpo-editor-filter-handle', attrs: { type: 'button', draggable: blocked() ? 'false' : 'true',
                            disabled: blocked() ? 'disabled' : null, tabindex: '-1', 'aria-label': pt('dragTargetingItem'), title: pt('dragTargetingItem') },
                        html: '<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="6" cy="3" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="6" cy="13" r="1"/></svg>'
                    });
                    handle.on('click', function(event) { event.stopPropagation(); select(node.id, true); });
                    handle.on('dragstart', function(event) {
                        if (blocked()) { event.preventDefault(); return; }
                        capture(); selectedId = node.id; dragId = node.id; dropTarget = null;
                        renderFields(); syncToolbar();
                        tree.getElement().querySelectorAll('[data-targeting-id]').forEach(function(element) {
                            var selected = element.getAttribute('data-targeting-id') === node.id;
                            element.classList.toggle('active', selected);
                            element.setAttribute('aria-selected', String(selected));
                            element.setAttribute('tabindex', selected ? '0' : '-1');
                        });
                        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.id);
                        container.addClass('is-dragging'); row.addClass('active');
                    });
                    handle.on('dragend', endDrag);
                    row.append(handle);
                    var arrow = create('button', { className: 'gpo-editor-filter-arrow', attrs: { type: 'button', tabindex: '-1',
                        'aria-label': pt(collapsed.has(node.id) ? 'expandTargetingCollection' : 'collapseTargetingCollection'),
                        disabled: !node.supports_children ? 'disabled' : null }, text: node.supports_children ? collapsed.has(node.id) ? '›' : '⌄' : '' });
                    arrow.on('click', function(event) {
                        event.stopPropagation(); capture();
                        if (formState.busy) return;
                        if (collapsed.has(node.id)) collapsed.delete(node.id);
                        else {
                            collapsed.add(node.id);
                            if (selectedId && selectedId !== node.id && descendant(node, selectedId)) {
                                selectedId = node.id; renderFields(); syncToolbar();
                            }
                        }
                        renderTree();
                        focusNode(selectedId || node.id);
                    });
                    row.append(arrow);
                    row.append(create('span', { className: ['gpo-editor-filter-icon', editorIcons.targeting(node.supports_children ? 'collection' : node.kind)], attrs: { 'aria-hidden': 'true' } }));
                    row.append(create('span', { className: 'gpo-editor-filter-label', children: [
                        create('span', { text: logic + nodeLabel(node) }),
                        create('span', { className: 'gpo-editor-filter-detail', text: summary(node) })
                    ] }));
                    row.on('click', function(event) { event.stopPropagation(); if (!formState.busy) select(node.id, true); });
                    row.on('dblclick', function(event) {
                        if (event.target.closest('button,input,select,textarea,[contenteditable]:not([contenteditable="false"])')) return;
                        event.preventDefault(); event.stopPropagation(); focusOperands(node.id);
                    });
                    row.on('dragover', function(event) {
                        if (!dragId || blocked()) return;
                        event.preventDefault(); event.stopPropagation(); clearDrop();
                        dropTarget = destination(node, event, row.getElement());
                        event.dataTransfer.dropEffect = dropTarget.valid ? 'move' : 'none';
                        row.addClass(dropTarget.valid ? 'targeting-drop-' + dropTarget.where : 'targeting-drop-invalid');
                    });
                    row.on('drop', function(event) {
                        if (!dragId || !dropTarget) return;
                        event.preventDefault(); event.stopPropagation();
                        var target = dropTarget; selectedId = dragId;
                        if (target.valid) applyMove(target.parentId, target.index); else setNotice(pt('invalidTargetingMove'));
                        endDrag();
                    });
                    tree.append(row);
                    if (!collapsed.has(node.id)) append(node.children, depth + 1);
                });
            }
            append(draft.roots, 0);
            if (!draft.roots.length) tree.append(create('div', { className: 'gpo-editor-filters__empty', text: pt('targetingEmpty') }));
            var rootDrop = create('div', { className: 'gpo-editor-filters__root-drop', text: pt('targetingRootDrop') });
            rootDrop.on('dragover', function(event) {
                if (!dragId || blocked()) return;
                event.preventDefault(); clearDrop(); var source = locate(dragId);
                dropTarget = { parentId: null, index: draft.roots.length - (source && !source.parent ? 1 : 0), valid: true };
                rootDrop.addClass('targeting-drop-inside');
            });
            rootDrop.on('drop', function(event) {
                if (!dragId || !dropTarget) return;
                event.preventDefault(); selectedId = dragId; applyMove(dropTarget.parentId, dropTarget.index); endDrag();
            });
            tree.append(rootDrop);
            if (navigation) navigation.sync();
        }
        function renderFields() {
            properties.getElement().innerHTML = ''; selectedControls = []; selectedOperands = null;
            var node = draft.find(selectedId);
            container.setAttr('data-selected-kind', node && node.kind || '');
            if (!node) { properties.append(create('div', { className: 'gpo-editor-filters__empty', text: pt('selectFilter') })); return; }
            properties.append(create('h3', { text: nodeLabel(node) }));
            if (!node.available) { properties.append(create('div', { className: 'gpo-editor-preference-notice', text: pt('unsupportedFilterFields') })); return; }
            selectedOperands = operandEditor.render({ node: node, blocked: blocked(), scope: options.scope,
                language: language, fieldControl: options.fieldControl, pt: pt,
                onChange: function() { capture(); errorIds.clear(); setNotice(''); renderTree(); } });
            selectedControls = selectedOperands.controls;
            properties.append(selectedOperands.element);
        }
        function nodeLabel(node) {
            if (node.supports_children) return fieldPayload(node, 'filter.name') || node.label || presentations.kindLabel(node.kind, node.kind, language);
            return presentations.kindLabel(node.kind, node.label || node.kind || pt('unsupportedFilterFields'), language);
        }
        function add(kind) {
            if (blocked()) return;
            capture(); hideMenu();
            var location = locate(selectedId);
            var parentId = location && location.node.supports_children ? location.node.id : location && location.parent ? location.parent.id : null;
            var index = location && location.node.supports_children ? location.node.children.length : location ? location.index + 1 : draft.roots.length;
            var node = draft.add(kind, parentId, index);
            if (!node) { setNotice(pt('targetingDepthLimit')); return; }
            draft.updateFields(node.id, operandEditor.initialize(node, { language: language, scope: options.scope }));
            if (parentId) collapsed.delete(parentId);
            selectedId = node.id; setNotice(''); renderTree(); renderFields(); syncToolbar(); focusNode(selectedId);
        }
        function remove() {
            if (blocked() || !selectedId) return;
            capture();
            var location = locate(selectedId);
            if (!location) return;
            var removedId = selectedId;
            var siblings = location.siblings.map(function(node) { return node.id; });
            if (!draft.remove(removedId)) return;
            selectedId = listNavigation.neighbor(siblings, [removedId], location.siblings.map(function(node) { return node.id; }))
                || (location.parent ? location.parent.id : null);
            setNotice(''); renderTree(); renderFields(); syncToolbar();
            if (selectedId) focusNode(selectedId);
            else tree.getElement().focus({ preventScroll: true });
        }
        kinds.filter(function(kind) { return !kind.supports_children && kind.kind !== 'collection'; }).forEach(function(kind) {
            if (options.scope === 'computer' && ['dun', 'terminal', 'user'].indexOf(kind.kind) !== -1) return;
            menu.append(create('button', { attrs: { type: 'button', role: 'menuitem', 'data-kind': kind.kind }, children: [
                create('span', { className: ['gpo-editor-filter-icon', editorIcons.targeting(kind.kind)], attrs: { 'aria-hidden': 'true' } }),
                create('span', { text: presentations.kindLabel(kind.kind, kind.label || kind.kind, language) })
            ], events: { click: function() { add(kind.kind); } } }));
        });
        createButton.on('click', function() {
            if (blocked()) return;
            menu.getElement().hidden = !menu.getElement().hidden;
            createButton.setAttr('aria-expanded', String(!menu.getElement().hidden));
            if (!menu.getElement().hidden && menu.getElement().firstElementChild) menu.getElement().firstElementChild.focus();
        });
        menu.on('keydown', function(event) {
            var entries = Array.from(menu.getElement().querySelectorAll('button'));
            var index = entries.indexOf(document.activeElement);
            if (event.key === 'Escape') { event.preventDefault(); hideMenu(); createButton.getElement().focus(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); entries[(index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length].focus();
            }
        });
        addCollection.on('click', function() { if (collectionKind) add(collectionKind.kind); });
        removeButton.on('click', remove);
        combineSelect.on('change', function() { if (combineSelect.getElement().disabled) return; combineTouched = true; capture(); renderTree(); });
        notCheckbox.on('change', function() { notTouched = true; capture(); renderTree(); });
        tree.on('click', function(event) { if (event.target === tree.getElement()) select(null); });
        tree.on('keydown', function(event) {
            if (event.defaultPrevented || formState.busy || event.altKey || event.metaKey
                    || event.target.closest('input,select,textarea,a,summary,[contenteditable]:not([contenteditable="false"])')) return;
            var row = event.target.closest('[data-targeting-id]'); if (!row) return;
            var id = row.getAttribute('data-targeting-id'); var location = locate(id);
            if (!location) return;
            if (event.ctrlKey && !blocked() && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault(); select(id, true); applyMove(location.parent && location.parent.id, Math.max(0, Math.min(location.siblings.length - 1, location.index + (event.key === 'ArrowUp' ? -1 : 1)))); return;
            }
            if (event.ctrlKey && !blocked() && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                event.preventDefault(); select(id, true);
                if (event.key === 'ArrowLeft' && location.parent) {
                    var parentLocation = locate(location.parent.id);
                    applyMove(parentLocation.parent && parentLocation.parent.id, parentLocation.index + 1);
                } else if (event.key === 'ArrowRight' && location.index > 0 && location.siblings[location.index - 1].supports_children) {
                    var previous = location.siblings[location.index - 1];
                    applyMove(previous.id, previous.children.length);
                } else setNotice(pt('targetingKeyboardMoveUnavailable'));
                return;
            }
            if (event.ctrlKey || event.shiftKey || event.target.closest('button')) return;
            if (event.key === 'ArrowRight' && location.node.supports_children) { event.preventDefault(); if (collapsed.has(id)) { collapsed.delete(id); renderTree(); focusNode(id); } else if (location.node.children.length) select(location.node.children[0].id, true); }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); if (location.node.supports_children && !collapsed.has(id)) { collapsed.add(id); renderTree(); focusNode(id); } else if (location.parent) select(location.parent.id, true); }
        });
        navigation = listNavigation.bind(tree.getElement(), {
            rows: function() { return tree.getElement().querySelectorAll('[data-targeting-id]'); },
            selected: function() { return Array.from(tree.getElement().querySelectorAll('[data-targeting-id]')).find(function(row) { return row.getAttribute('data-targeting-id') === selectedId; }) || null; },
            select: function(row) { select(row.getAttribute('data-targeting-id')); },
            activate: function(row) { focusOperands(row.getAttribute('data-targeting-id')); },
            remove: remove,
            canActivate: function(row) { var node = draft.find(row.getAttribute('data-targeting-id')); return !readonly && Boolean(node && node.available); },
            canRemove: function() { return !readonly; },
            busy: function() { return Boolean(formState.busy || dragId); }
        });
        container.cleanup = function() { endDrag(); navigation.cleanup(); };
        container.on('keydown', function(event) {
            if (event.key === 'Escape' && (dragId || !menu.getElement().hidden)) {
                event.preventDefault(); event.stopPropagation(); endDrag(); hideMenu();
            }
        });
        container.on('input', function() { errorIds.clear(); setNotice(''); });
        container.on('click', function(event) { if (!event.target.closest('.gpo-editor-filters__create')) hideMenu(); });
        toolbar.append(create('div', { className: 'gpo-editor-filters__create', children: [createButton, menu] }));
        toolbar.append(addCollection);
        toolbar.append(create('label', { className: 'gpo-editor-filter-operator', attrs: { 'data-field-id': 'filter.bool' }, children: [combineSelect] }));
        toolbar.append(create('label', { className: 'gpo-editor-filter-negation', attrs: { 'data-field-id': 'filter.not' }, children: [notCheckbox, create('span', { text: pt('targetingNot') })] }));
        toolbar.append(removeButton);
        container.append(toolbar); container.append(shortcutHelp); container.append(notice);
        container.append(create('div', { className: 'gpo-editor-filters__layout', children: [tree, properties] }));
        formState.beginFilterDraft = function() {
            draft = accepted.clone(); selectedId = null; selectedControls = []; selectedOperands = null; errorIds.clear(); setNotice('');
            hideMenu(); renderTree(); renderFields(); syncToolbar();
        };
        formState.cancelFilterDraft = function() { formState.beginFilterDraft(); };
        formState.acceptFilterDraft = function() {
            capture(); var result = validatedResult(draft); errorIds = new Set(result.errors.map(function(error) { return error.id; }));
            if (result.errors.length) {
                select(result.errors[0].id); setNotice(pt('validationFixErrors'));
                result.errors.filter(function(error) { return error.id === selectedId; }).forEach(function(error) {
                    selectedControls.filter(function(control) { return control.id === error.fieldId; }).forEach(function(control) { control.setError(options.validationMessage(error.code)); });
                });
                var first = selectedControls.find(function(control) { return control.id === result.errors[0].fieldId; }); if (first) first.focus();
                return false;
            }
            accepted = draft.clone(); if (result.operations.length) formState.dirty = true;
            return true;
        };
        formState.readFilterResult = function() {
            var result = validatedResult(accepted);
            return { operations: result.operations, errors: result.errors.map(function(error) { return { path: accepted.flatten().find(function(entry) { return entry.node.id === error.id; }).path, id: error.fieldId, code: error.code }; }) };
        };
        function validatedResult(model) {
            return model.compile({ validateNode: function(node) {
                if (presentations.supportedKinds.indexOf(node.kind) === -1) return null;
                var errors = [];
                node.fields.forEach(function(field) {
                    if (field.editable === false || ['filter.bool', 'filter.not', 'filter.combine', 'filter.negate', 'filter.hidden'].indexOf(field.id) === -1) return;
                    var code = dto.validatePreferenceField(field, field.value);
                    if (code) errors.push({ fieldId: field.id, code: code });
                });
                return errors.concat(operandEditor.validateFields(node));
            } });
        }
        renderTree(); renderFields(); syncToolbar();
        return container;
    }
    return { render: render };
});
