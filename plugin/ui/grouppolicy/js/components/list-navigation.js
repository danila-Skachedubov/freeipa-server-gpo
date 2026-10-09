define([], function() {
    'use strict';
    var sequence = 0;

    // Anchor a bulk removal at its first original position, not at whichever
    // response happened to finish last. Only surviving, still-visible IDs count.
    function neighbor(beforeIds, removedIds, afterIds) {
        var removed = new Set(removedIds || []);
        var remaining = new Set(afterIds || []);
        var anchor = (beforeIds || []).findIndex(function(id) { return removed.has(id); });
        if (anchor < 0) return null;
        for (var previous = anchor - 1; previous >= 0; previous -= 1) {
            if (!removed.has(beforeIds[previous]) && remaining.has(beforeIds[previous])) return beforeIds[previous];
        }
        for (var next = anchor + 1; next < beforeIds.length; next += 1) {
            if (!removed.has(beforeIds[next]) && remaining.has(beforeIds[next])) return beforeIds[next];
        }
        return null;
    }

    function bind(container, options) {
        var disposed = false;
        var observer;
        var pointerSelecting = false;
        var owner = String(++sequence);
        container.setAttribute('data-list-navigation', owner);
        function rows() { return Array.from(options.rows() || []); }
        function selected() { return options.selected ? options.selected() : null; }
        function blocked() { return disposed || Boolean(options.busy && options.busy()); }
        function interactive(target) {
            return Boolean(target && target.closest && target.closest('input,select,textarea,button,a,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
        }
        function rowFor(target, current) {
            return current.find(function(row) { return row === target || row.contains(target); }) || null;
        }
        function sync() {
            if (disposed) return;
            var current = rows();
            var chosen = selected();
            var entry = current.indexOf(chosen) !== -1 ? chosen : current[0];
            container.tabIndex = current.length ? -1 : 0;
            current.forEach(function(row) {
                row.tabIndex = row === entry ? 0 : -1;
                row.setAttribute('aria-selected', String(options.isSelected ? Boolean(options.isSelected(row)) : row === chosen));
            });
        }
        function focus(row) {
            if (!row) { container.focus({ preventScroll: true }); return; }
            row.focus({ preventScroll: true });
            if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        function selectAndFocus(row, event, index) {
            if (!row) return;
            options.select(row, event);
            sync();
            var current = rows();
            var chosen = selected();
            focus(current.indexOf(chosen) !== -1 ? chosen : current[index] || null);
        }
        function focusSelected() {
            if (blocked()) return;
            var current = rows();
            var chosen = selected();
            if (current.indexOf(chosen) === -1) {
                if (current.length) { selectAndFocus(current[0], null, 0); return; }
                sync(); focus(null); return;
            }
            sync(); focus(chosen);
        }
        function pageSize(row) {
            var scroller = container;
            var view = container.ownerDocument && container.ownerDocument.defaultView;
            while (scroller.parentElement && view && view.getComputedStyle) {
                var style = view.getComputedStyle(scroller);
                if (/auto|scroll/.test(style.overflowY)) break;
                scroller = scroller.parentElement;
            }
            var height = row && row.getBoundingClientRect ? row.getBoundingClientRect().height : 0;
            return height && scroller.clientHeight ? Math.max(1, Math.floor(scroller.clientHeight / height) - 1) : 10;
        }
        function onKey(event) {
            if (event.defaultPrevented || blocked() || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || interactive(event.target)) return;
            var current = rows();
            if (!current.length) return;
            var row = rowFor(event.target, current) || selected() || current[0];
            var index = current.indexOf(row);
            if (index < 0) return;
            var next = index;
            if (event.key === 'ArrowUp') next -= 1;
            else if (event.key === 'ArrowDown') next += 1;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = current.length - 1;
            else if (event.key === 'PageUp') next -= pageSize(row);
            else if (event.key === 'PageDown') next += pageSize(row);
            else if (event.key === ' ' || event.key === 'Spacebar') next = index;
            else if (event.key === 'Enter' || event.key === 'F2') {
                if (!options.activate || options.canActivate && !options.canActivate(row)) return;
                event.preventDefault(); event.stopPropagation();
                if (selected() !== row) options.select(row, event);
                sync();
                options.activate(selected() || row, event);
                return;
            } else if (event.key === 'Delete') {
                if (!options.remove || options.canRemove && !options.canRemove(row)) return;
                event.preventDefault(); event.stopPropagation();
                if (selected() !== row) options.select(row, event);
                sync();
                options.remove(selected() || row, event);
                return;
            } else return;
            event.preventDefault(); event.stopPropagation();
            next = Math.max(0, Math.min(current.length - 1, next));
            selectAndFocus(current[next], event, next);
        }
        function onFocus(event) {
            // Pointer focus precedes the owner's click handler. Let that
            // handler decide toggle/range selection instead of selecting twice.
            if (pointerSelecting || blocked() || interactive(event.target)) return;
            var current = rows();
            var row = rowFor(event.target, current);
            if (row && row !== selected()) selectAndFocus(row, event, current.indexOf(row));
        }
        function onPointerDown() {
            pointerSelecting = true;
            var view = container.ownerDocument && container.ownerDocument.defaultView;
            if (view && view.setTimeout) view.setTimeout(function() { pointerSelecting = false; }, 0);
        }
        container.addEventListener('keydown', onKey);
        container.addEventListener('focusin', onFocus);
        container.addEventListener('pointerdown', onPointerDown);
        var view = container.ownerDocument && container.ownerDocument.defaultView;
        if (view && view.MutationObserver) {
            observer = new view.MutationObserver(sync);
            observer.observe(container, { childList: true, subtree: true });
        }
        sync();
        return {
            sync: sync,
            focusSelected: focusSelected,
            cleanup: function() {
                disposed = true;
                if (container.getAttribute('data-list-navigation') === owner) container.removeAttribute('data-list-navigation');
                container.removeEventListener('keydown', onKey);
                container.removeEventListener('focusin', onFocus);
                container.removeEventListener('pointerdown', onPointerDown);
                if (observer) observer.disconnect();
            }
        };
    }
    return { bind: bind, neighbor: neighbor };
});
