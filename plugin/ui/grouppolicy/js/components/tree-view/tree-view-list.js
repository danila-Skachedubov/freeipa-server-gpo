define(['../../util/element-creator', '../../locales/translations'], function(elementCreator, translations) {
    "use strict";

    var createElement = elementCreator.createElement;
    var expansionRuns = new WeakMap();
    var selectionScrollRuns = new WeakMap();

    function scrollTreeItemIntoView(element) {
        var pane = element && element.closest('.tree-view');
        if (!pane || !element.isConnected) return;
        var view = element.ownerDocument.defaultView;
        var run = {};
        selectionScrollRuns.set(pane, run);

        function reveal() {
            if (selectionScrollRuns.get(pane) !== run || !element.isConnected
                    || !element.classList.contains('active') || !element.getClientRects().length) return;
            var bounds = element.getBoundingClientRect();
            var viewport = pane.getBoundingClientRect();
            var top = viewport.top + pane.clientTop;
            var left = viewport.left + pane.clientLeft;
            var bottom = top + pane.clientHeight;
            var right = left + pane.clientWidth;
            if (!pane.clientHeight || !pane.clientWidth || !bounds.height) return;
            var inset = 4;
            if (bounds.top - inset < top) pane.scrollTop += bounds.top - inset - top;
            else if (bounds.bottom + inset > bottom) pane.scrollTop += bounds.bottom + inset - bottom;

            // A flex row fills its group. Reveal its actual label, not that
            // group's potentially much wider descendants. Long labels cannot
            // fit entirely; retain their icon and beginning without jumping.
            var title = element.querySelector('.tree-item__title') || element;
            var labelRight = title.getBoundingClientRect().right + inset;
            var rowLeft = bounds.left - inset;
            if (labelRight - rowLeft > pane.clientWidth) {
                labelRight = rowLeft + Math.min(80, pane.clientWidth);
            }
            if (rowLeft < left) pane.scrollLeft += rowLeft - left;
            else if (labelRight > right) pane.scrollLeft += labelRight - right;
        }

        view.requestAnimationFrame(function() {
            if (selectionScrollRuns.get(pane) !== run) return;
            reveal();
            var animations = [], fallbackDuration = 0;
            var ancestor = element.parentElement;
            while (ancestor && ancestor !== pane) {
                if (ancestor.classList.contains('is-expanding')) {
                    if (typeof ancestor.getAnimations === 'function') {
                        animations = animations.concat(ancestor.getAnimations().filter(function(animation) {
                            return animation.transitionProperty === 'grid-template-rows';
                        }));
                    } else fallbackDuration = Math.max(fallbackDuration, expansionDuration(ancestor));
                }
                ancestor = ancestor.parentElement;
            }
            if (animations.length) {
                Promise.all(animations.map(function(animation) {
                    return animation.finished.catch(function() {});
                })).then(function() { view.requestAnimationFrame(reveal); });
            } else if (fallbackDuration > 0) {
                view.setTimeout(function() { view.requestAnimationFrame(reveal); }, fallbackDuration + 50);
            }
        });
    }

    function finishExpansion(element, run) {
        if (expansionRuns.get(element) !== run) return;
        expansionRuns.delete(element);
        element.classList.remove('is-expanding');
    }

    function watchExpansion(element, run, duration) {
        var view = element.ownerDocument.defaultView;
        view.requestAnimationFrame(function() {
            if (expansionRuns.get(element) !== run) return;
            if (typeof element.getAnimations === 'function') {
                var animations = element.getAnimations().filter(function(animation) {
                    return animation.transitionProperty === 'grid-template-rows';
                });
                Promise.all(animations.map(function(animation) {
                    return animation.finished.catch(function() {});
                })).then(function() { finishExpansion(element, run); });
            } else {
                // Older browsers lack Web Animations. Bound clipping to the
                // computed transition duration, including its delay.
                view.setTimeout(function() { finishExpansion(element, run); }, duration + 50);
            }
        });
    }

    function expansionDuration(element) {
        var view = element.ownerDocument.defaultView;
        if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
        var style = view.getComputedStyle(element);
        function milliseconds(value) { return parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000) || 0; }
        var delays = style.transitionDelay.split(',').map(milliseconds);
        return Math.max.apply(null, style.transitionDuration.split(',').map(function(value, index) {
            return milliseconds(value) + delays[index % delays.length];
        }));
    }

    function visibleRows(root) {
        return Array.from(root.querySelectorAll('.tree-item')).filter(function(row) {
            var current = row.parentElement;
            while (current && current !== root) {
                if (current.matches('ul.tree-view__list') && current.style.display === 'none') return false;
                current = current.parentElement;
            }
            return true;
        });
    }

    function syncTreeTabStop(root, previousFocus) {
        if (!root) return;
        var rows = visibleRows(root), chosen = root.querySelector('.tree-item.active');
        while (chosen && rows.indexOf(chosen) === -1) {
            var group = chosen.parentElement.parentElement;
            var parent = group && group.closest('li.view');
            chosen = parent && parent.querySelector(':scope > .tree-item');
        }
        chosen = chosen || rows[0];
        root.tabIndex = rows.length ? -1 : 0;
        Array.from(root.querySelectorAll('.tree-item')).forEach(function(row) { row.tabIndex = row === chosen ? 0 : -1; });
        var focus = previousFocus || root.ownerDocument.activeElement;
        if (chosen && root.contains(focus) && !rows.some(function(row) { return row.contains(focus); })) {
            chosen.focus({ preventScroll: true });
        }
    }

    function syncSwitcher(switcher, item) {
        if (!switcher) return;
        var expandable = hasVisibleChildren(item);
        switcher.classList.toggle('icon-switcher--empty', !expandable);
        switcher.setAttribute('tabindex', '-1');
        switcher.setAttribute('aria-hidden', String(!expandable));
        switcher.setAttribute('aria-expanded', String(Boolean(item.opened)));
        switcher.setAttribute('aria-label', translations.t(item.opened ? 'tree.collapse' : 'tree.expand') + ': ' + item.title);
    }

    function hasVisibleChildren(item) {
        return Boolean(item && (item.lazy && !item.loaded || (item.children || []).some(function(child) { return child.showInTree !== false; })));
    }

    function setTreeItemActive(treeItemElement, container) {
        if (!treeItemElement) return null;
        (container || treeItemElement.closest('[role="tree"]') || document).querySelectorAll('.tree-item').forEach(function(current) {
            current.classList.toggle('active', current === treeItemElement);
            current.setAttribute('aria-selected', String(current === treeItemElement));
            current.tabIndex = current === treeItemElement ? 0 : -1;
        });
        syncTreeTabStop(treeItemElement.closest('[role="tree"]'));
        scrollTreeItemIntoView(treeItemElement);
        return treeItemElement;
    }

    function setFolderOpenedState(listItemElement, item, opened) {
        if (!item || item.type !== 'folder') return Boolean(item && item.opened);
        var shouldOpen = Boolean(opened);
        item.opened = shouldOpen;
        if (!listItemElement) return shouldOpen;
        var nested = listItemElement.querySelector(':scope > ul.tree-view__list');
        var changed = listItemElement.classList.contains(shouldOpen ? 'closed' : 'opened');
        var duration = shouldOpen && changed && listItemElement.isConnected && nested
            ? expansionDuration(listItemElement) : 0;
        // Lazy loading may replace children without changing expansion. Keep
        // any in-flight transition clipped until its original completion.
        var continuing = shouldOpen && !changed && expansionRuns.has(listItemElement);
        var run = continuing ? expansionRuns.get(listItemElement) : {};
        if (!continuing) {
            expansionRuns.set(listItemElement, run);
            listItemElement.classList.toggle('is-expanding', duration > 0);
        }
        if (duration > 0) {
            // Restore the group while the grid is still at zero. Flush that
            // starting layout so expansion really animates, with clipping
            // already in place before any child can be painted.
            nested.style.display = '';
            listItemElement.getBoundingClientRect();
        }
        listItemElement.classList.toggle('opened', shouldOpen);
        listItemElement.classList.toggle('closed', !shouldOpen);
        syncSwitcher(listItemElement.querySelector(':scope > .tree-item > .icon-switcher'), item);
        var treeItem = listItemElement.querySelector(':scope > .tree-item');
        if (treeItem && hasVisibleChildren(item)) treeItem.setAttribute('aria-expanded', String(shouldOpen));
        else if (treeItem) treeItem.removeAttribute('aria-expanded');
        var root = listItemElement.closest('[role="tree"]');
        // Hiding a focused descendant can make the browser blur it immediately.
        // Capture it before changing display so the visible ancestor gets focus.
        var previousFocus = root && root.ownerDocument.activeElement;
        if (nested) nested.style.display = shouldOpen ? '' : 'none';
        syncTreeTabStop(root, previousFocus);
        if (duration > 0) watchExpansion(listItemElement, run, duration);
        else if (!continuing) finishExpansion(listItemElement, run);
        return shouldOpen;
    }

    function renderTreeList(items, treeViewState, parentItem) {
        (items || []).forEach(function(item) {
            if (item.showInTree === false && treeViewState) treeViewState.registerTreeNode(item, { parentItem: parentItem || null });
        });
        return createElement('ul', {
            className: 'tree-view__list',
            attrs: { role: parentItem ? 'group' : 'tree',
                'aria-label': parentItem ? null : translations.t('navigation.tree'),
                title: parentItem ? null : translations.t('navigation.keyboardHelp') },
            children: (items || []).filter(function(item) { return item.showInTree !== false; }).map(function(item) {
                return renderTreeItem(item, treeViewState, parentItem || null);
            })
        });
    }

    function renderLoadError() {
        return createElement('li', {
            className: ['view', 'tree-view__lazy-error'],
            text: 'Не удалось загрузить раздел'
        });
    }

    function ensureLazyChildren(item, listItem, treeViewState) {
        if (!item || !item.lazy || item.loaded) return Promise.resolve(item && item.children || []);
        if (item.loadingPromise) return item.loadingPromise;

        listItem.classList.add('loading');
        item.loadingPromise = Promise.resolve().then(function() {
            return item.loadChildren();
        }).then(function(children) {
            item.children = Array.isArray(children) ? children : [];
            item.loaded = true;
            var switcher = listItem.querySelector(':scope > .tree-item > .icon-switcher');
            syncSwitcher(switcher, item);
            var oldNested = listItem.querySelector(':scope > ul.tree-view__list');
            if (oldNested) oldNested.remove();
            listItem.appendChild(renderTreeList(item.children, treeViewState, item).getElement());
            setFolderOpenedState(listItem, item, item.opened);
            return item.children;
        }).catch(function(error) {
            console.error('[tree-view] Failed to load children.', error);
            var oldNested = listItem.querySelector(':scope > ul.tree-view__list');
            if (oldNested) oldNested.remove();
            listItem.appendChild(createElement('ul', {
                className: 'tree-view__list',
                children: [renderLoadError()]
            }).getElement());
            setFolderOpenedState(listItem, item, item.opened);
            throw error;
        }).finally(function() {
            listItem.classList.remove('loading');
            item.loadingPromise = null;
        });
        return item.loadingPromise;
    }

    function renderTreeItem(item, treeViewState, parentItem) {
        var isFolder = item.type === 'folder';
        var classes = ['view', isFolder ? 'folder' : 'file'];
        if (isFolder) classes.push(item.opened ? 'opened' : 'closed');

        var treeItem = createElement('span', {
            className: 'tree-item',
            attrs: { role: 'treeitem', tabindex: parentItem ? '-1' : '0', 'aria-selected': 'false',
                'aria-label': item.title,
                'aria-expanded': isFolder && hasVisibleChildren(item) ? String(Boolean(item.opened)) : null },
            children: [
                isFolder ? createElement('span', {
                    className: ['icon-switcher', hasVisibleChildren(item) ? null : 'icon-switcher--empty'],
                    attrs: { role: 'button' }
                }) : null,
                isFolder ? createElement('span', {
                    className: 'tree-view__status-spinner',
                    attrs: { 'aria-hidden': 'true' }
                }) : null,
                item.icon ? createElement('span', { className: ['icon', item.icon] }) : null,
                createElement('span', { className: 'tree-item__title', text: item.title })
            ]
        });
        var listItem = createElement('li', { className: classes, children: [treeItem] });
        var listElement = listItem.getElement();
        var switcher = isFolder ? treeItem.getElement().querySelector('.icon-switcher') : null;
        syncSwitcher(switcher, item);

        function toggleExpansion() {
            if (!hasVisibleChildren(item)) return;
            if (treeViewState) treeViewState.toggleFolder(item);
            else setFolderOpenedState(listElement, item, !item.opened);
        }

        function selectFromKeyboard(element) {
            if (!element) return;
            if (!treeViewState) { setTreeItemActive(element); element.focus({ preventScroll: true }); return; }
            var target = element._gpoTreeItem;
            if (!target) return;
            var result = treeViewState.navigateToNode(target, { treeItemElement: element, openPath: true });
            Promise.resolve(result).then(function(selected) {
                if (selected === false || treeViewState.pendingNavigation || !element.isConnected) return;
                if (treeViewState.selectedItem && treeViewState.selectedItem.item === target) {
                    element.focus({ preventScroll: true });
                }
            });
        }
        treeItem.getElement()._gpoTreeItem = item;
        treeItem.on('keydown', function(event) {
            if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (event.target.closest('button, input, textarea, select, a, [contenteditable]')) return;
            var root = treeItem.getElement().closest('[role="tree"]');
            if (!root) return;
            var rows = visibleRows(root);
            var index = rows.indexOf(treeItem.getElement()), next = null;
            if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
            else if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)];
            else if (event.key === 'Home') next = rows[0];
            else if (event.key === 'End') next = rows[rows.length - 1];
            else if (event.key === 'ArrowRight') {
                if (isFolder && hasVisibleChildren(item)) {
                    if (!item.opened) toggleExpansion();
                    else next = listElement.querySelector(':scope > ul > li > .tree-item');
                }
            } else if (event.key === 'ArrowLeft') {
                if (isFolder && item.opened && hasVisibleChildren(item)) toggleExpansion();
                else next = listElement.parentElement && listElement.parentElement.closest('li.view')
                    && listElement.parentElement.closest('li.view').querySelector(':scope > .tree-item');
            } else if (event.key === 'Enter') {
                if (treeViewState && treeViewState.selectedItem && treeViewState.selectedItem.item === item && isFolder) toggleExpansion();
                else next = treeItem.getElement();
            } else if (event.key === ' ' || event.key === 'Spacebar') next = treeItem.getElement();
            else return;
            event.preventDefault(); event.stopPropagation();
            if (next) selectFromKeyboard(next);
        });

        if (switcher) switcher.addEventListener('keydown', function(event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            toggleExpansion();
        });

        if (treeViewState) {
            treeViewState.registerTreeNode(item, {
                treeItemElement: treeItem.getElement(),
                listItemElement: listElement,
                parentItem: parentItem || null
            });
        }

        if (isFolder && !item.lazy && hasVisibleChildren(item)) {
            listItem.append(renderTreeList(item.children, treeViewState, item));
            setFolderOpenedState(listElement, item, item.opened);
        }

        treeItem.on('click', function(event) {
            event.stopPropagation();
            var clicked = event.currentTarget;
            var clickedSwitcher = isFolder && event.target instanceof Element
                && event.target.closest('.icon-switcher');
            if (clickedSwitcher) {
                toggleExpansion();
                return;
            }
            if (!treeViewState) {
                setTreeItemActive(clicked);
                return;
            }

            if (isFolder && treeViewState.selectedItem && treeViewState.selectedItem.item === item) {
                toggleExpansion();
                clicked.focus({ preventScroll: true });
                return;
            }

            treeViewState.navigateToNode(item, {
                treeItemElement: clicked,
                openPath: true
            });
        });
        return listItem;
    }

    function renderTreeViewList(data, workspace, treeViewState) {
        var treeData = Array.isArray(data) ? data : [];
        if (workspace && treeViewState) {
            treeViewState.setWorkspace(workspace);
            treeViewState.setTreeData(treeData);
        }
        return renderTreeList(treeData, treeViewState, null);
    }

    return {
        setTreeItemActive: setTreeItemActive,
        setFolderOpenedState: setFolderOpenedState,
        renderTreeViewList: renderTreeViewList,
        ensureLazyChildren: ensureLazyChildren,
        hasVisibleChildren: hasVisibleChildren
    };
});
