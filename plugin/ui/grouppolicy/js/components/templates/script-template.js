define(['../../util/element-creator', '../../locales/translations'], function(__dep0, __dep1) {
var { createElement } = __dep0;
var { t } = __dep1;

var TAB_SCRIPT = 'script';
var TAB_POWERSHELL = 'powershell';


function st(key) {
    return t('systemSettings.' + key);
}

function modeLabelKey(mode) {
    return mode === 'startup' ? 'scriptsForStartup' : 'scriptsForShutdown';
}

function isDisabled(button) {
    return button.getElement().classList.contains('disabled');
}

function setDisabled(button, disabled) {
    button.getElement().classList.toggle('disabled', Boolean(disabled));
}

function createOrderSelect() {
    return createElement('select', {
        attrs: { name: 'running-scripts', disabled: 'disabled' },
        children: [
            createElement('option', {
                attrs: { value: 'value1', selected: 'selected' },
                text: st('psOrderNotConfigured')
            }),
            createElement('option', { attrs: { value: 'value2' }, text: '1' }),
            createElement('option', { attrs: { value: 'value3' }, text: '2' })
        ]
    });
}

function createScriptsTable(handlers) {
    var rows = [];
    var selectedIndex = null;

    var btnUp = createElement('div', {
        className: ['btn', 'btn-up'],
        text: st('up'),
        events: { click: function() { moveSelected(-1); } }
    });
    var btnDown = createElement('div', {
        className: ['btn', 'btn-down'],
        text: st('down'),
        events: { click: function() { moveSelected(1); } }
    });
    var btnAdd = createElement('div', {
        className: ['btn', 'btn-add'],
        text: st('add'),
        events: { click: function() { handlers.onAdd(); } }
    });
    var btnEdit = createElement('div', {
        className: ['btn', 'btn-edit'],
        text: st('edit'),
        events: { click: function() { if (!isDisabled(btnEdit)) handlers.onEdit(); } }
    });
    var btnRemove = createElement('div', {
        className: ['btn', 'btn-remove'],
        text: st('remove'),
        events: { click: function() { if (!isDisabled(btnRemove)) removeSelected(); } }
    });

    var tbody = createElement('tbody');

    var element = createElement('div', {
        className: 'script__windows',
        children: [
            createElement('div', {
                className: 'script__data',
                children: [
                    createElement('table', {
                        children: [
                            createElement('thead', {
                                children: [
                                    createElement('tr', {
                                        children: [
                                            createElement('th', { text: st('columnName') }),
                                            createElement('th', { text: st('columnArguments') })
                                        ]
                                    })
                                ]
                            }),
                            tbody
                        ]
                    })
                ]
            }),
            createElement('div', {
                className: 'script__controle',
                children: [
                    createElement('div', {
                        className: 'script__controle-top',
                        children: [btnUp, btnDown]
                    }),
                    createElement('div', {
                        className: 'script__controle-bottom',
                        children: [btnAdd, btnEdit, btnRemove]
                    })
                ]
            })
        ]
    });

    function getSelected() {
        return selectedIndex === null ? null : rows[selectedIndex];
    }

    function syncControls() {
        var hasSelection = selectedIndex !== null;
        setDisabled(btnUp, !hasSelection || rows.length < 2 || selectedIndex === 0);
        setDisabled(btnDown, !hasSelection || rows.length < 2 || selectedIndex === rows.length - 1);
        setDisabled(btnEdit, !hasSelection);
        setDisabled(btnRemove, !hasSelection);
    }

    function renderRows() {
        tbody.clear();
        rows.forEach(function(row, index) {
            tbody.append(createElement('tr', {
                className: index === selectedIndex ? 'selected' : null,
                events: { click: function() { selectRow(index); } },
                children: [
                    createElement('td', { text: row.name }),
                    createElement('td', { text: row.arguments })
                ]
            }));
        });
        syncControls();
    }

    function selectRow(index) {
        selectedIndex = index;
        renderRows();
    }

    function moveSelected(delta) {
        if (selectedIndex === null || isDisabled(delta < 0 ? btnUp : btnDown)) return;
        var target = selectedIndex + delta;
        if (target < 0 || target >= rows.length) return;
        var current = rows[selectedIndex];
        rows[selectedIndex] = rows[target];
        rows[target] = current;
        selectedIndex = target;
        renderRows();
    }

    function removeSelected() {
        if (selectedIndex === null) return;
        rows.splice(selectedIndex, 1);
        selectedIndex = null;
        renderRows();
    }

    function addRow(name, scriptArguments) {
        rows.push({ name: name, arguments: scriptArguments });
        selectedIndex = rows.length - 1;
        renderRows();
    }

    function replaceSelected(name, scriptArguments) {
        var selected = getSelected();
        if (!selected) return;
        selected.name = name;
        selected.arguments = scriptArguments;
        renderRows();
    }

    renderRows();

    return {
        element: element,
        getSelected: getSelected,
        addRow: addRow,
        replaceSelected: replaceSelected
    };
}

function createTabContent(tabKey, table) {
    var label = createElement('div', { className: 'field__label-global' });
    var pathLabel = createElement('div', {
        className: 'field__label-global',
        text: st('scriptsPathLabel')
    });
    var placeholders = [label, table.element, createElement('div', { className: 'field__line' })];

    if (tabKey === TAB_SCRIPT) {
        placeholders.push(pathLabel);
    }

    if (tabKey === TAB_POWERSHELL) {
        placeholders.push(createElement('div', {
            className: 'field__label-global',
            text: st('psOrderLabel')
        }));
        placeholders.push(createElement('div', {
            className: ['field', 'field__input'],
            children: [
                createElement('div', {
                    className: 'field__element',
                    children: [createOrderSelect()]
                })
            ]
        }));
        placeholders.push(createElement('div', { className: 'field__line' }));
        placeholders.push(createElement('div', {
            className: 'field__label-global',
            text: st('psRequirement')
        }));
        placeholders.push(pathLabel);
    }

    var content = createElement('div', {
        className: ['tab-content', tabKey === TAB_SCRIPT ? 'active' : null],
        children: placeholders
    });

    return { content: content, label: label };
}

function createScriptFormModal(kind, initial, onSubmit, host, onClose) {
    var isAdd = kind === 'add';
    var nameInput = createElement('input', { attrs: { type: 'text' } });
    var argumentsInput = createElement('input', { attrs: { type: 'text' } });
    var nameError = createElement('div', { className: 'field__error' });

    if (initial) {
        nameInput.getElement().value = initial.name || '';
        argumentsInput.getElement().value = initial.arguments || '';
    }

    nameInput.on('input', function() {
        nameError.setText('');
        nameInput.getElement().classList.remove('gpo-editor-field--error');
    });

    var modal = createElement('div', {
        className: isAdd ? 'scripts-add__modal' : 'scripts-edit__modal',
        children: [
            createElement('div', {
                className: 'scripts__modal-wrapper',
                children: [
                    createElement('div', {
                        className: 'scripts__modal-header',
                        children: [
                            createElement('div', {
                                className: 'title',
                                text: st(isAdd ? 'addTitle' : 'editTitle')
                            }),
                            createElement('div', {
                                className: 'close',
                                events: { click: function() { close(); } }
                            })
                        ]
                    }),
                    createElement('div', {
                        className: isAdd ? 'scripts-add__modal-content' : 'scripts-edit__modal-content',
                        children: [
                            createElement('div', {
                                className: ['field', 'field__input', 'field__input--path'],
                                children: [
                                    createElement('div', { className: 'field__label', text: st('nameLabel') }),
                                    createElement('div', {
                                        className: 'field__element',
                                        children: [nameInput]
                                    })
                                ]
                            }),
                            createElement('div', {
                                className: ['field', 'field__input', 'field__input--path'],
                                children: [
                                    createElement('div', { className: 'field__label', text: st('argumentsLabel') }),
                                    createElement('div', {
                                        className: 'field__element',
                                        children: [argumentsInput]
                                    })
                                ]
                            }),
                            nameError
                        ]
                    }),
                    createElement('div', {
                        className: 'scripts__modal-footer',
                        children: [
                            createElement('div', {
                                className: ['btn', 'btn-cancel'],
                                text: t('header.cancel'),
                                events: { click: function() { close(); } }
                            }),
                            createElement('div', {
                                className: ['btn', 'btn-ok'],
                                text: st('ok'),
                                events: { click: function() { submit(); } }
                            })
                        ]
                    })
                ]
            })
        ]
    });

    function close() {
        var element = modal.getElement();
        element.classList.remove('active');
        if (onClose) onClose();
        setTimeout(function() {
            if (element.parentNode) element.parentNode.removeChild(element);
        }, 500);
    }

    function submit() {
        var name = nameInput.getElement().value.trim();
        if (!name) {
            nameError.setText(st('nameRequired'));
            nameInput.getElement().classList.add('gpo-editor-field--error');
            return;
        }
        onSubmit(name, argumentsInput.getElement().value.trim());
        close();
    }

    return {
        element: modal,
        open: function() {
            host.append(modal);
            void modal.getElement().offsetHeight; // Force initial style calculation.
            modal.getElement().classList.add('active');
            nameInput.getElement().focus();
        }
    };
}

/**
 * Renders the static Scripts section with a script configuration dialog.
 * @param {Object} options Template options (`item` is the selected tree item).
 * @returns {ElementCreator} Template with startup and shutdown script buttons.
 */
function renderScriptsTemplate(options) {
    var config = options || {};
    var item = config.item || {};
    var state = { mode: 'startup', activeTab: TAB_SCRIPT };
    var tables = {};
    var tabButtons = {};
    var tabContents = {};
    var tabLabels = {};
    var scriptsModal = null;
    var scriptsOverlay = null;

    tables[TAB_SCRIPT] = createScriptsTable({
        onAdd: function() { openScriptFormModal('add'); },
        onEdit: function() { openScriptFormModal('edit'); }
    });
    tables[TAB_POWERSHELL] = createScriptsTable({
        onAdd: function() { openScriptFormModal('add'); },
        onEdit: function() { openScriptFormModal('edit'); }
    });

    function selectTab(tabKey) {
        state.activeTab = tabKey;
        [TAB_SCRIPT, TAB_POWERSHELL].forEach(function(key) {
            tabButtons[key].getElement().classList.toggle('active', key === tabKey);
            tabContents[key].getElement().classList.toggle('active', key === tabKey);
        });
    }

    function updateModeLabels() {
        var label = st(modeLabelKey(state.mode));
        [TAB_SCRIPT, TAB_POWERSHELL].forEach(function(key) {
            tabLabels[key].setText(label);
        });
    }

    function activeTable() {
        return tables[state.activeTab];
    }

    function openScriptFormModal(kind) {
        var table = activeTable();
        var initial = kind === 'edit' ? table.getSelected() : null;
        if (kind === 'edit' && !initial) return;

        var form = createScriptFormModal(kind, initial, function(name, scriptArguments) {
            if (kind === 'add') table.addRow(name, scriptArguments);
            else table.replaceSelected(name, scriptArguments);
        }, root, function() {
            scriptsModal.getElement().classList.remove('dimmed');
        });
        form.open();
        scriptsModal.getElement().classList.add('dimmed');
    }

    function openScriptsModal(mode) {
        state.mode = mode;
        updateModeLabels();
        selectTab(TAB_SCRIPT);
        scriptsModal.getElement().classList.add('active');
        scriptsOverlay.getElement().classList.add('active');
    }

    function closeScriptsModal() {
        scriptsModal.getElement().classList.remove('active');
        scriptsOverlay.getElement().classList.remove('active');
    }

    var tabContentScript = createTabContent(TAB_SCRIPT, tables[TAB_SCRIPT]);
    var tabContentPowershell = createTabContent(TAB_POWERSHELL, tables[TAB_POWERSHELL]);
    tabContents[TAB_SCRIPT] = tabContentScript.content;
    tabContents[TAB_POWERSHELL] = tabContentPowershell.content;
    tabLabels[TAB_SCRIPT] = tabContentScript.label;
    tabLabels[TAB_POWERSHELL] = tabContentPowershell.label;

    [TAB_SCRIPT, TAB_POWERSHELL].forEach(function(key) {
        tabButtons[key] = createElement('div', {
            className: ['scripts__tab-button', key === TAB_SCRIPT ? 'active' : null],
            attrs: { 'data-tab': 'tab-' + key },
            text: st(key === TAB_SCRIPT ? 'tabScript' : 'tabPowershell'),
            events: { click: function() { selectTab(key); } }
        });
    });

    scriptsModal = createElement('div', {
        className: 'scripts__modal',
        children: [
            createElement('div', {
                className: 'scripts__modal-wrapper',
                children: [
                    createElement('div', {
                        className: 'scripts__modal-header',
                        children: [
                            createElement('div', { className: 'title', text: st('dialogTitle') }),
                            createElement('div', {
                                className: 'close',
                                events: { click: closeScriptsModal }
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'scripts__modal-content',
                        children: [
                            createElement('div', {
                                className: 'scripts__modal-tabs',
                                children: [
                                    createElement('div', {
                                        className: 'tab-buttons',
                                        children: [tabButtons[TAB_SCRIPT], tabButtons[TAB_POWERSHELL]]
                                    }),
                                    tabContents[TAB_SCRIPT],
                                    tabContents[TAB_POWERSHELL]
                                ]
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'scripts__modal-footer',
                        children: [
                            createElement('div', {
                                className: ['btn', 'btn-apply'],
                                text: t('header.apply'),
                                events: { click: closeScriptsModal }
                            }),
                            createElement('div', {
                                className: ['btn', 'btn-cancel'],
                                text: t('header.cancel'),
                                events: { click: closeScriptsModal }
                            }),
                            createElement('div', {
                                className: ['btn', 'btn-ok'],
                                text: st('ok'),
                                events: { click: closeScriptsModal }
                            })
                        ]
                    })
                ]
            })
        ]
    });

    scriptsOverlay = createElement('div', {
        className: 'scripts__overlay',
        events: { click: closeScriptsModal }
    });

    var root = createElement('div', {
        className: 'gp__scripts',
        children: [
            createElement('div', {
                className: ['btn', 'btn-startup'],
                text: st('startupScript'),
                events: { click: function() { openScriptsModal('startup'); } }
            }),
            createElement('div', {
                className: ['btn', 'btn-shutdown'],
                text: st('shutdownScript'),
                events: { click: function() { openScriptsModal('shutdown'); } }
            }),
            scriptsOverlay,
            scriptsModal
        ]
    });

    root.cleanup = function() {
        closeScriptsModal();
    };

    return root;
}
    return { renderScriptsTemplate: renderScriptsTemplate };
});
