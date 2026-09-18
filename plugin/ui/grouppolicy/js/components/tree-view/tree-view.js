define(['../../util/element-creator', '../../locales/translations', './tree-view-list', './tree-view-list-data'], function(__dep0, __dep1, __dep2, __dep3) {
var { createElement } = __dep0;
var { t } = __dep1;
var { renderTreeViewList } = __dep2;
var { loadTreeViewList } = __dep3;


const TREE_VIEW_MESSAGES = {
    loading: 'treeView.loadingPolicies',
    error: 'treeView.unableToLoadPolicies',
};

function renderTreeViewStatus(type = 'loading') {
    const isError = type === 'error';
    const children = [];

    if (!isError) {
        children.push(createElement('span', {
            className: 'tree-view__status-spinner',
            attrs: {
                'aria-hidden': 'true',
            },
        }));
    }

    children.push(createElement('span', {
        className: 'tree-view__status-text',
        text: isError
            ? t(TREE_VIEW_MESSAGES.error)
            : t(TREE_VIEW_MESSAGES.loading),
    }));

    return createElement('div', {
        className: ['tree-view__status', isError ? 'tree-view__status--error' : 'tree-view__status--loading'],
        attrs: {
            role: isError ? 'alert' : 'status',
            'aria-live': isError ? 'assertive' : 'polite',
        },
        children,
    });
}

async function initializeTreeView(element, workspace = null, treeViewState = null) {
    if (workspace && treeViewState) {
        treeViewState.setWorkspace(workspace);
        treeViewState.setTreeData([]);
    }

    element.clear();
    element.append(renderTreeViewStatus('loading'));

    try {
        const treeData = await loadTreeViewList();

        element.clear();
        element.append(renderTreeViewList(treeData, workspace, treeViewState));
        treeViewState?.initializeSelection?.();
    } catch (error) {
        console.error('[tree-view] Failed to load data.', error);

        if (workspace) {
            workspace.clear();
        }

        if (treeViewState) {
            treeViewState.setTreeData([]);
            treeViewState.syncHelpButtonState?.();
            treeViewState.syncHelpBlockState?.();
        }

        element.clear();
        element.append(renderTreeViewStatus('error'));
    }
}

/**
 * Renders the tree container with content from tree-view-list.js.
 * @param {ElementCreator} workspace Workspace used to display the selected item.
 * @param {Object} treeViewState Tree state (selectedItem, workspace, setWorkspace, setSelectedItem).
 * @returns {ElementCreator} Tree container.
 */
function renderTreeView(workspace = null, treeViewState = null) {
    const element = createElement('div', {
        className: 'tree-view'
    });

    void initializeTreeView(element, workspace, treeViewState);

    return element;
}
    return { renderTreeView };
});
