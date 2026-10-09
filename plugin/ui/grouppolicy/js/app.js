define([
    './components/header/header',
    './components/main/main',
    './components/footer/footer',
    './util/resizable',
    './components/category-path',
    './components/templates/default-template',
    './components/templates/admx-template',
    './components/templates/folder-template',
    './components/templates/script-template',
    './components/templates/preference/preferences-view-template',
    './components/templates/security-template',
    './components/templates/advanced-audit-template',
    './components/templates/all-policies-template',
    './components/tree-view/tree-view-list',
    './util/element-creator',
    './components/editor-status',
    './locales/translations',
    './util/API'
], function(
    headerModule,
    mainModule,
    footerModule,
    resizableModule,
    categoryPathModule,
    defaultTemplateModule,
    admxTemplateModule,
    folderTemplateModule,
    scriptsTemplateModule,
    preferencesTemplateModule,
    securityTemplateModule,
    advancedAuditTemplateModule,
    allPoliciesTemplateModule,
    treeViewListModule,
    elementCreatorModule,
    editorStatusModule,
    translationsModule,
    APIModule
) {
    var renderHeader = headerModule.renderHeader;
    var renderMain = mainModule.renderMain;
    var renderFooter = footerModule.renderFooter;
    var resizable = resizableModule.resizable;
    var renderDefaultTemplate = defaultTemplateModule.renderDefaultTemplate;
    var renderAdmxTemplate = admxTemplateModule.renderAdmxTemplate;
    var renderFolderTemplate = folderTemplateModule.renderFolderTemplate;
    var renderHelpBlock = folderTemplateModule.renderHelpBlock;
    var renderScriptsTemplate = scriptsTemplateModule.renderScriptsTemplate;
    var renderPreferencesTemplate = preferencesTemplateModule.renderPreferencesTemplate;
    var renderSecurityTemplate = securityTemplateModule.renderSecurityTemplate;
    var renderAdvancedAuditTemplate = advancedAuditTemplateModule.renderAdvancedAuditTemplate;
    var renderAllPoliciesTemplate = allPoliciesTemplateModule.renderAllPoliciesTemplate;
    var setTreeItemActive = treeViewListModule.setTreeItemActive;
    var setFolderOpenedState = treeViewListModule.setFolderOpenedState;
    var ensureLazyChildren = treeViewListModule.ensureLazyChildren;
    var createElement = elementCreatorModule.createElement;
    var t = translationsModule.t;

    function createTreeViewState() {
        return {
            selectedItem: null,
            selectedPath: [],
            workspace: null,
            header: null,
            isHelpOpen: false,
            currentViewCleanup: null,
            renderRequestId: 0,
            navigationRequestId: 0,
            treeData: [],
            treeItemElements: new WeakMap(),
            treeListItemElements: new WeakMap(),
            parentItems: new WeakMap(),
            currentView: null,
            pendingNavigation: null,
            policyChangedModal: null,
            searchReturnButton: null,

            setWorkspace: function(workspace) {
                this.workspace = workspace;
                var node = workspace && workspace.getElement();
                if (!node) return;
                node.setAttribute('role', 'region');
                node.setAttribute('aria-label', t('navigation.catalog'));
                var container = node.closest('.gp__container');
                if (!container) return;
                if (container._gpoPaneNavigation) container.removeEventListener('keydown', container._gpoPaneNavigation);
                var state = this;
                container._gpoPaneNavigation = function(event) {
                    if (event.key !== 'F6' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
                    var target = event.target;
                    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
                    var ownerDialog = target.closest('[role="dialog"], [role="alertdialog"]');
                    if (ownerDialog && !ownerDialog.matches('.modal-gpui')) return;
                    if (Array.from(container.querySelectorAll('[role="dialog"], [role="alertdialog"], .policy-changed__modal')).some(function(modal) {
                        return modal.classList.contains('active') || modal.getClientRects().length
                            && modal.getBoundingClientRect().width > 0 && getComputedStyle(modal).opacity !== '0'
                            && getComputedStyle(modal).visibility !== 'hidden';
                    })) return;
                    var fromTree = Boolean(target.closest('.tree-view'));
                    var destination = fromTree
                        ? node.querySelector('[data-list-navigation] [tabindex="0"], [data-list-navigation][tabindex="0"]')
                            || node.querySelector('[data-policy-filter]') || node.querySelector('.gpo-category-path__segment[tabindex="0"]')
                        : container.querySelector('.tree-view .tree-item[tabindex="0"]');
                    if (destination && state.workspace === workspace) {
                        event.preventDefault(); destination.focus({ preventScroll: true });
                    }
                };
                container.addEventListener('keydown', container._gpoPaneNavigation);
            },

            setTreeData: function(treeData) {
                this.treeData = Array.isArray(treeData)
                    ? treeData
                    : [];
            },

            setHeader: function(header) {
                this.header = header;
            },

            initHelpControls: function() {
                var btnInformation = this.header && this.header.getElement && this.header.getElement()
                    ? this.header.getElement().querySelector('.gp__control-help .btn-information')
                    : null;

                if (!btnInformation) {
                    return;
                }

                btnInformation.addEventListener('click', this.toggleHelp.bind(this));
                this.syncHelpButtonState();
            },

            registerTreeNode: function(item, options) {
                var config = options || {};
                var treeItemElement = config.treeItemElement || null;
                var listItemElement = config.listItemElement || null;
                var parentItem = config.parentItem || null;

                if (!item) {
                    return;
                }

                if (treeItemElement instanceof Element) {
                    this.treeItemElements.set(item, treeItemElement);
                }

                if (listItemElement instanceof Element) {
                    this.treeListItemElements.set(item, listItemElement);
                }

                if (parentItem) {
                    this.parentItems.set(item, parentItem);
                    return;
                }

                this.parentItems.delete(item);
            },

            getPathToItem: function(item) {
                if (!item) {
                    return [];
                }

                var path = [];
                var currentItem = item;

                while (currentItem) {
                    path.unshift(currentItem);
                    currentItem = this.parentItems.get(currentItem) || null;
                }

                return path;
            },

            getCategoryHeading: function(item) {
                if (item && Array.isArray(item.categoryPath)) return item.categoryPath.join(' / ');
                var path = this.getPathToItem(item);
                return path.map(function(node) { return node.title || ''; }).filter(Boolean).join(' / ');
            },

            renderCategoryPath: function(item) {
                var path = this.getPathToItem(item);
                return categoryPathModule.render(path.map(function(node) {
                    return { title: node.title || '', item: node };
                }), function(node) {
                    this.navigateToNode(node, { openPath: true });
                }.bind(this));
            },

            updateCachedSecurityModels: function(model) {
                var updated = new Set();
                function visit(nodes) {
                    (nodes || []).forEach(function(node) {
                        var cached = node.securityModel;
                        if (cached && cached !== model && !updated.has(cached)) {
                            Object.keys(model).forEach(function(key) { cached[key] = model[key]; });
                            updated.add(cached);
                        }
                        if (node.children) visit(node.children);
                    });
                }
                visit(this.treeData);
            },

            updateCachedPolicySource: function(name, response) {
                function visit(nodes) {
                    (nodes || []).forEach(function(node) {
                        if (node.template === 'all_policies' && node.scope === 'computer') {
                            allPoliciesTemplateModule.updateCachedSource(node, name, response);
                        }
                        if (name === 'audit' && node.advancedAuditResponse) {
                            node.advancedAuditResponse = response;
                        }
                        if (node.children) visit(node.children);
                    });
                }
                visit(this.treeData);
            },

            setFolderOpened: function(item, opened) {
                if (!item || item.type !== 'folder') {
                    return Boolean(item && item.opened);
                }

                var listItemElement = this.treeListItemElements.get(item) || null;
                return setFolderOpenedState(listItemElement, item, opened);
            },

            toggleFolder: function(item) {
                if (!item || item.type !== 'folder' || !treeViewListModule.hasVisibleChildren(item)) {
                    return Boolean(item && item.opened);
                }
                var opened = this.setFolderOpened(item, !item.opened);
                if (opened && item.lazy && !item.loaded) {
                    var element = this.treeListItemElements.get(item);
                    if (element) return ensureLazyChildren(item, element, this).then(function() {
                        return item.opened;
                    }).catch(function() { return item.opened; });
                }
                return opened;
            },

            openPathToItem: function(item) {
                var path = this.getPathToItem(item);

                path.slice(0, -1).forEach(function(pathItem) {
                    if (pathItem && pathItem.type === 'folder') {
                        this.setFolderOpened(pathItem, true);
                    }
                }, this);

                return path;
            },

            activateTreeItem: function(item, treeItemElement) {
                var nextTreeItemElement = treeItemElement || this.treeItemElements.get(item) || null;

                if (!nextTreeItemElement && item && item.showInTree === false
                        && (item.template === 'admx' || item.searchReturnTo)) {
                    var parentItem = this.parentItems.get(item) || null;
                    while (parentItem && !nextTreeItemElement) {
                        nextTreeItemElement = this.treeItemElements.get(parentItem) || null;
                        parentItem = this.parentItems.get(parentItem) || null;
                    }
                }

                if (!nextTreeItemElement) {
                    return null;
                }

                var treeContainer = nextTreeItemElement.closest('.tree-view') || document;
                return setTreeItemActive(nextTreeItemElement, treeContainer);
            },

            cleanupCurrentView: function() {
                if (typeof this.currentViewCleanup === 'function') {
                    this.currentViewCleanup();
                }

                if (this.searchReturnButton) {
                    this.searchReturnButton.remove();
                    this.searchReturnButton = null;
                }

                this.currentViewCleanup = null;
            },

            setCurrentView: function(view) {
                this.currentViewCleanup = view && typeof view.cleanup === 'function'
                    ? view.cleanup
                    : null;
                this.currentView = view || null;
            },

            isFolderItemSelected: function() {
                return this.selectedItem && this.selectedItem.item && this.selectedItem.item.type === 'folder';
            },

            isAdmxItemSelected: function() {
                return this.selectedItem
                    && this.selectedItem.item
                    && this.selectedItem.item.type === 'file'
                    && this.selectedItem.item.template === 'admx';
            },

            isPreferencesItemSelected: function() {
                return this.selectedItem
                    && this.selectedItem.item
                    && this.selectedItem.item.type === 'file'
                    && this.selectedItem.item.template === 'preferences';
            },

            isHelpToggleAvailable: function() {
                return this.isFolderItemSelected() || this.isAdmxItemSelected()
                    || this.isPreferencesItemSelected();
            },

            getCurrentHelpSourceItem: function() {
                if (this.isFolderItemSelected()) {
                    return this.selectedItem && this.selectedItem.item
                        ? this.selectedItem.item
                        : null;
                }

                return this.selectedPath
                    .slice()
                    .reverse()
                    .find(function(pathItem) {
                        return pathItem && pathItem.type === 'folder';
                    }) || null;
            },

            buildViewWithPersistentHelp: function(view) {
                if (!this.isHelpOpen) {
                    return view;
                }

                var helpSourceItem = this.getCurrentHelpSourceItem();
                var helpBlock = renderHelpBlock({
                    help: helpSourceItem ? helpSourceItem.help : undefined,
                    isOpen: this.isHelpOpen
                });

                if (!helpBlock) {
                    return view;
                }

                return createElement('div', {
                    className: 'gp__list-children-wrapper',
                    children: [view, helpBlock]
                });
            },

            syncHelpButtonState: function() {
                var btnInformation = this.header && this.header.getElement && this.header.getElement()
                    ? this.header.getElement().querySelector('.gp__control-help .btn-information')
                    : null;

                if (!btnInformation) {
                    return;
                }

                btnInformation.classList.toggle('active', this.isHelpToggleAvailable());
            },

            syncHelpBlockState: function() {
                var workspaceEl = this.workspace && this.workspace.getElement
                    ? this.workspace.getElement()
                    : null;
                var helpBlocks = workspaceEl
                    ? workspaceEl.querySelectorAll('.gp__list-children-help, .gp__admx-help, .preference__info')
                    : null;

                if (!helpBlocks || helpBlocks.length === 0) {
                    return;
                }

                helpBlocks.forEach(function(helpBlock) {
                    helpBlock.classList.toggle('is-open', this.isHelpOpen);
                }, this);
            },

            setHelpOpen: function(opened) {
                this.isHelpOpen = Boolean(opened);
                this.syncHelpBlockState();
                return this.isHelpOpen;
            },

            toggleHelp: function() {
                if (!this.isHelpToggleAvailable()) {
                    return this.isHelpOpen;
                }

                return this.setHelpOpen(!this.isHelpOpen);
            },

            renderSelectedItem: async function(item, element) {
                var renderRequestId = ++this.renderRequestId;

                this.cleanupCurrentView();

                var headerElement = this.header && this.header.getElement ? this.header.getElement() : null;
                var preferenceControls = headerElement ? headerElement.querySelector('.gp__control') : null;
                var editorActions = headerElement ? headerElement.querySelector('.gp__control-actions') : null;
                if (preferenceControls) preferenceControls.style.display = 'none';
                if (editorActions) editorActions.style.display = 'none';
                var admxActions = headerElement ? headerElement.querySelector('.gp__control-admx') : null;
                var helpSeparator = headerElement ? headerElement.querySelector('.gp__control-separator') : null;
                if (admxActions) admxActions.style.display = '';
                if (helpSeparator) helpSeparator.style.display = '';

                if (this.workspace) {
                    this.workspace.clear();
                }

                this.setCurrentView(null);
                this.selectedPath = this.getPathToItem(item);
                this.selectedItem = { item: item, element: element };
                var categoryPath = this.getCategoryHeading(item);
                if (this.workspace) this.workspace.append(this.renderCategoryPath(item));

                var templateResult = null;
                var renderedWorkspaceView = null;

                if (item && item.template === 'all_policies') {
                    if (editorActions) editorActions.style.display = 'flex';
                    if (admxActions) admxActions.style.display = 'none';
                    if (helpSeparator) helpSeparator.style.display = 'none';
                    templateResult = renderAllPoliciesTemplate({
                        item: item,
                        header: this.header,
                        hideHeading: true,
                        onSecuritySaved: function(model, response) {
                            this.updateCachedSecurityModels(model);
                            this.updateCachedPolicySource('security', response);
                        }.bind(this),
                        onAuditSaved: this.updateCachedPolicySource.bind(this, 'audit'),
                        onNavigate: function(target) {
                            target.searchReturnTo = item;
                            this.registerTreeNode(target, { parentItem: item });
                            this.navigateToNode(target, { openPath: true });
                        }.bind(this),
                        isCurrent: function() {
                            return renderRequestId === this.renderRequestId
                                && this.selectedItem && this.selectedItem.item === item;
                        }.bind(this)
                    });
                    renderedWorkspaceView = templateResult;
                } else if (item && (item.template === 'security' || item.template === 'advanced_audit')) {
                    if (admxActions) admxActions.style.display = 'none';
                    if (helpSeparator) helpSeparator.style.display = 'none';
                    templateResult = await (item.template === 'security' ? renderSecurityTemplate : renderAdvancedAuditTemplate)({
                        item: item,
                        categoryPath: categoryPath,
                        header: this.header,
                        hideHeading: true,
                        onSaved: function(response) {
                            if (item.template === 'security') this.updateCachedSecurityModels(item.securityModel);
                            this.updateCachedPolicySource(item.template === 'security' ? 'security' : 'audit', response);
                        }.bind(this),
                        onNavigate: function(child) { this.navigateToNode(child, { openPath: true, openCurrentFolder: true }); }.bind(this),
                        isCurrent: function() { return renderRequestId === this.renderRequestId && this.selectedItem && this.selectedItem.item === item; }.bind(this)
                    });
                    renderedWorkspaceView = templateResult;
                } else if (item && item.type === 'folder') {
                    if (editorActions) editorActions.style.display = 'flex';
                    if (admxActions) admxActions.style.display = 'none';
                    if (helpSeparator) helpSeparator.style.display = 'none';
                    templateResult = renderFolderTemplate({
                        categoryPath: categoryPath,
                        hideHeading: true,
                        children: item.children || [],
                        help: item.help,
                        isHelpOpen: this.isHelpOpen,
                        listState: item.listState || (item.listState = {}),
                        onItemClick: function(childItem) {
                            this.navigateToNode(childItem, {
                                openPath: true,
                                openCurrentFolder: childItem && childItem.type === 'folder' ? true : undefined
                            });
                        }.bind(this)
                    });
                    renderedWorkspaceView = templateResult;
                } else if (item && item.type === 'file') {
                    if (item.template === 'admx') {
                        if (admxActions) admxActions.style.display = 'none';
                        if (helpSeparator) helpSeparator.style.display = 'none';
                        var parentCategory = this.parentItems.get(item);
                        var state = this;
                        var policyDialog = null, policyEditor = null;
                        templateResult = renderFolderTemplate({
                            hideHeading: true,
                            children: parentCategory && parentCategory.children || [item],
                            help: parentCategory && parentCategory.help,
                            isHelpOpen: this.isHelpOpen,
                            listState: parentCategory && (parentCategory.listState || (parentCategory.listState = {})),
                            onItemClick: function(child) { state.navigateToNode(child, { openPath: true }); }
                        });
                        var catalog = templateResult;
                        var cleanupCatalog = catalog.cleanup;
                        var mountCatalog = catalog.onMounted;
                        catalog.onMounted = function() {
                            if (mountCatalog) mountCatalog();
                            var opened = admxTemplateModule.openAdmxDialog(catalog, {
                                item: item,
                                isCurrent: function() { return renderRequestId === state.renderRequestId; },
                                restoreFocus: function() { return catalog.getElement().querySelector('.workspace-list-item.active, .workspace-list-item'); },
                                onClose: function() { policyDialog = null; policyEditor = null; }
                            });
                            if (opened) { policyDialog = opened.dialog; policyEditor = opened.editor; }
                        };
                        catalog.hasUnsavedChanges = function() {
                            return Boolean(policyEditor && policyEditor.hasUnsavedChanges());
                        };
                        catalog.applyChanges = async function() {
                            if (!policyEditor) return true;
                            var saved = await policyEditor.applyChanges();
                            if (saved && policyDialog) policyDialog.close();
                            return saved;
                        };
                        catalog.cancelChanges = function() { if (policyDialog) policyDialog.close(); return true; };
                        catalog.cleanup = function() {
                            if (policyEditor) policyEditor.cleanup();
                            if (policyDialog) policyDialog.close();
                            if (cleanupCatalog) cleanupCatalog();
                        };
                    } else if (item.template === 'preferences') {
                        templateResult = await renderPreferencesTemplate({
                            categoryPath: categoryPath,
                            header: this.header,
                            hideHeading: true,
                            item: item,
                            isHelpOpen: this.isHelpOpen,
                            isCurrent: function() {
                                return renderRequestId === this.renderRequestId
                                    && this.selectedItem
                                    && this.selectedItem.item === item;
                            }.bind(this)
                        });
                    } else if (item.template === 'scripts') {
                        if (admxActions) admxActions.style.display = 'none';
                        if (helpSeparator) helpSeparator.style.display = 'none';
                        templateResult = renderScriptsTemplate({
                            categoryPath: categoryPath,
                            item: item,
                            header: this.header,
                            hideHeading: true,
                            isCurrent: function() {
                                return renderRequestId === this.renderRequestId
                                    && this.selectedItem
                                    && this.selectedItem.item === item;
                            }.bind(this)
                        });
                    } else {
                        templateResult = renderDefaultTemplate();
                    }

                    renderedWorkspaceView = templateResult;
                }

                if (renderRequestId !== this.renderRequestId) {
                    if (templateResult && typeof templateResult.cleanup === 'function') {
                        templateResult.cleanup();
                    }
                    return;
                }

                if (this.workspace && renderedWorkspaceView) {
                    this.workspace.append(renderedWorkspaceView);
                    categoryPathModule.attachFilter(this.workspace.getElement().querySelector('.gpo-category-path'),
                        renderedWorkspaceView.getElement());
                    this.setCurrentView(templateResult);
                    if (typeof templateResult.onMounted === 'function') {
                        templateResult.onMounted();
                    }
                }

                if (item && item.searchReturnTo && editorActions) {
                    var back = createElement('button', {
                        className: ['button', 'active', 'gpo-policy-search__back'],
                        attrs: { type: 'button', 'data-policy-search-back': '' },
                        text: t('policySearch.back'),
                        events: { click: function() {
                            this.navigateToNode(item.searchReturnTo, {
                                openPath: true, openCurrentFolder: true
                            });
                        }.bind(this) }
                    });
                    editorActions.prepend(back.getElement());
                    editorActions.style.display = 'flex';
                    this.searchReturnButton = back.getElement();
                }

                this.syncHelpButtonState();
                this.syncHelpBlockState();
            },

            navigateToNode: function(item, options) {
                if (this.pendingNavigation) {
                    return false;
                }

                var config = Object.assign({}, options || {}, {
                    navigationRequestId: ++this.navigationRequestId
                });

                return this.guardNavigation(item, config);
            },

            guardNavigation: function(item, config) {
                if (!config || config.navigationRequestId !== this.navigationRequestId) {
                    return false;
                }

                var currentView = this.currentView;
                if (currentView && typeof currentView.hasUnsavedChanges === 'function' && currentView.hasUnsavedChanges()) {
                    this.pendingNavigation = { item: item, options: config };
                    this.showPolicyChangedModal();
                    return false;
                }

                return this.proceedWithNavigation(item, config);
            },

            proceedWithNavigation: function(item, config) {
                config = config || {};
                if (config.navigationRequestId !== this.navigationRequestId) {
                    return false;
                }
                var treeItemElement = config.treeItemElement || null;
                var openPath = config.openPath !== undefined ? config.openPath : true;
                var openCurrentFolder = config.openCurrentFolder;

                if (!item) {
                    return false;
                }

                if (item.type === 'folder' && item.lazy && !item.loaded && !config.lazyLoadComplete) {
                    var listItemElement = this.treeListItemElements.get(item) || null;
                    if (!listItemElement) {
                        return Promise.resolve(false);
                    }
                    if (openCurrentFolder !== undefined) this.setFolderOpened(item, openCurrentFolder);

                    return ensureLazyChildren(item, listItemElement, this).then(function() {
                        if (config.navigationRequestId !== this.navigationRequestId) {
                            return false;
                        }
                        var nextConfig = Object.assign({}, config, { lazyLoadComplete: true });
                        // Expansion may have changed while the request was pending.
                        delete nextConfig.openCurrentFolder;
                        return this.guardNavigation(item, nextConfig);
                    }.bind(this)).catch(function() {
                        return false;
                    });
                }

                if (openPath) {
                    this.openPathToItem(item);
                }

                if (item.type === 'folder' && openCurrentFolder !== undefined) {
                    this.setFolderOpened(item, openCurrentFolder);
                }

                var activeTreeItemElement = this.activateTreeItem(item, treeItemElement);
                return this.renderSelectedItem(item, activeTreeItemElement);
            },

            showPolicyChangedModal: function() {
                if (this.policyChangedModal) {
                    this.policyChangedModal.classList.add('active');
                }
            },

            hidePolicyChangedModal: function() {
                if (this.policyChangedModal) {
                    this.policyChangedModal.classList.remove('active');
                }
            },

            handlePolicyChangedYes: async function() {
                this.hidePolicyChangedModal();

                var currentView = this.currentView;
                if (currentView && typeof currentView.applyChanges === 'function') {
                    var success = await currentView.applyChanges();
                    if (!success) {
                        this.pendingNavigation = null;
                        return;
                    }
                }

                var nav = this.pendingNavigation;
                this.pendingNavigation = null;
                if (nav) {
                    return this.guardNavigation(nav.item, nav.options);
                }
                return false;
            },

            handlePolicyChangedNo: function() {
                this.hidePolicyChangedModal();

                var currentView = this.currentView;
                if (currentView && typeof currentView.cancelChanges === 'function') {
                    if (currentView.cancelChanges() === false) {
                        this.pendingNavigation = null;
                        return false;
                    }
                }

                var nav = this.pendingNavigation;
                this.pendingNavigation = null;
                if (nav) {
                    return this.guardNavigation(nav.item, nav.options);
                }
                return false;
            },

            initializeSelection: function() {
                if (this.selectedItem && this.selectedItem.item) {
                    return;
                }

                var firstRootItem = this.treeData[0] || null;

                if (!firstRootItem) {
                    return;
                }

                this.navigateToNode(firstRootItem, {
                    openPath: true,
                    openCurrentFolder: firstRootItem.type === 'folder' ? true : undefined
                });
            }
        };
    }

    function resolveContainer(options) {
        if (options && options.container instanceof Element) {
            return options.container;
        }

        var containerId = options && options.containerId ? options.containerId : 'gp__container';
        return document.getElementById(containerId);
    }

    function init(options) {
        var container = resolveContainer(options || {});

        if (!container) {
            return null;
        }

        container.innerHTML = '';

        var policyName = (options || {}).policyName;

        var browserLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
        translationsModule.setLanguage(browserLang);

        APIModule.initialize(policyName).then(function(openResult) {
            var treeViewState = createTreeViewState();
            var header = renderHeader(container);
            var headerElement = header.getElement();
            var initialPreferenceControls = headerElement.querySelector('.gp__control');
            var initialEditorActions = headerElement.querySelector('.gp__control-actions');
            if (initialPreferenceControls) initialPreferenceControls.style.display = 'none';
            if (initialEditorActions) initialEditorActions.style.display = 'none';
            treeViewState.setHeader(header);
            treeViewState.initHelpControls();

            function reconcilePending(event) {
                    var button = event.currentTarget;
                    button.disabled = true;
                    APIModule.reconcile().then(function(result) {
                        var recovery = result.recovery || result.result || result;
                        if (recovery && recovery.kind === 'conflict') {
                            throw new APIModule.EditorError('Publication reconciliation found a third state.', {
                                category: 'publication_conflict',
                                conflict: recovery.conflict
                            });
                        }
                        var notice = button.closest('.gpo-editor-status');
                        if (notice) notice.remove();
                    }).catch(function(error) {
                        var notice = button.closest('.gpo-editor-status');
                        if (notice) {
                            notice.replaceWith(editorStatusModule.renderError(error, {
                                onReconcile: reconcilePending
                            }).getElement());
                        }
                    }).finally(function() {
                        button.disabled = false;
                    });
            }
            var pendingNotice = editorStatusModule.renderPending(
                openResult && openResult.pending_publication,
                reconcilePending
            );
            if (pendingNotice) container.appendChild(pendingNotice.getElement());

            var renderedMain = renderMain(container, treeViewState);
            renderFooter(container);

            var policyChangedModal = createElement('div', {
                className: 'policy-changed__modal',
                children: [
                    createElement('div', {
                        className: 'policy-changed__modal-wrapper',
                        children: [
                            createElement('div', {
                                className: 'policy-changed__modal-header',
                                children: [
                                    createElement('div', {
                                        className: 'title',
                                        text: t('policyChangedModal.title')
                                    })
                                ]
                            }),
                            createElement('div', {
                                className: 'policy-changed__modal-content',
                                text: t('policyChangedModal.message')
                            }),
                            createElement('div', {
                                className: 'policy-changed__modal-footer',
                                children: [
                                    createElement('div', {
                                        className: ['btn', 'btn-no'],
                                        text: t('policyChangedModal.no')
                                    }),
                                    createElement('div', {
                                        className: ['btn', 'btn-yes'],
                                        text: t('policyChangedModal.yes')
                                    })
                                ]
                            })
                        ]
                    })
                ]
            });

            container.appendChild(policyChangedModal.getElement());
            treeViewState.policyChangedModal = policyChangedModal.getElement();

            var policyBtnNo = treeViewState.policyChangedModal.querySelector('.btn-no');
            var policyBtnYes = treeViewState.policyChangedModal.querySelector('.btn-yes');
            policyBtnNo.addEventListener('click', treeViewState.handlePolicyChangedNo.bind(treeViewState));
            policyBtnYes.addEventListener('click', treeViewState.handlePolicyChangedYes.bind(treeViewState));

            resizable(
                renderedMain.divider.getElement(),
                renderedMain.treeView.getElement(),
                renderedMain.main.getElement()
            );
        }).catch(function(error) {
            container.innerHTML = '';
            container.appendChild(editorStatusModule.renderError(error, {
                onRefresh: function() { init(options); }
            }).getElement());
        });

        return {
            container: container
        };
    }

    return {
        init: init,
        _test: {
            createTreeViewState: createTreeViewState
        }
    };
});
