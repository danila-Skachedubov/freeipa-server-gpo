define(['../../util/element-creator', '../../locales/translations', '../list-navigation'], function(__dep0, __dep1, listNavigation) {
var { createElement } = __dep0;
var { t } = __dep1;


function renderChildRow(item, onItemClick, onSelect) {
    const row = createElement('span', {
        className: 'workspace-list-item',
        attrs: typeof onItemClick === 'function'
            ? {
                role: 'button',
                tabindex: '-1',
            }
            : {},
        children: [
            createElement('span', { className: ['icon', item.icon] }),
            createElement('span', {
                className: 'gp__list-children__item__title',
                text: item.title,
            }),
        ],
    });

    if (typeof onItemClick === 'function') {
        row.on('click', () => {
            onSelect(item);
            if (item.type === 'folder') onItemClick(item);
        });
        row.on('dblclick', () => { if (item.type !== 'folder') { onSelect(item); onItemClick(item); } });
    }

    return createElement('li', {
        className: ['gp__list-children__item', item.type],
        children: [row],
    });
}

function renderHelpBlock({ help = undefined, isOpen = false } = {}) {
    if (!help) {
        return null;
    }

    return createElement('div', {
        className: ['gp__list-children-help', isOpen ? 'is-open' : null],
        children: [
            createElement('div', {
                className: 'title',
                text: t('common.help'),
            }),
            createElement('div', {
                className: 'content',
                text: help,
            }),
        ],
    });
}

function renderFolderTemplate({
    categoryPath = '',
    hideHeading = false,
    children = [],
    help = undefined,
    onItemClick = null,
    isHelpOpen = false,
    listState = {},
} = {}) {
    const folderChildren = Array.isArray(children)
        ? children
        : [];
    const helpBlock = renderHelpBlock({
        help,
        isOpen: isHelpOpen,
    });

    const list = createElement('ul', { className: 'gp__list-children__list' });
    let rowItems = new Map();
    let navigation = null;
    function select(item) {
        listState.selectedItem = item;
        rowItems.forEach((value, row) => { row.classList.toggle('active', value === item); });
        if (navigation) navigation.sync();
    }
    const search = createElement('input', { attrs: {
        type: 'search', value: listState.query || '',
        placeholder: t('policySearch.categoryPlaceholder'),
        'aria-label': t('policySearch.categoryPlaceholder'),
        'data-policy-filter': '',
    } });
    const empty = createElement('p', { text: t('policySearch.noMatches'), attrs: { role: 'status' } });
    function filter() {
        listState.query = search.getElement().value;
        const query = listState.query.trim().toLocaleLowerCase();
        const visible = folderChildren.filter(child => String(child.title || '').toLocaleLowerCase().includes(query));
        rowItems = new Map();
        list.getElement().replaceChildren(...visible.map(child => {
            const record = renderChildRow(child, onItemClick, select);
            const row = record.getElement().querySelector('.workspace-list-item');
            rowItems.set(row, child);
            row.classList.toggle('active', listState.selectedItem === child);
            return record.getElement();
        }));
        if (navigation) navigation.sync();
        empty.getElement().hidden = visible.length !== 0 || !query;
    }
    search.on('input', filter);
    search.on('keydown', event => {
        if (event.key === 'Escape') { search.getElement().value = ''; filter(); }
    });
    const content = createElement('div', {
        className: 'gp__list-children',
        children: [createElement('div', { className: 'gpo-security-workbench__toolbar', children: [
            !hideHeading && categoryPath ? createElement('h2', { text: categoryPath, attrs: { 'data-category-path': '', title: categoryPath } }) : null,
            search,
        ] }), list, empty],
    });
    const root = createElement('div', {
        className: 'gp__list-children-wrapper',
        children: [
            content,
            helpBlock,
        ],
    });
    filter();
    navigation = listNavigation.bind(list.getElement(), {
        rows: () => Array.from(rowItems.keys()),
        selected: () => Array.from(rowItems.keys()).find(row => rowItems.get(row) === listState.selectedItem) || null,
        select: row => select(rowItems.get(row)),
        activate: row => { if (onItemClick) onItemClick(rowItems.get(row)); },
        busy: () => Boolean(root.getElement().querySelector('[role="dialog"]'))
    });
    root.onMounted = () => { content.getElement().scrollTop = listState.scrollTop || 0; };
    root.cleanup = () => { listState.scrollTop = content.getElement().scrollTop; navigation.cleanup(); };
    return root;
}
    return { renderHelpBlock, renderFolderTemplate };
});
