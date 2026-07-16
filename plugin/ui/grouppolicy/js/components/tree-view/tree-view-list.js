define(['../../util/element-creator'], function(elementCreator) {
    "use strict";

    var createElement = elementCreator.createElement;

    function setTreeItemActive(treeItemElement, container) {
        if (!treeItemElement) return null;
        (container || document).querySelectorAll('.tree-item.active').forEach(function(current) {
            if (current !== treeItemElement) current.classList.remove('active');
        });
        treeItemElement.classList.add('active');
        return treeItemElement;
    }

    function setFolderOpenedState(listItemElement, item, opened) {
        if (!item || item.type !== 'folder') return Boolean(item && item.opened);
        var shouldOpen = Boolean(opened);
        item.opened = shouldOpen;
        if (!listItemElement) return shouldOpen;
        listItemElement.classList.toggle('opened', shouldOpen);
        listItemElement.classList.toggle('closed', !shouldOpen);
        var nested = listItemElement.querySelector(':scope > ul.tree-view__list');
        if (nested) nested.style.display = shouldOpen ? '' : 'none';
        return shouldOpen;
    }

    function renderTreeList(items, treeViewState, parentItem) {
        return createElement('ul', {
            className: 'tree-view__list',
            children: (items || []).map(function(item) {
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
        if (!item || !item.lazy || item.loaded) return Promise.resolve(item.children || []);
        if (item.loadingPromise) return item.loadingPromise;

        listItem.classList.add('loading');
        item.loadingPromise = Promise.resolve().then(function() {
            return item.loadChildren();
        }).then(function(children) {
            item.children = Array.isArray(children) ? children : [];
            item.loaded = true;
            var oldNested = listItem.querySelector(':scope > ul.tree-view__list');
            if (oldNested) oldNested.remove();
            listItem.appendChild(renderTreeList(item.children, treeViewState, item).getElement());
            setFolderOpenedState(listItem, item, true);
            return item.children;
        }).catch(function(error) {
            console.error('[tree-view] Failed to load children.', error);
            var oldNested = listItem.querySelector(':scope > ul.tree-view__list');
            if (oldNested) oldNested.remove();
            listItem.appendChild(createElement('ul', {
                className: 'tree-view__list',
                children: [renderLoadError()]
            }).getElement());
            setFolderOpenedState(listItem, item, true);
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
            children: [
                isFolder ? createElement('span', { className: 'icon-switcher' }) : null,
                item.icon ? createElement('span', { className: ['icon', item.icon] }) : null,
                createElement('span', { className: 'tree-item__title', text: item.title })
            ]
        });
        var listItem = createElement('li', { className: classes, children: [treeItem] });
        var listElement = listItem.getElement();

        if (treeViewState) {
            treeViewState.registerTreeNode(item, {
                treeItemElement: treeItem.getElement(),
                listItemElement: listElement,
                parentItem: parentItem || null
            });
        }

        if (isFolder && !item.lazy && Array.isArray(item.children) && item.children.length) {
            listItem.append(renderTreeList(item.children, treeViewState, item));
            setFolderOpenedState(listElement, item, item.opened);
        }

        treeItem.on('click', function(event) {
            event.stopPropagation();
            var clicked = event.currentTarget;
            if (!treeViewState) {
                setTreeItemActive(clicked);
                return;
            }

            treeViewState.navigateToNode(item, {
                treeItemElement: clicked,
                openPath: true,
                openCurrentFolder: isFolder
                    ? (item.lazy && !item.loaded ? true : !item.opened)
                    : undefined
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
        ensureLazyChildren: ensureLazyChildren
    };
});
