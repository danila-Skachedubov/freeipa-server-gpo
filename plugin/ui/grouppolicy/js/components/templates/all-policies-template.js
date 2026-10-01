define([
    '../../util/element-creator', '../../util/API', '../../locales/translations',
    '../editor-status', './all-policies/model', './security/header-actions', './security-template', './security/model', './advanced-audit-template',
    './admx-template', './script-template', './preference/preferences-view-template', '../list-navigation'
], function(elements, API, translations, editorStatus, searchModel, headerActions, securityTemplate, securityModel, auditTemplate,
    admxTemplate, scriptTemplate, preferencesTemplate, listNavigation) {
    'use strict';

    var create = elements.createElement;
    var t = translations.t;
    var PAGE_SIZE = 100;

    function format(key, values) {
        var result = t('policySearch.' + key);
        Object.keys(values || {}).forEach(function(name) {
            result = result.replace('{' + name + '}', String(values[name]));
        });
        return result;
    }

    function checkedRows(name, response, scope) {
        if (name === 'admx') {
            if (!response || !Array.isArray(response.policies)) throw new Error(t('policySearch.invalidIndex'));
            return searchModel.admxRows(response, scope);
        }
        if (name === 'security') {
            if (!response || !response.security_catalog
                    || !Array.isArray(response.security_catalog.policies)
                    || !Array.isArray(response.security_catalog.categories)) {
                throw new Error(t('policySearch.invalidIndex'));
            }
            return searchModel.securityRows(response, scope);
        }
        if (name === 'audit') {
            if (!response || !response.advanced_audit
                    || !Array.isArray(response.advanced_audit.rows)
                    || !Array.isArray(response.advanced_audit.subcategory_catalog)) {
                throw new Error(t('policySearch.invalidIndex'));
            }
            return searchModel.auditRows(response, scope);
        }
        return [];
    }

    function updateCachedSource(item, name, response) {
        var sources = item.policySearchSources;
        if (!sources || !sources[name]) return;
        // Replace the source, so an older in-flight read cannot overwrite a save.
        sources[name] = { status: 'ready', response: response,
            rows: checkedRows(name, response, item.scope) };
    }

    function renderAllPoliciesTemplate(options) {
        var config = options || {};
        var item = config.item || {};
        var scope = item.scope === 'user' ? 'user' : 'computer';
        var state = item.policySearchState || (item.policySearchState = {
            query: '', page: 0, selected: null, scrollTop: 0
        });
        var sources = item.policySearchSources || (item.policySearchSources = {});
        var disposed = false;
        var activeDialog = null, activeEditor = null, opening = false;
        var root = create('div', {
            className: ['gp__preference', 'gpo-security-workbench', 'gpo-policy-search'],
            attrs: { 'data-all-policies-scope': scope }
        });
        var panel = create('div', { className: 'gpo-security-workbench__panel' });
        var toolbar = create('div', { className: 'gpo-security-workbench__toolbar' });
        var query = create('input', { attrs: {
            type: 'search', value: state.query || '', 'data-policy-filter': '',
            placeholder: t('policySearch.' + (scope === 'user' ? 'userPlaceholder' : 'computerPlaceholder')),
            'aria-label': t('policySearch.' + (scope === 'user' ? 'userPlaceholder' : 'computerPlaceholder'))
        } });
        var status = create('div', { className: 'gpo-policy-search__status', attrs: { role: 'status' } });
        var errors = create('div', { className: 'gpo-policy-search__errors' });
        var body = create('tbody');
        var table = create('table', {
            className: ['preference__table', 'gpo-catalog-table', 'gpo-security-table', 'gpo-policy-search__table'],
            children: [create('thead', { children: [create('tr', { children: [
                create('th', { text: t('policySearch.name') }),
                create('th', { text: t('policySearch.path') })
            ] })] }), body]
        });
        var previous = create('button', {
            className: 'button', attrs: { type: 'button', 'data-policy-page-previous': '' },
            text: t('policySearch.previous')
        });
        var next = create('button', {
            className: 'button', attrs: { type: 'button', 'data-policy-page-next': '' },
            text: t('policySearch.next')
        });
        var pageText = create('span', { attrs: { 'data-policy-page': '' } });
        var paging = create('div', { className: 'gpo-policy-search__paging', children: [
            previous, pageText, next
        ] });
        if (!config.hideHeading) toolbar.append(create('h2', { text: t('policies.allPolicies') }));
        toolbar.append(query);
        panel.append(toolbar); panel.append(errors); panel.append(status);
        panel.append(table); panel.append(paging); root.append(panel);

        var selection = null;
        var actions = headerActions.bind(config.header, toolbar, {
            edit: function() { if (selection) open(selection); }
        });
        function current() {
            return !disposed && (typeof config.isCurrent !== 'function' || config.isCurrent());
        }
        function syncActions() { actions.update(selection && { edit: true }, opening || Boolean(activeDialog)); }
        var navigation = listNavigation.bind(table.getElement(), {
            rows: function() { return Array.from(body.getElement().querySelectorAll('[data-policy-result-id]')); },
            selected: function() { return selection && selection.element; },
            select: function(row) { row.__select(); }, activate: function(row) { void open(row.__policyResult); },
            busy: function() { return !current() || opening || Boolean(activeDialog); }
        });
        async function open(row) {
            if (!current() || !row || opening || activeDialog) return;
            state.selected = row.id;
            state.scrollTop = panel.getElement().scrollTop;
            opening = true; syncActions();
            try {
                var kind = row.target.template;
                var audit = kind === 'advanced_audit', security = kind === 'security';
                var sourceName = audit ? 'audit' : kind;
                var modalModel = security ? securityModel.buildSecurityModel(sources.security.response) : null;
                var openDialog = audit ? auditTemplate.openAdvancedAuditDialog
                    : security ? securityTemplate.openSecurityDialog
                    : kind === 'admx' ? admxTemplate.openAdmxDialog
                    : kind === 'scripts' ? scriptTemplate.openScriptsDialog
                    : kind === 'preferences' ? preferencesTemplate.openPreferencesDialog : null;
                if (!openDialog) throw new Error(t('policySearch.targetUnavailable'));
                var opened = await openDialog(root, {
                    item: Object.assign({}, row.target, audit ? { advancedAuditResponse: sources.audit.response }
                        : security ? { securityModel: modalModel } : {}),
                    browseCollection: Boolean(row.target.securityCollection), isCurrent: current,
                    restoreFocus: function() { return selection && selection.element || query.getElement(); },
                    onSaved: function(response) {
                        var scrollTop = panel.getElement().scrollTop;
                        if (audit || security) {
                            sources[sourceName].response = response;
                            sources[sourceName].rows = checkedRows(sourceName, response, scope);
                        } else if (kind === 'admx') {
                            var savedPolicy = response.policy || response;
                            var indexed = sources.admx.response.policies.find(function(policy) { return policy.id === row.target.policyId; });
                            if (indexed && savedPolicy.label) indexed.label = savedPolicy.label;
                            sources.admx.rows = checkedRows('admx', sources.admx.response, scope);
                        }
                        showRows();
                        panel.getElement().scrollTop = scrollTop;
                        if (audit && config.onAuditSaved) config.onAuditSaved(response);
                        if (security && config.onSecuritySaved) config.onSecuritySaved(modalModel, response);
                    },
                    onClose: function() { activeDialog = null; activeEditor = null; syncActions(); }
                });
                if (opened && !current()) {
                    if (opened.editor.cleanup) opened.editor.cleanup();
                    opened.dialog.close();
                } else if (opened) { activeDialog = opened.dialog; activeEditor = opened.editor; }
            } catch (problem) {
                if (current()) { errors.getElement().replaceChildren(); errors.append(editorStatus.renderError(problem)); }
            } finally { opening = false; syncActions(); }
        }
        function showRows() {
            if (!current()) return;
            var heldFocus = table.getElement().contains(document.activeElement);
            var allRows = [];
            var incomplete = [], pending = [];
            ['admx', 'security', 'audit', 'scripts', 'preferences'].forEach(function(name) {
                var source = sources[name];
                if (!source) return;
                if (source.status === 'error') incomplete.push({ name: name, error: source.error });
                else if (source.status === 'loading') pending.push(name);
                else if (source.status === 'ready') allRows.push.apply(allRows, source.rows);
            });
            var rows = searchModel.sortRows(allRows).filter(function(row) {
                return searchModel.matches(row, state.query);
            });
            var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
            state.page = Math.max(0, Math.min(Number(state.page) || 0, pages - 1));
            body.getElement().replaceChildren();
            selection = null;
            rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).forEach(function(row) {
                var path = row.path.join(' / ');
                var node = create('tr', { attrs: {
                    tabindex: '-1', 'aria-selected': 'false',
                    'data-policy-result-id': row.id
                }, children: [
                    create('td', { attrs: { title: row.title }, children: [
                        create('span', { className: 'gpo-catalog-name', children: [
                            create('span', { className: ['icon', row.target.icon], attrs: { 'aria-hidden': 'true' } }),
                            create('span', { text: row.title })
                        ] })
                    ] }),
                    create('td', { text: path, attrs: { title: path } })
                ] });
                function select() {
                    if (selection && selection.element) {
                        selection.element.classList.remove('active');
                        selection.element.setAttribute('aria-selected', 'false');
                    }
                    selection = Object.assign({}, row, { element: node.getElement() });
                    state.selected = row.id;
                    node.getElement().classList.add('active');
                    node.getElement().setAttribute('aria-selected', 'true');
                    syncActions();
                    navigation.sync();
                }
                node.getElement().__select = select;
                node.getElement().__policyResult = row;
                node.on('click', function() { select(); navigation.focusSelected(); });
                node.on('dblclick', function() { if (!opening && !activeDialog) { select(); void open(row); } });
                body.append(node);
                if (state.selected === row.id) select();
            });
            syncActions();
            errors.getElement().replaceChildren();
            if (incomplete.length) {
                errors.append(create('p', {
                    className: 'gpo-security-workbench__notice',
                    text: t('policySearch.incomplete')
                }));
                incomplete.forEach(function(failure) {
                    errors.append(editorStatus.renderError(failure.error));
                });
                var retry = create('button', {
                    className: ['button', 'active'], attrs: { type: 'button', 'data-policy-retry': '' },
                    text: t('policySearch.retry')
                });
                retry.on('click', function() {
                    incomplete.forEach(function(failure) { delete sources[failure.name]; });
                    loadSources();
                });
                errors.append(retry);
            }
            status.getElement().textContent = pending.length
                ? t('policySearch.loading') + ' ' + format('count', { matched: rows.length, total: allRows.length })
                : format('count', { matched: rows.length, total: allRows.length });
            if (!rows.length && !pending.length && !incomplete.length) {
                body.append(create('tr', { children: [create('td', {
                    className: 'gpo-security-table__empty', attrs: { colspan: '2' },
                    text: t('policySearch.noMatches')
                })] }));
            }
            pageText.getElement().textContent = format('page', { page: state.page + 1, pages: pages });
            previous.getElement().disabled = state.page <= 0;
            next.getElement().disabled = state.page >= pages - 1;
            paging.getElement().hidden = pages <= 1;
            navigation.sync(); if (heldFocus) navigation.focusSelected();
        }
        function setStatic(name, rows) {
            sources[name] = { status: 'ready', rows: rows };
        }
        function fetch(name, request) {
            if (!sources[name]) {
                var source = { status: 'loading', rows: [], error: null };
                sources[name] = source;
                source.promise = Promise.resolve().then(request).then(function(response) {
                    source.rows = checkedRows(name, response, scope);
                    source.response = response;
                    source.status = 'ready';
                }).catch(function(error) {
                    source.error = error;
                    source.status = 'error';
                }).then(function() { if (current()) showRows(); });
            } else if (sources[name].status === 'loading') {
                sources[name].promise.then(function() { if (current()) showRows(); });
            }
        }
        function loadSources() {
            if (!sources.scripts) setStatic('scripts', searchModel.scriptRows(scope));
            if (!sources.preferences) setStatic('preferences', item.includePreferences
                ? searchModel.preferenceRows(item.preferenceDocuments, scope) : []);
            fetch('admx', function() { return API.policyIndex(scope); });
            if (scope === 'computer') {
                fetch('security', API.securityDefinitionsShow);
                fetch('audit', API.advancedAuditShow);
            }
            showRows();
        }
        query.on('input', function() {
            state.query = query.getElement().value;
            state.page = 0;
            state.selected = null;
            panel.getElement().scrollTop = 0;
            showRows();
        });
        query.on('keydown', function(event) {
            if (event.key === 'Escape') {
                query.getElement().value = '';
                query.getElement().dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        previous.on('click', function() {
            if (state.page > 0) { state.page--; panel.getElement().scrollTop = 0; showRows(); }
        });
        next.on('click', function() {
            state.page++; panel.getElement().scrollTop = 0; showRows();
        });
        root.onMounted = function() { panel.getElement().scrollTop = state.scrollTop || 0; };
        root.hasUnsavedChanges = function() { return Boolean(activeEditor && activeEditor.hasUnsavedChanges && activeEditor.hasUnsavedChanges()); };
        root.applyChanges = async function() {
            if (!activeEditor) return true;
            var saved = await activeEditor.applyChanges();
            if (saved && activeDialog) activeDialog.close();
            return saved;
        };
        root.cancelChanges = function() { if (activeDialog) activeDialog.close(); return true; };
        root.cleanup = function() {
            state.scrollTop = panel.getElement().scrollTop;
            disposed = true;
            navigation.cleanup();
            if (activeEditor && activeEditor.cleanup) activeEditor.cleanup();
            if (activeDialog) activeDialog.close();
            actions.cleanup();
        };
        loadSources();
        return root;
    }

    return { renderAllPoliciesTemplate: renderAllPoliciesTemplate, updateCachedSource: updateCachedSource };
});
