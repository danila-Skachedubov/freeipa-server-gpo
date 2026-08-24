define([
    './components/header/header',
    './components/main/main',
    './components/footer/footer',
    './util/resizable',
    './components/templates/default-template',
    './components/templates/admx-template',
    './components/templates/folder-template',
    './components/templates/preference/preferences-view-template',
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
    defaultTemplateModule,
    admxTemplateModule,
    folderTemplateModule,
    preferencesTemplateModule,
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
    var renderPreferencesTemplate = preferencesTemplateModule.renderPreferencesTemplate;
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

            setWorkspace: function(workspace) {
                this.workspace = workspace;
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

            setFolderOpened: function(item, opened) {
                if (!item || item.type !== 'folder') {
                    return Boolean(item && item.opened);
                }

                var listItemElement = this.treeListItemElements.get(item) || null;
                return setFolderOpenedState(listItemElement, item, opened);
            },

            toggleFolder: function(item) {
                if (!item || item.type !== 'folder' || !Array.isArray(item.children) || item.children.length === 0) {
                    return Boolean(item && item.opened);
                }

                return this.setFolderOpened(item, !item.opened);
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

            isHelpToggleAvailable: function() {
                return this.isFolderItemSelected() || this.isAdmxItemSelected();
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
                    ? workspaceEl.querySelectorAll('.gp__list-children-help, .gp__admx-help')
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

                var templateResult = null;
                var renderedWorkspaceView = null;

                if (item && item.type === 'folder') {
                    if (editorActions) editorActions.style.display = 'flex';
                    if (admxActions) admxActions.style.display = 'none';
                    if (helpSeparator) helpSeparator.style.display = 'none';
                    templateResult = renderFolderTemplate({
                        children: item.children || [],
                        help: item.help,
                        isHelpOpen: this.isHelpOpen,
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
                        templateResult = await renderAdmxTemplate({
                            isHelpOpen: this.isHelpOpen,
                            header: this.header,
                            item: item,
                            isCurrent: function() {
                                return renderRequestId === this.renderRequestId
                                    && this.selectedItem
                                    && this.selectedItem.item === item;
                            }.bind(this)
                        });
                    } else if (item.template === 'preferences') {
                        templateResult = await renderPreferencesTemplate({
                            header: this.header,
                            item: item,
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
                    this.setCurrentView(templateResult);
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

                    return ensureLazyChildren(item, listItemElement, this).then(function() {
                        if (config.navigationRequestId !== this.navigationRequestId) {
                            return false;
                        }
                        var nextConfig = Object.assign({}, config, { lazyLoadComplete: true });
                        if (nextConfig.openCurrentFolder === undefined) {
                            nextConfig.openCurrentFolder = true;
                        }
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
