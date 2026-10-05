define(['../util/element-creator', '../util/collection-value', '../locales/translations', './editor-dialog', './list-navigation'], function(elements, collections, translations, editorDialog, listNavigation) {
    'use strict';
    var create = elements.createElement;
    var sequence = 0;
    function tr(key, values) {
        var text = translations.t('collections.' + key);
        Object.keys(values || {}).forEach(function(name) { text = text.replace('{' + name + '}', values[name]); });
        return text;
    }
    function open(host, options) {
        var state = collections.session(options.parameter, options.value);
        var readOnly = Boolean(options.readOnly);
        var fields = state.mode === 'key_value' ? ['key', 'value'] : ['value'];
        var rules = collections.constraints(options.parameter, options.value);
        var prefix = 'collection-' + (++sequence);
        var activeCell = { id: state.rows[0] && state.rows[0].id, field: fields[0] };
        var editing = null;
        var drag = null;
        var scrollFrame = null;
        var dialog;
        var add = create('button', { className: 'button', attrs: { type: 'button', 'data-collection-add': '' }, text: tr('add') });
        var remove = create('button', { className: 'button', attrs: { type: 'button', 'data-collection-remove': '' }, text: tr('remove') });
        var search = create('input', { attrs: { type: 'search', placeholder: tr('search'), 'aria-label': tr('search') } });
        var toolbar = create('div', { className: 'gpo-collection-editor__toolbar', children: [readOnly ? null : add, readOnly ? null : remove, search] });
        var errors = create('div', { className: 'gpo-collection-editor__validation', attrs: { role: 'alert' } });
        var count = create('div', { className: 'gpo-collection-editor__count' });
        var live = create('div', { className: 'gpo-collection-editor__live', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
        var body = create('tbody');
        var table = create('table', { className: ['preference__table', 'gpo-collection-table'], attrs: { 'aria-label': options.parameter.label || options.parameter.id, tabindex: '0', 'data-collection-mode': state.mode }, children: [
            create('colgroup', { children: [
                readOnly ? null : create('col', { className: 'gpo-collection-table__handle-column' }),
                create('col', { className: state.mode === 'key_value' ? 'gpo-collection-table__key-column' : 'gpo-collection-table__index-column' }),
                create('col')
            ] }),
            create('thead', { children: [create('tr', { children: [
                readOnly ? null : create('th', { attrs: { scope: 'col', 'aria-label': tr('reorder') } }),
                create('th', { attrs: { scope: 'col' }, text: state.mode === 'key_value' ? tr('key') : tr('index') }),
                create('th', { attrs: { scope: 'col' }, text: tr('value') })
            ] })] }), body
        ] });
        var scroll = create('div', { className: 'gpo-collection-editor__table-scroll', children: [table] });
        var content = create('div', { className: 'gpo-collection-editor', children: [toolbar, errors, scroll, count, live] });
        [add, remove].forEach(function(button) {
            button.on('mousedown', function(event) { if (event.button === 0) event.preventDefault(); });
        });

        function pending() { return editing ? { id: editing.id, field: editing.field, value: editing.input.value } : null; }
        function busy() { return Boolean(dialog && (dialog.isBusy() || dialog.root.getElement().inert)); }
        function cellFor(id, field) { return body.getElement().querySelector('[data-collection-row="' + id + '"] [data-collection-field="' + field + '"]'); }
        function announce(text) { live.getElement().textContent = text; }
        function updateSelection() {
            Array.from(body.getElement().querySelectorAll('[data-collection-row]')).forEach(function(row) {
                var id = row.getAttribute('data-collection-row');
                row.classList.toggle('active', state.selectedId === id);
                row.setAttribute('aria-selected', String(state.selectedId === id));
                var handle = row.querySelector('.gpo-collection-table__handle');
                if (handle) handle.tabIndex = -1;
                Array.from(row.querySelectorAll('[data-collection-field]')).forEach(function(cell) {
                    cell.tabIndex = id === activeCell.id && cell.getAttribute('data-collection-field') === activeCell.field ? 0 : -1;
                });
            });
            table.getElement().tabIndex = body.getElement().querySelector('[data-collection-row]') ? -1 : 0;
            remove.getElement().disabled = readOnly || busy() || !state.selectedId;
        }
        function updateValidation() {
            var problems = readOnly ? [] : state.errors(pending());
            errors.getElement().textContent = problems.filter(function(problem) { return !problem.id; }).map(function(problem) { return tr('errors.' + problem.code); }).join(' ');
            Array.from(body.getElement().querySelectorAll('[data-collection-field]')).forEach(function(cell) {
                var id = cell.parentElement.getAttribute('data-collection-row');
                var field = cell.getAttribute('data-collection-field');
                var problem = problems.find(function(error) { return error.id === id && error.field === field; });
                var prior = cell.querySelector('.gpo-collection-cell__error');
                if (prior) prior.remove();
                cell.classList.toggle('gpo-collection-cell--invalid', Boolean(problem));
                var input = cell.querySelector('[data-collection-input]');
                if (problem) {
                    var errorId = prefix + '-' + id + '-' + field + '-error';
                    cell.appendChild(create('span', { id: errorId, className: 'gpo-collection-cell__error', text: tr('errors.' + problem.code) }).getElement());
                    if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errorId); }
                } else if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
            });
            var size = state.read(pending()).value.length;
            count.getElement().textContent = search.getElement().value
                ? tr('shownCount', { shown: state.visible(search.getElement().value).length, total: state.rows.length })
                : tr(state.mode === 'key_value' ? 'pairsCount' : 'itemsCount', { count: size });
            if (dialog) dialog.setApplyDisabled(problems.length !== 0);
            return problems;
        }
        function showCell(cell, row, field) {
            cell.classList.remove('gpo-collection-cell--editing');
            cell.replaceChildren(create('span', { className: 'gpo-collection-cell__text', text: row[field] || '\u00a0' }).getElement());
        }
        function finishEdit(commit) {
            if (!editing) return;
            var current = editing;
            editing = null;
            if (commit) state.edit(current.id, current.field, current.input.value);
            var row = state.find(current.id);
            if (row) showCell(current.cell, row, current.field);
            updateValidation();
        }
        function focusCell(id, field) {
            activeCell = { id: id, field: field };
            updateSelection();
            var cell = cellFor(id, field);
            if (cell) { cell.focus({ preventScroll: true }); cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        }
        function editCell(id, field) {
            if (readOnly || drag || busy()) return;
            finishEdit(true);
            var cell = cellFor(id, field);
            var row = state.find(id);
            if (!cell || !row) return;
            activeCell = { id: id, field: field };
            updateSelection();
            // In supported bindings, unique list entries without explicit keys
            // are registry names too. Only data cells may contain line breaks.
            var singleLine = field === 'key' || state.mode === 'list' && rules.unique_keys;
            var input = create(singleLine ? 'input' : 'textarea', { attrs: { type: singleLine ? 'text' : null, rows: singleLine ? null : '1', spellcheck: 'false', 'aria-label': tr('cellLabel', { column: tr(field), index: state.rows.indexOf(row) }), 'data-collection-input': field } }).getElement();
            input.value = row[field];
            cell.replaceChildren(input);
            cell.classList.add('gpo-collection-cell--editing');
            editing = { id: id, field: field, input: input, cell: cell };
            input.addEventListener('click', function(event) { event.stopPropagation(); });
            input.addEventListener('dblclick', function(event) { event.stopPropagation(); });
            function resizeEditor() {
                if (singleLine) return;
                input.style.height = 'auto';
                input.style.height = Math.min(128, Math.max(28, input.scrollHeight)) + 'px';
            }
            input.addEventListener('input', function() {
                resizeEditor();
                updateValidation();
            });
            input.addEventListener('blur', function() { if (editing && editing.input === input) finishEdit(true); });
            input.addEventListener('keydown', function(event) {
                if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation(); finishEdit(false); focusCell(id, field);
                } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault(); event.stopPropagation(); finishEdit(true); focusCell(id, field);
                } else if (event.key === 'Tab') {
                    var visible = state.visible(search.getElement().value);
                    var position = visible.findIndex(function(item) { return item.id === id; }) * fields.length + fields.indexOf(field) + (event.shiftKey ? -1 : 1);
                    finishEdit(true);
                    if (position >= 0 && position < visible.length * fields.length) {
                        event.preventDefault(); event.stopPropagation();
                        editCell(visible[Math.floor(position / fields.length)].id, fields[position % fields.length]);
                    } else {
                        event.preventDefault(); event.stopPropagation();
                        var target = event.shiftKey
                            ? (!search.getElement().hidden ? search.getElement() : add.getElement())
                            : dialog.root.getElement().querySelector('.btn-cancel');
                        target.focus();
                    }
                }
            });
            input.focus();
            input.setSelectionRange(0, input.value.length);
            resizeEditor();
            cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            updateValidation();
        }
        function selectCell(id, field) {
            if (busy()) return;
            finishEdit(true);
            state.select(id);
            focusCell(id, field);
        }
        function clearDrag() {
            if (scrollFrame !== null) { cancelAnimationFrame(scrollFrame); scrollFrame = null; }
            drag = null;
            Array.from(body.getElement().querySelectorAll('tr')).forEach(function(row) {
                row.classList.remove('gpo-collection-row--dragging', 'gpo-collection-row--before', 'gpo-collection-row--after');
            });
        }
        function focusHandle(id) {
            activeCell.id = id;
            updateSelection();
            var row = body.getElement().querySelector('[data-collection-row="' + id + '"]');
            var handle = row && row.querySelector('.gpo-collection-table__handle');
            if (handle) { focusCell(id, activeCell.field); }
        }
        function autoScroll() {
            if (!drag) { scrollFrame = null; return; }
            var rect = scroll.getElement().getBoundingClientRect();
            if (drag.y >= rect.top && drag.y <= rect.bottom) {
                if (drag.y < rect.top + 28) scroll.getElement().scrollTop -= 8;
                else if (drag.y > rect.bottom - 28) scroll.getElement().scrollTop += 8;
            }
            scrollFrame = requestAnimationFrame(autoScroll);
        }
        function render() {
            finishEdit(true);
            body.getElement().replaceChildren();
            var visible = state.visible(search.getElement().value);
            if (!visible.some(function(row) { return row.id === activeCell.id; })) activeCell.id = visible[0] && visible[0].id;
            search.getElement().hidden = state.rows.length < 20 && !search.getElement().value;
            if (!visible.length) {
                body.append(create('tr', { className: 'gpo-collection-table__empty', children: [create('td', { attrs: { colspan: readOnly ? 2 : 3 }, text: tr(state.rows.length ? 'noMatches' : 'empty') })] }));
            }
            visible.forEach(function(row) {
                var index = state.rows.indexOf(row);
                var record = create('tr', { attrs: { 'data-collection-row': row.id } });
                if (!readOnly) {
                    var handle = create('button', { className: 'gpo-collection-table__handle', attrs: { type: 'button', draggable: search.getElement().value ? 'false' : 'true', 'aria-label': tr('reorderRow', { index: index }), 'aria-describedby': prefix + '-reorder-help', tabindex: '-1', title: tr(search.getElement().value ? 'clearSearchToReorder' : 'reorderHelp') }, text: '\u22ee' });
                    handle.getElement().disabled = Boolean(search.getElement().value);
                    handle.on('click', function() { finishEdit(true); state.select(row.id); activeCell.id = row.id; updateSelection(); });
                    handle.on('dragstart', function(event) {
                        if (search.getElement().value) { event.preventDefault(); return; }
                        finishEdit(true);
                        state.select(row.id); activeCell.id = row.id; updateSelection();
                        drag = { id: row.id, targetId: row.id, after: false, y: event.clientY };
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', row.id);
                        record.getElement().classList.add('gpo-collection-row--dragging');
                        scrollFrame = requestAnimationFrame(autoScroll);
                    });
                    handle.on('dragend', clearDrag);
                    handle.on('keydown', function(event) {
                        if (!busy() && !search.getElement().value && event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                            event.preventDefault(); event.stopPropagation(); finishEdit(true);
                            state.move(row.id, state.rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1));
                            render(); focusHandle(row.id);
                            announce(tr('moved', { index: state.rows.indexOf(row) }));
                        }
                    });
                    record.append(create('td', { className: 'gpo-collection-table__handle-cell', children: [handle] }));
                }
                if (state.mode === 'list') record.append(create('td', { className: 'gpo-collection-table__index', text: index }));
                fields.forEach(function(field) {
                    var cell = create('td', { className: ['gpo-collection-cell', 'field__element'], attrs: { 'data-collection-field': field, tabindex: '-1' } });
                    showCell(cell.getElement(), row, field);
                    cell.on('click', function() { selectCell(row.id, field); });
                    cell.on('dblclick', function(event) { event.preventDefault(); editCell(row.id, field); });
                    record.append(cell);
                });
                record.on('click', function(event) {
                    if (!event.target.closest('[data-collection-field], button, input, textarea')) selectCell(row.id, fields[0]);
                });
                body.append(record);
            });
            updateSelection(); updateValidation();
        }
        add.on('click', function() {
            if (readOnly || busy()) return;
            finishEdit(true);
            search.getElement().value = '';
            var id = state.add();
            activeCell = { id: id, field: fields[0] };
            render(); editCell(id, fields[0]); announce(tr('added'));
        });
        function removeSelected() {
            if (readOnly || busy() || !state.selectedId) return;
            finishEdit(true);
            var before = Array.from(body.getElement().querySelectorAll('[data-collection-row]')).map(function(row) { return row.getAttribute('data-collection-row'); });
            var removedId = state.selectedId;
            if (!state.removeSelected()) return;
            var after = state.visible(search.getElement().value).map(function(row) { return row.id; });
            var nextId = listNavigation.neighbor(before, [removedId], after);
            state.select(nextId); activeCell.id = nextId;
            render();
            if (nextId) focusCell(nextId, activeCell.field);
            else table.getElement().focus({ preventScroll: true });
            announce(tr('removed'));
        }
        remove.on('click', removeSelected);
        search.on('input', function() { finishEdit(true); state.select(null); render(); });
        table.on('focusin', function(event) {
            if (busy() || event.target.closest('input,select,textarea,button,a,[contenteditable]:not([contenteditable="false"])')) return;
            var cell = event.target.closest('[data-collection-field]');
            if (!cell) return;
            activeCell = { id: cell.parentElement.getAttribute('data-collection-row'), field: cell.getAttribute('data-collection-field') };
            state.select(activeCell.id); updateSelection();
        });
        content.on('keydown', function(event) {
            if (event.defaultPrevented || busy() || !table.getElement().contains(event.target)
                    || event.target.closest('input,select,textarea,button,a,summary,[contenteditable]:not([contenteditable="false"])')) return;
            if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearDrag(); return; }
            if (event.ctrlKey && !event.altKey && !event.metaKey && !readOnly && !search.getElement().value
                    && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && activeCell.id) {
                event.preventDefault(); event.stopPropagation(); finishEdit(true);
                state.select(activeCell.id);
                state.move(activeCell.id, state.rows.findIndex(function(row) { return row.id === activeCell.id; }) + (event.key === 'ArrowUp' ? -1 : 1));
                render(); focusCell(activeCell.id, activeCell.field);
                announce(tr('moved', { index: state.rows.findIndex(function(row) { return row.id === activeCell.id; }) }));
                return;
            }
            if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (event.key === 'Delete' && !readOnly) { event.preventDefault(); removeSelected(); return; }
            if ((event.key === 'Enter' || event.key === 'F2') && activeCell.id && !readOnly && !event.target.matches('button')) {
                event.preventDefault(); editCell(activeCell.id, activeCell.field); return;
            }
            var visible = state.visible(search.getElement().value);
            var index = visible.findIndex(function(row) { return row.id === activeCell.id; });
            if (index < 0) return;
            if (event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault(); selectCell(activeCell.id, activeCell.field);
            } else if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].indexOf(event.key) !== -1) {
                event.preventDefault();
                var position = index;
                var row = body.getElement().querySelector('[data-collection-row="' + activeCell.id + '"]');
                var pageSize = Math.max(1, Math.floor(scroll.getElement().clientHeight / Math.max(1, row.getBoundingClientRect().height)) - 1);
                if (event.key === 'Home') position = 0;
                else if (event.key === 'End') position = visible.length - 1;
                else position += (event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1) * (event.key === 'PageUp' || event.key === 'PageDown' ? pageSize : 1);
                var next = visible[Math.max(0, Math.min(visible.length - 1, position))];
                selectCell(next.id, activeCell.field);
            } else if (state.mode === 'key_value' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                event.preventDefault(); selectCell(activeCell.id, event.key === 'ArrowLeft' ? 'key' : 'value');
            }
        });
        scroll.on('dragover', function(event) {
            if (!drag) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'; drag.y = event.clientY;
            var target = event.target.closest('[data-collection-row]');
            Array.from(body.getElement().querySelectorAll('tr')).forEach(function(row) { row.classList.remove('gpo-collection-row--before', 'gpo-collection-row--after'); });
            if (!target) target = body.getElement().lastElementChild;
            if (!target || !target.hasAttribute('data-collection-row')) return;
            drag.targetId = target.getAttribute('data-collection-row');
            var rect = target.getBoundingClientRect();
            drag.after = event.clientY > rect.top + rect.height / 2;
            if (drag.targetId !== drag.id) target.classList.add(drag.after ? 'gpo-collection-row--after' : 'gpo-collection-row--before');
        });
        scroll.on('drop', function(event) {
            if (!drag) return;
            event.preventDefault(); event.stopPropagation();
            var from = state.rows.findIndex(function(row) { return row.id === drag.id; });
            var to = state.rows.findIndex(function(row) { return row.id === drag.targetId; }) + (drag.after ? 1 : 0);
            if (from < to) to -= 1;
            var id = drag.id;
            state.move(id, to);
            clearDrag(); render(); focusHandle(id);
            announce(tr('moved', { index: state.rows.findIndex(function(row) { return row.id === id; }) }));
        });
        content.append(create('span', { id: prefix + '-reorder-help', className: 'gpo-collection-editor__live', text: tr('reorderHelp') }));
        render();
        dialog = editorDialog.open(host, {
            title: options.parameter.label || options.parameter.id,
            className: ['gpo-collection-dialog'],
            content: content,
            readOnly: readOnly,
            cancelLabel: tr(readOnly ? 'close' : 'cancel'),
            isDirty: function() { return !readOnly && state.isDirty(pending()); },
            onApply: function() {
                finishEdit(true);
                var problems = updateValidation();
                if (problems.length) {
                    if (problems[0].id) focusCell(problems[0].id, problems[0].field);
                    else add.getElement().focus();
                    return false;
                }
                options.onAccept(state.read());
                return true;
            },
            onClose: function() { clearDrag(); editing = null; if (options.onClose) options.onClose(); }
        });
        updateValidation();
        dialog.isDirty = function() { return !readOnly && state.isDirty(pending()); };
        return dialog;
    }
    return { open: open };
});
