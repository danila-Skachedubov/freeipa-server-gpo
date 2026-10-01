define([
    '../../util/element-creator', '../../util/API', '../../locales/translations',
    '../editor-status', '../confirmation-dialog', '../editor-dialog', '../list-navigation', '../editor-icons'
], function(elements, API, translations, editorStatus, confirmationDialog, editorDialog, listNavigation, editorIcons) {
    'use strict';

    var create = elements.createElement;
    var t = translations.t;
    var nextHeaderOwnerId = 1;
    var GROUPS = ['classic', 'powershell'];
    var EVENTS = { computer: ['startup', 'shutdown'], user: ['logon', 'logoff'] };
    function st(key) { return t('systemSettings.' + key); }
    function eventLabel(event) {
        return st({ startup: 'startupScripts', shutdown: 'shutdownScripts',
            logon: 'logonScript', logoff: 'logoffScript' }[event]);
    }
    function nameCell(label, icon) {
        return create('td', { children: [create('span', { className: 'gpo-catalog-name', children: [
            create('span', { className: ['icon', icon], attrs: { 'aria-hidden': 'true' } }),
            create('span', { text: label })
        ] })] });
    }
    function assetIcon(name) {
        return editorIcons.scriptFile(/\.ps(?:1|m1|d1)$/i.test(name) ? 'powershell' : 'classic');
    }
    function button(label, action, disabled, extraClass) {
        return create('button', {
            className: ['button', disabled ? null : 'active', extraClass],
            attrs: { type: 'button', disabled: disabled ? 'disabled' : null },
            text: label, events: { click: action }
        });
    }
    function fileBase64(file) {
        return new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function() { reject(reader.error || new Error('File reading failed.')); };
            reader.onload = function() {
                var value = String(reader.result || '');
                var comma = value.indexOf(',');
                if (comma < 0) reject(new Error('File reading failed.'));
                else resolve(value.slice(comma + 1));
            };
            reader.readAsDataURL(file);
        });
    }
    function saveDownloadedAsset(asset) {
        if (!asset || typeof asset.name !== 'string' || !asset.name
                || asset.name === '.' || asset.name === '..'
                || asset.name.trim() !== asset.name
                || /[\\/\u0000]/.test(asset.name)
                || typeof asset.content_base64 !== 'string'
                || !Number.isSafeInteger(asset.byte_size) || asset.byte_size < 0) {
            throw new Error(st('invalidDownload'));
        }
        var binary;
        try { binary = atob(asset.content_base64); }
        catch (_error) { throw new Error(st('invalidDownload')); }
        if (binary.length !== asset.byte_size) throw new Error(st('invalidDownload'));
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = asset.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function() { URL.revokeObjectURL(url); }, 0);
    }

    // All mutations are published individually; there is no unsaved local state.
    function renderScriptEventEditor(options) {
        var config = options || {};
        var scope = config.item && config.item.scope === 'user' ? 'user' : 'computer';
        var event = config.item && config.item.event;
        if (EVENTS[scope].indexOf(event) === -1) event = EVENTS[scope][0];
        var state = {
            event: event, group: 'classic', view: null, envelope: null,
            loading: false, busy: false, error: null,
            selectedEntry: { classic: null, powershell: null }, selectedAsset: null,
            selectedAssets: new Set(),
            requestId: 0, disposed: false, form: null, formState: null,
            picker: null, confirmation: null, orderDraft: null, saveStatus: null
        };
        var navigations = {}, pickerNavigation = null;
        state.assetFocus = null;
        state.removal = null;
        var root = create('div', { className: ['gp__scripts', 'gp__preference', 'gpo-editor-scripts'] });
        var rootElement = root.getElement();
        var headerElement = config.header && config.header.getElement
            ? config.header.getElement() : null;
        var headerControls = headerElement && headerElement.querySelector('.gp__control');
        var headerActions = headerElement && headerElement.querySelector('.gp__control-actions');
        var admxActions = headerElement && headerElement.querySelector('.gp__control-admx');
        var helpSeparator = headerElement && headerElement.querySelector('.gp__control-separator');
        var createButton = headerControls && headerControls.querySelector('.preferences__btn-create');
        var editButton = headerControls && headerControls.querySelector('.preferences__btn-edit');
        var deleteButton = headerControls && headerControls.querySelector('.preferences__btn-delete');
        var headerOwner = 'scripts-' + nextHeaderOwnerId++;
        var headerLabels = [createButton, editButton, deleteButton].map(function(control) {
            return control ? control.textContent : null;
        });
        var headerListeners = [];
        var modalDisabledStates = new WeakMap();
        if (headerControls) {
            headerControls.setAttribute('data-script-owner', headerOwner);
            headerControls.style.display = 'flex';
        }
        if (headerActions) {
            headerActions.setAttribute('data-script-owner', headerOwner);
            headerActions.style.display = 'flex';
        }
        if (admxActions) admxActions.style.display = 'none';
        if (helpSeparator) helpSeparator.style.display = 'none';
        [createButton, editButton, deleteButton].forEach(function(control, index) {
            if (control) control.textContent = st(['add', 'edit', 'remove'][index]);
        });
        var overlay = create('div', {
            className: 'scripts__overlay',
            events: { click: function() { requestCloseForm(); } }
        });
        var modalBody = create('div', { className: 'scripts__modal-content' });
        var uploadInput = create('input', {
            className: 'gpo-editor-scripts__file-input',
            attrs: { type: 'file', hidden: 'hidden', 'aria-label': st('upload') },
            style: { display: 'none' },
            events: { change: function(event) { void uploadChosen(event, false); } }
        });
        var replaceInput = create('input', {
            className: 'gpo-editor-scripts__file-input',
            attrs: { type: 'file', hidden: 'hidden', 'aria-label': st('replaceFile') },
            style: { display: 'none' },
            events: { change: function(event) { void uploadChosen(event, true); } }
        });
        if (!config.mode) root.append(create('h2', {
            className: 'gpo-editor-scripts__title', text: eventLabel(event)
        }));
        root.append(modalBody).append(overlay).append(uploadInput).append(replaceInput);

        function ownsHeader() {
            return Boolean(headerControls
                && headerControls.getAttribute('data-script-owner') === headerOwner);
        }
        function setHeaderState() {
            if (!ownsHeader()) return;
            var editable = Boolean(groupView().editable) && !state.busy && !state.loading
                && !state.form && !state.picker;
            [createButton, editButton, deleteButton].forEach(function(control, index) {
                if (!control) return;
                control.classList.toggle('active', editable && (index === 0 || Boolean(selectedEntry())));
            });
        }
        function listenHeader(control, handler) {
            if (!control) return;
            control.addEventListener('click', handler);
            headerListeners.push(function() { control.removeEventListener('click', handler); });
        }
        listenHeader(createButton, function() {
            if (ownsHeader() && createButton.classList.contains('active')) openForm('add');
        });
        listenHeader(editButton, function() {
            if (ownsHeader() && editButton.classList.contains('active')) openForm('edit');
        });
        listenHeader(deleteButton, function() {
            if (ownsHeader() && deleteButton.classList.contains('active')) removeEntry();
        });

        function current() {
            return !state.disposed
                && (typeof config.isCurrent !== 'function' || config.isCurrent());
        }
        function groupView() {
            return state.view && state.view[state.group] || { entries: [], editable: false };
        }
        function entries() { return groupView().entries || []; }
        function selectedEntry() {
            return entries().find(function(entry) {
                return entry.identity === state.selectedEntry[state.group];
            }) || null;
        }
        function assets() { return state.view && state.view.assets || []; }
        function selectedAsset() {
            return assets().find(function(asset) { return asset.name === state.selectedAsset; }) || null;
        }
        function setError(error) { state.error = error; renderBody(); }
        function applyResponse(response) {
            var previousOrder = state.view && state.view.execution_order;
            state.envelope = response;
            state.view = response && response.scripts || null;
            state.error = null;
            if (state.view && (state.orderDraft === null || state.orderDraft === previousOrder)) {
                state.orderDraft = state.view.execution_order || 'unspecified';
            }
            GROUPS.forEach(function(group) {
                var rows = state.view && state.view[group] && state.view[group].entries || [];
                if (state.removal && state.removal.group === group) {
                    state.selectedEntry[group] = listNavigation.neighbor(state.removal.before, state.removal.removed,
                        rows.map(function(entry) { return entry.identity; }));
                }
                if (!rows.some(function(entry) { return entry.identity === state.selectedEntry[group]; })) {
                    state.selectedEntry[group] = null;
                }
            });
            if (!assets().some(function(asset) { return asset.name === state.selectedAsset; })) {
                state.selectedAsset = null;
            }
            state.selectedAssets.forEach(function(name) {
                if (!assets().some(function(asset) { return asset.name === name; })) {
                    state.selectedAssets.delete(name);
                }
            });
            if (state.removal && state.removal.assets) {
                var surviving = assets().map(function(asset) { return asset.name; });
                var removed = state.removal.removed.filter(function(name) { return surviving.indexOf(name) === -1; });
                if (removed.length) {
                    var neighbor = listNavigation.neighbor(state.removal.before, removed, surviving);
                    state.selectedAssets = new Set(neighbor ? [neighbor] : []);
                    state.selectedAsset = neighbor; state.assetFocus = neighbor;
                }
            }
            if (!assets().some(function(asset) { return asset.name === state.assetFocus; })) state.assetFocus = state.selectedAsset;
            renderBody();
        }
        async function loadEvent() {
            var requestId = ++state.requestId;
            var event = state.event;
            state.loading = true;
            state.error = null;
            renderBody();
            try {
                var response = await API.scriptsShow(scope, event);
                if (!current() || requestId !== state.requestId || event !== state.event) return;
                state.loading = false;
                applyResponse(response);
            } catch (error) {
                if (!current() || requestId !== state.requestId) return;
                state.loading = false;
                setError(error);
            }
        }
        async function mutate(operation, errorSlot) {
            if (state.busy || !current()) return false;
            var focusedTable = document.activeElement && document.activeElement.closest('[data-script-list]');
            var returnList = focusedTable && rootElement.contains(focusedTable) ? focusedTable.getAttribute('data-script-list') : null;
            var returnGroup = state.group;
            state.busy = true;
            state.error = null;
            state.saveStatus = 'saving';
            syncModalBusy();
            renderBody();
            try {
                var response = await operation();
                if (!current()) return false;
                applyResponse(response);
                state.saveStatus = 'saved';
                if (typeof config.onSaved === 'function') config.onSaved(response);
                return true;
            } catch (error) {
                if (current()) {
                    state.saveStatus = null;
                    if (errorSlot && errorSlot.isConnected) {
                        errorSlot.textContent = '';
                        errorSlot.appendChild(editorStatus.renderError(error, {
                            onRefresh: function() { void loadEvent(); }
                        }).getElement());
                    } else setError(error);
                }
                return false;
            } finally {
                state.busy = false;
                state.removal = null;
                if (current()) { syncModalBusy(); renderBody(); }
                if (current() && returnList && returnGroup === state.group && !state.form && !state.picker
                        && document.activeElement === document.body && navigations[returnList]) navigations[returnList].focusSelected();
            }
        }
        function syncModalBusy() {
            [state.form, state.picker].forEach(function(modal) {
                if (!modal) return;
                modal.setAttribute('aria-busy', state.busy ? 'true' : 'false');
                Array.prototype.forEach.call(modal.querySelectorAll('input, select, button'), function(control) {
                    if (state.busy) {
                        if (!modalDisabledStates.has(control)) {
                            modalDisabledStates.set(control, {
                                disabled: control.disabled,
                                active: control.classList.contains('active')
                            });
                        }
                        control.disabled = true;
                        control.classList.remove('active');
                    } else if (modalDisabledStates.has(control)) {
                        var original = modalDisabledStates.get(control);
                        control.disabled = original.disabled;
                        control.classList.toggle('active', original.active);
                        modalDisabledStates.delete(control);
                    }
                });
            });
        }
        function closeConfirmation() {
            if (state.confirmation) {
                state.confirmation.close();
                state.confirmation = null;
            }
        }
        function confirm(message, onConfirm) {
            closeConfirmation();
            state.confirmation = confirmationDialog.open(rootElement, {
                message: message,
                onCancel: function() { state.confirmation = null; },
                onConfirm: function() { state.confirmation = null; onConfirm(); }
            });
        }
        function closePicker() {
            if (pickerNavigation) { pickerNavigation.cleanup(); pickerNavigation = null; }
            if (state.picker) { state.picker.remove(); state.picker = null; }
            if (state.pickerOverlay) {
                state.pickerOverlay.remove();
                state.pickerOverlay = null;
            }
            if (state.pickerFocus && state.pickerFocus.isConnected) state.pickerFocus.focus();
            state.pickerFocus = null;
            setHeaderState();
        }
        function closeForm(force) {
            if (state.busy && !force) return false;
            closePicker();
            if (state.form) { state.form.remove(); state.form = null; }
            state.formState = null;
            overlay.getElement().classList.remove('active');
            if (current()) {
                if (state.formFocus && state.formFocus.isConnected) state.formFocus.focus();
                else if (navigations.entries) navigations.entries.focusSelected();
            }
            state.formFocus = null;
            setHeaderState();
            return true;
        }
        function requestCloseForm() {
            if (state.busy || state.picker) return false;
            if (state.formState && state.formState.dirty()) {
                confirm(st('discardFormConfirm'), function() { closeForm(true); });
                return false;
            }
            return closeForm();
        }
        function openPicker(initialName, onSelect) {
            if (state.busy || state.picker) return;
            state.pickerFocus = document.activeElement;
            var chosen = assets().some(function(asset) { return asset.name === initialName; })
                ? initialName : null;
            var pickerOverlay = create('div', {
                className: ['scripts__overlay', 'active', 'gpo-editor-scripts__picker-overlay'],
                events: { click: closePicker }
            });
            var selectButton = button(st('selectFile'), function() { choose(); }, !chosen, 'btn-ok');
            selectButton.addClass('gpo-editor-scripts__picker-select');
            var rows = assets().map(function(asset) {
                var row = create('tr', {
                    className: asset.name === chosen ? 'active' : null,
                    attrs: { tabindex: '-1', 'data-script-asset': asset.name },
                    children: [nameCell(asset.name, assetIcon(asset.name)),
                        create('td', { text: String(asset.byte_size) + ' ' + st('bytes') })]
                });
                function select() {
                    chosen = asset.name;
                    Array.prototype.forEach.call(table.getElement().querySelectorAll('tbody tr'), function(candidate) {
                        candidate.classList.toggle('active', candidate === row.getElement());
                    });
                    selectButton.getElement().disabled = false;
                    selectButton.addClass('active');
                    if (pickerNavigation) pickerNavigation.sync();
                }
                row.getElement().__select = select;
                row.on('click', function() { select(); if (pickerNavigation) pickerNavigation.focusSelected(); });
                row.on('dblclick', function() { select(); choose(); });
                return row;
            });
            var table = create('table', {
                className: ['preference__table', 'gpo-catalog-table'],
                children: [create('thead', { children: [create('tr', { children: [
                    create('th', { text: st('columnName') }),
                    create('th', { text: st('columnSize') })
                ] })] }), create('tbody', { children: rows })]
            });
            function choose() {
                if (!chosen || state.busy) return;
                closePicker();
                onSelect(chosen);
            }
            var picker = create('div', {
                className: ['preference__modal', 'active', 'gpo-editor-scripts__picker'],
                attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': st('browseFiles') },
                events: { keydown: function(event) {
                    if (event.defaultPrevented || event.target.closest('[role="dialog"], [role="alertdialog"]') !== picker.getElement()) return;
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); }
                    editorDialog.trapTab(event, picker.getElement());
                } },
                children: [create('div', {
                    className: 'preference__modal-wrapper',
                    children: [create('div', {
                        className: 'preference__modal-header',
                        children: [create('div', { className: 'title', text: st('browseFiles') }),
                            create('button', { className: 'close', attrs: { type: 'button',
                                'aria-label': st('close') }, events: { click: closePicker } })]
                    }), create('div', {
                        className: 'preference__modal-content',
                        children: [assets().length ? table : create('div', {
                            className: 'gpo-editor-empty', text: st('emptyAssets')
                        })]
                    }), create('div', {
                        className: 'preference__modal-footer',
                        children: [button(t('header.cancel'), closePicker, false, 'btn-cancel'),
                            selectButton]
                    })]
                })]
            });
            rootElement.appendChild(pickerOverlay.getElement());
            rootElement.appendChild(picker.getElement());
            state.pickerOverlay = pickerOverlay.getElement();
            state.picker = picker.getElement();
            pickerNavigation = listNavigation.bind(table.getElement(), {
                rows: function() { return Array.from(table.getElement().querySelectorAll('[data-script-asset]')); },
                selected: function() { return Array.from(table.getElement().querySelectorAll('[data-script-asset]')).find(function(row) { return row.getAttribute('data-script-asset') === chosen; }) || null; },
                select: function(row) { row.__select(); }, activate: choose,
                busy: function() { return state.busy || !current(); }
            });
            setHeaderState();
            if (chosen && rows.length) rows.find(function(row) {
                return row.getElement().classList.contains('active');
            }).getElement().focus();
            else picker.getElement().querySelector('.btn-cancel').focus();
        }
        function openForm(kind) {
            if (state.busy || state.loading || !groupView().editable) return;
            var entry = kind === 'edit' ? selectedEntry() : null;
            if (kind === 'edit' && !entry) return;
            if (kind === 'select' && !selectedAsset()) return;
            closeForm();
            state.formFocus = document.activeElement;
            var isEdit = kind === 'edit';
            var modern = Boolean(config.mode);
            var sourceSelect = create('select', { children: [
                create('option', { attrs: { value: 'existing_asset' }, text: st('existingAsset') }),
                create('option', { attrs: { value: 'external_command' }, text: st('externalCommand') })
            ] });
            sourceSelect.getElement().value = entry
                ? (entry.managed_asset_name ? 'existing_asset' : 'external_command')
                : (kind === 'select' || assets().length ? 'existing_asset' : 'external_command');
            var assetInput = create('input', { attrs: {
                type: 'text', readonly: 'readonly', value: entry && entry.managed_asset_name
                    || (kind === 'select' && selectedAsset() && selectedAsset().name) || ''
            } });
            var browseButton = button(config.mode ? '…' : st('browseFiles'), function() {
                var input = modern ? commandInput : assetInput;
                openPicker(input.getElement().value, function(name) {
                    input.getElement().value = name;
                    markDirty();
                    browseButton.getElement().focus();
                });
            }, false, config.mode ? 'gpo-editor-scripts__ellipsis' : 'gpo-editor-scripts__browse');
            if (config.mode) {
                browseButton.getElement().setAttribute('aria-label', st('selectFromSysvol'));
                browseButton.getElement().title = st('selectFromSysvol');
            }
            var commandInput = create('input', {
                attrs: { type: 'text', value: entry ? entry.command_line : '',
                    placeholder: modern ? st('externalCommand') : null }
            });
            var parametersInput = create('input', {
                attrs: { type: 'text', value: entry ? entry.parameters : '' }
            });
            var assetRow = field(st('nameLabel'), create('div', {
                className: 'gpo-editor-scripts__asset-field',
                children: [modern ? commandInput : assetInput, browseButton]
            }));
            var commandRow = modern ? null : field(st('nameLabel'), commandInput);
            var formError = create('div', { className: 'gpo-editor-scripts__form-error' });
            function values() {
                if (modern) return [commandInput.getElement().value, parametersInput.getElement().value];
                return [sourceSelect.getElement().value, assetInput.getElement().value,
                    commandInput.getElement().value, parametersInput.getElement().value];
            }
            var initialValues = JSON.stringify(values());
            function markDirty() { setHeaderState(); }
            function syncSource() {
                if (modern) return;
                var existing = sourceSelect.getElement().value === 'existing_asset';
                assetRow.getElement().hidden = !existing;
                commandRow.getElement().hidden = existing;
                markDirty();
            }
            sourceSelect.on('change', syncSource);
            commandInput.on('input', markDirty);
            parametersInput.on('input', markDirty);
            var form = create('div', {
                className: ['preference__modal', 'active', 'gpo-editor-scripts__form'],
                attrs: { role: 'dialog', 'aria-modal': 'true' },
                events: { keydown: function(event) {
                    if (event.defaultPrevented || event.target.closest('[role="dialog"], [role="alertdialog"]') !== form.getElement()) return;
                    if (event.key === 'Escape') {
                        event.preventDefault(); event.stopPropagation(); requestCloseForm();
                    }
                    editorDialog.trapTab(event, form.getElement());
                } },
                children: [create('div', {
                    className: 'preference__modal-wrapper',
                    children: [
                        create('div', {
                            className: 'preference__modal-header',
                            children: [create('div', {
                                className: 'title', text: st(isEdit ? 'editTitle' : 'addTitle')
                            }), create('button', { className: 'close', attrs: {
                                type: 'button', 'aria-label': st('close')
                            }, events: { click: requestCloseForm } })]
                        }),
                        create('div', {
                            className: 'preference__modal-content',
                            children: modern
                                ? [assetRow, field(st('argumentsLabel'), parametersInput), formError]
                                : [field(st('sourceLabel'), sourceSelect), assetRow,
                                    commandRow, field(st('argumentsLabel'), parametersInput), formError]
                        }),
                        create('div', {
                            className: 'preference__modal-footer',
                            children: [button(t('header.cancel'), requestCloseForm, false, 'btn-cancel'),
                                button(t('header.apply'), function() { void submit(); }, false, 'btn-ok')]
                        })
                    ]
                })]
            });
            async function submit() {
                if (state.busy) return false;
                formError.setText('');
                var command = modern ? commandInput.getElement().value.trim()
                    : sourceSelect.getElement().value === 'existing_asset'
                        ? assetInput.getElement().value : commandInput.getElement().value.trim();
                var matchedAsset = modern && assets().find(function(asset) {
                    return asset.name.toLowerCase() === command.toLowerCase();
                });
                var source = modern ? matchedAsset ? 'existing_asset' : 'external_command'
                    : sourceSelect.getElement().value;
                var name = modern && matchedAsset ? matchedAsset.name : assetInput.getElement().value;
                if (!modern && source === 'existing_asset'
                        && !assets().some(function(asset) { return asset.name === name; })) {
                    formError.setText(st('chooseFile'));
                    return false;
                }
                if (!command) {
                    formError.setText(st('chooseCommand'));
                    return false;
                }
                var parameters = parametersInput.getElement().value.trim();
                var group = state.group;
                var event = state.event;
                var snapshot = groupView().snapshot;
                var ok = await mutate(function() {
                    if (isEdit) return API.scriptEntryUpdate(scope, event, {
                        executable_group: group, identity: entry.identity,
                        command_line: command, parameters: parameters
                    });
                    var request = {
                        mode: source, executable_group: group, snapshot: snapshot,
                        parameters: parameters
                    };
                    if (source === 'existing_asset') request.name = name;
                    else request.command_line = command;
                    return API.scriptEntryAdd(scope, event, request);
                }, formError.getElement());
                if (ok) closeForm(true);
                return ok;
            }
            rootElement.appendChild(form.getElement());
            state.form = form.getElement();
            state.formState = { dirty: function() { return JSON.stringify(values()) !== initialValues; },
                submit: submit };
            overlay.getElement().classList.add('active');
            syncSource();
            setHeaderState();
            (modern ? commandInput : sourceSelect).getElement().focus();
        }
        function field(label, input) {
            return create('div', {
                className: 'gpo-editor-field',
                children: [create('div', { className: 'gpo-editor-field__label', text: label }), input]
            });
        }
        function removeEntry() {
            var entry = selectedEntry();
            if (!entry || !groupView().editable || state.busy) return;
            var group = state.group;
            var event = state.event;
            confirm(st('removeEntryConfirm'), function() {
                state.removal = { group: group, before: entries().map(function(row) { return row.identity; }), removed: [entry.identity] };
                void mutate(function() {
                    return API.scriptEntryRemove(scope, event, {
                        executable_group: group, identity: entry.identity
                    });
                });
            });
        }
        function moveEntry(delta) {
            var group = state.group;
            var rows = entries();
            var index = rows.findIndex(function(entry) {
                return entry.identity === state.selectedEntry[group];
            });
            var target = index + delta;
            if (!groupView().editable || state.busy || index < 0 || target < 0 || target >= rows.length) return;
            var order = rows.map(function(entry) { return entry.identity; });
            var moved = order[index]; order[index] = order[target]; order[target] = moved;
            var snapshot = groupView().snapshot;
            void mutate(function() {
                return API.scriptEntriesReorder(scope, state.event, {
                    executable_group: group, snapshot: snapshot, identities: order
                });
            });
        }
        async function uploadChosen(event, replace) {
            var file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file || state.busy || !state.view) return;
            var asset = replace ? selectedAsset() : null;
            if (replace && !asset) return;
            if (file.size > state.view.upload_limit_bytes) {
                setError({ category: 'size_limit', message: st('uploadTooLarge') });
                return;
            }
            async function upload() {
                try {
                    var content = await fileBase64(file);
                    if (!current() || !state.event) return;
                    await mutate(function() {
                        return replace
                            ? API.scriptAssetReplace(scope, state.event, {
                                name: asset.name, revision: asset.revision, content_base64: content
                            })
                            : API.scriptAssetUpload(scope, state.event, {
                                name: file.name, content_base64: content
                            });
                    });
                } catch (error) { if (current()) setError(error); }
            }
            if (replace) confirm(st('replaceFileConfirm'), function() { void upload(); });
            else await upload();
        }
        function deleteAsset() {
            var selected = config.mode === 'assets'
                ? assets().filter(function(asset) { return state.selectedAssets.has(asset.name); })
                : [selectedAsset()].filter(Boolean);
            if (!selected.length || state.busy) return;
            if (selected.some(function(asset) { return asset.references && asset.references.length; })) {
                setError({ category: 'validation', message: st('fileInUse') });
                return;
            }
            var event = state.event;
            confirm(st(selected.length > 1 ? 'deleteSelectedFilesConfirm' : 'deleteFileConfirm'), function() {
                state.removal = { assets: true, before: assets().map(function(asset) { return asset.name; }),
                    removed: selected.map(function(asset) { return asset.name; }) };
                void mutate(async function() {
                    var response = null;
                    try {
                        for (var index = 0; index < selected.length; index++) {
                            response = await API.scriptAssetDelete(scope, event, {
                                name: selected[index].name, revision: selected[index].revision
                            });
                        }
                        return response;
                    } catch (error) {
                        if (response) {
                            applyResponse(response);
                            if (typeof config.onSaved === 'function') config.onSaved(response);
                        }
                        throw error;
                    }
                });
            });
        }
        async function downloadAsset() {
            var asset = selectedAsset();
            if (!asset || state.busy) return;
            state.busy = true;
            renderBody();
            try {
                var response = await API.scriptAssetDownload(scope, state.event, {
                    name: asset.name, revision: asset.revision
                });
                if (current()) saveDownloadedAsset(response && response.asset);
            } catch (error) { if (current()) setError(error); }
            finally { state.busy = false; if (current()) { renderBody(); if (document.activeElement === document.body && navigations.assets) navigations.assets.focusSelected(); } }
        }
        function renderEntries() {
            var rows = entries();
            var editable = Boolean(groupView().editable) && !state.busy;
            var table = create('table', {
                className: ['preference__table', 'gpo-catalog-table'],
                children: [
                    create('thead', { children: [create('tr', { children: [
                        create('th', { text: st('columnName') }),
                        create('th', { text: st('columnArguments') })
                    ] })] }),
                    create('tbody', { children: rows.length ? rows.map(function(entry) {
                        var row = create('tr', {
                            className: entry.identity === state.selectedEntry[state.group] ? 'active' : null,
                            attrs: { tabindex: '-1', 'data-script-entry': entry.identity },
                            children: [nameCell(entry.command_line, editorIcons.scriptFile(state.group)),
                                create('td', { text: entry.parameters })]
                        });
                        function select() {
                            state.selectedEntry[state.group] = entry.identity;
                            Array.prototype.forEach.call(table.getElement().querySelectorAll('tbody tr'), function(candidate) {
                                candidate.classList.toggle('active', candidate === row.getElement());
                            });
                            syncButtons();
                            setHeaderState();
                            if (navigations.entries) navigations.entries.sync();
                        }
                        row.getElement().__select = select;
                        row.on('click', function() { select(); navigations.entries.focusSelected(); });
                        row.on('dblclick', function() { if (!state.busy && !state.form && !state.picker && !state.confirmation) { select(); openForm('edit'); } });
                        return row;
                    }) : [create('tr', {
                        className: 'gpo-editor-scripts__empty-row',
                        children: [create('td', {
                            attrs: { colspan: '2' }, text: st('emptyEntries')
                        })]
                    })] })
                ]
            });
            var controls = {
                add: button(st('add'), function() { openForm('add'); }, !editable),
                edit: button(st('edit'), function() { openForm('edit'); }, true),
                remove: button(st('remove'), removeEntry, true),
                up: button(st('up'), function() { moveEntry(-1); }, true),
                down: button(st('down'), function() { moveEntry(1); }, true)
            };
            function syncButtons() {
                var index = rows.findIndex(function(entry) {
                    return entry.identity === state.selectedEntry[state.group];
                });
                var selected = editable && index >= 0;
                var up = editable && index >= 1;
                var down = editable && index >= 0 && index < rows.length - 1;
                [controls.edit, controls.remove].forEach(function(control) {
                    control.getElement().disabled = !selected;
                    control.getElement().classList.toggle('active', selected);
                });
                controls.up.getElement().disabled = !up;
                controls.down.getElement().disabled = !down;
                controls.up.getElement().classList.toggle('active', up);
                controls.down.getElement().classList.toggle('active', down);
            }
            syncButtons();
            bindTable(table, 'entries', {
                rows: function() { return Array.from(table.getElement().querySelectorAll('[data-script-entry]')); },
                selected: function() { return Array.from(table.getElement().querySelectorAll('[data-script-entry]')).find(function(row) { return row.getAttribute('data-script-entry') === state.selectedEntry[state.group]; }) || null; },
                select: function(row) { row.__select(); }, activate: function() { openForm('edit'); },
                remove: removeEntry, canActivate: function() { return Boolean(groupView().editable); },
                canRemove: function() { return Boolean(groupView().editable); }
            });
            return create('section', {
                className: 'gpo-editor-scripts__entries',
                children: [create('div', {
                    className: 'gpo-editor-scripts__list', children: [table]
                }), create('div', {
                    className: 'gpo-editor-scripts__toolbar',
                    children: config.mode === 'event'
                        ? [controls.up, controls.down, controls.add, controls.edit, controls.remove]
                        : [controls.up, controls.down]
                })]
            });
        }
        function renderAssets() {
            var all = assets();
            var mayChange = !state.busy && Boolean(groupView().editable);
            var explorer = config.mode === 'assets';
            var rows = all.map(function(asset) {
                var checkbox = explorer ? create('input', {
                    attrs: { type: 'checkbox', tabindex: '-1', 'aria-label': st('selectFile') + ': ' + asset.name }
                }) : null;
                if (checkbox) checkbox.getElement().checked = state.selectedAssets.has(asset.name);
                var row = create('tr', {
                    className: explorer ? (state.selectedAssets.has(asset.name) ? 'active' : null)
                        : (asset.name === state.selectedAsset ? 'active' : null),
                    attrs: { tabindex: '-1', 'data-script-asset': asset.name },
                    children: [checkbox ? create('td', { children: [checkbox] }) : null,
                        nameCell(asset.name, assetIcon(asset.name)),
                        create('td', { text: String(asset.byte_size) + ' ' + st('bytes') }),
                        create('td', { text: String((asset.references || []).length) })]
                });
                function select(selected, exclusive, range) {
                    if (explorer) {
                        if (range && state.assetFocus) {
                            var from = all.findIndex(function(entry) { return entry.name === state.assetFocus; });
                            var to = all.indexOf(asset);
                            if (exclusive) state.selectedAssets.clear();
                            all.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(function(entry) { state.selectedAssets.add(entry.name); });
                        } else if (exclusive) state.selectedAssets.clear();
                        if (selected) state.selectedAssets.add(asset.name);
                        else state.selectedAssets.delete(asset.name);
                        state.selectedAsset = state.selectedAssets.size === 1
                            ? Array.from(state.selectedAssets)[0] : null;
                        Array.prototype.forEach.call(table.getElement().querySelectorAll('[data-script-asset]'), function(candidate) {
                            var active = state.selectedAssets.has(candidate.getAttribute('data-script-asset'));
                            candidate.classList.toggle('active', active);
                            candidate.setAttribute('aria-selected', active ? 'true' : 'false');
                            candidate.querySelector('input[type=checkbox]').checked = active;
                        });
                    } else {
                        state.selectedAsset = asset.name;
                        Array.prototype.forEach.call(table.getElement().querySelectorAll('tbody tr'), function(candidate) {
                            candidate.classList.toggle('active', candidate === row.getElement());
                        });
                    }
                    state.assetFocus = asset.name;
                    syncButtons();
                    if (navigations.assets) navigations.assets.sync();
                }
                row.getElement().__select = function(event) { select(true, !event || !event.ctrlKey, Boolean(event && event.shiftKey)); };
                row.on('click', function(event) {
                    select(explorer && !event.shiftKey ? !state.selectedAssets.has(asset.name) : true, false, event.shiftKey);
                    navigations.assets.sync();
                    row.getElement().focus();
                });
                row.on('dblclick', function(event) {
                    if (event.target.closest('input, select, textarea, button, a, summary, [contenteditable]')) return;
                    if (state.busy || state.form || state.picker || state.confirmation) return;
                    select(true, true);
                    if (explorer) void downloadAsset(); else openForm('select');
                });
                if (checkbox) checkbox.on('click', function(event) { event.stopPropagation(); });
                if (checkbox) checkbox.on('change', function() { select(checkbox.getElement().checked); });
                return row;
            });
            var table = create('table', {
                className: ['preference__table', 'gpo-catalog-table'],
                children: [create('thead', { children: [create('tr', { children: [
                    explorer ? create('th', { text: '' }) : null,
                    create('th', { text: st('columnName') }),
                    create('th', { text: st('columnSize') }),
                    create('th', { text: st(explorer ? 'usedBy' : 'columnReferences') })
                ] })] }), create('tbody', { children: rows.length ? rows : [create('tr', {
                    className: 'gpo-editor-scripts__empty-row',
                    children: [create('td', {
                        attrs: { colspan: explorer ? '4' : '3' }, text: st('emptyAssets')
                    })]
                })] })]
            });
            var controls = {
                upload: button(st('upload'), function() { uploadInput.getElement().click(); }, !mayChange),
                select: button(st('addSelectedScript'), function() { openForm('select'); }, true),
                replace: button(st('replaceFile'), function() { replaceInput.getElement().click(); }, true),
                download: button(st('download'), function() { void downloadAsset(); }, true),
                delete: button(st('deleteFile'), deleteAsset, true),
                refresh: button(st('refresh'), function() { void loadEvent(); }, state.busy)
            };
            function syncButtons() {
                var asset = selectedAsset();
                var selected = explorer ? all.filter(function(item) {
                    return state.selectedAssets.has(item.name);
                }) : asset ? [asset] : [];
                var enabled = [mayChange, mayChange && Boolean(asset),
                    mayChange && Boolean(asset), !state.busy && Boolean(asset),
                    mayChange && selected.length > 0 && selected.every(function(item) {
                        return !(item.references && item.references.length);
                    })];
                [controls.upload, controls.select, controls.replace, controls.download,
                    controls.delete].forEach(function(control, index) {
                    control.getElement().disabled = !enabled[index];
                    control.getElement().classList.toggle('active', enabled[index]);
                });
                controls.delete.getElement().title = selected.some(function(item) {
                    return item.references && item.references.length;
                }) ? st('fileInUse') : '';
                controls.refresh.getElement().disabled = state.busy;
                controls.refresh.getElement().classList.toggle('active', !state.busy);
            }
            syncButtons();
            bindTable(table, 'assets', {
                rows: function() { return Array.from(table.getElement().querySelectorAll('[data-script-asset]')); },
                selected: function() { return Array.from(table.getElement().querySelectorAll('[data-script-asset]')).find(function(row) { return row.getAttribute('data-script-asset') === (state.assetFocus || state.selectedAsset); }) || null; },
                isSelected: explorer ? function(row) { return state.selectedAssets.has(row.getAttribute('data-script-asset')); } : undefined,
                select: function(row, event) { row.__select(event); },
                activate: function(row, event) {
                    row.__select();
                    if (!explorer) openForm('select');
                    else if (event && event.key === 'F2') { if (groupView().editable) replaceInput.getElement().click(); }
                    else void downloadAsset();
                },
                remove: deleteAsset,
                canActivate: function() { return explorer || Boolean(groupView().editable); },
                canRemove: function() {
                    var selected = explorer ? all.filter(function(asset) { return state.selectedAssets.has(asset.name); }) : [selectedAsset()].filter(Boolean);
                    return Boolean(groupView().editable) && selected.length > 0 && selected.every(function(asset) { return !(asset.references && asset.references.length); });
                }
            });
            var toolbar = create('div', {
                className: 'gpo-editor-scripts__toolbar',
                children: explorer
                    ? all.length ? [controls.upload, controls.replace, controls.download,
                        controls.delete, controls.refresh] : [controls.upload]
                    : [controls.upload, controls.select, controls.replace,
                        controls.download, controls.delete]
            });
            var list = create('div', {
                className: 'gpo-editor-scripts__list', children: [table]
            });
            return create('section', {
                className: 'gpo-editor-scripts__assets',
                children: [explorer ? null : create('h3', { text: st('managedFiles') }),
                    explorer ? toolbar : list, explorer ? list : toolbar,
                    selectedAsset() && selectedAsset().references
                        && selectedAsset().references.length ? create('p', {
                            className: 'gpo-editor-scripts__hint', text: st('fileInUse')
                        }) : null]
            });
        }
        function renderOrder() {
            var select = create('select', { children: [
                create('option', { attrs: { value: 'unspecified' }, text: st('orderUnspecified') }),
                create('option', { attrs: { value: 'classic_first' }, text: st('orderClassicFirst') }),
                create('option', { attrs: { value: 'powershell_first' }, text: st('orderPowershellFirst') })
            ] });
            select.getElement().value = state.orderDraft || state.view.execution_order || 'unspecified';
            var canApply = !state.busy && Boolean(state.view.powershell.editable)
                && state.orderDraft !== state.view.execution_order;
            var apply = button(st('applyOrder'), function() { void saveOrderDraft(); }, !canApply);
            select.on('change', function() {
                state.orderDraft = select.getElement().value;
                var available = !state.busy && state.view.powershell.editable
                    && state.orderDraft !== state.view.execution_order;
                apply.getElement().disabled = !available;
                apply.getElement().classList.toggle('active', available);
            });
            select.getElement().disabled = state.busy || !state.view.powershell.editable;
            return create('div', {
                className: 'gpo-editor-scripts__order',
                children: [create('label', { text: st('psOrderLabel') }), select, apply]
            });
        }
        function saveOrderDraft() {
            if (!state.view || state.busy || !state.view.powershell.editable
                    || state.orderDraft === state.view.execution_order) return Promise.resolve(true);
            var snapshot = state.view.powershell.snapshot;
            var order = state.orderDraft;
            return mutate(function() {
                return API.scriptOrderUpdate(scope, state.event, {
                    snapshot: snapshot, execution_order: order
                });
            });
        }
        function renderBody() {
            if (!current()) return;
            setHeaderState();
            var slot = modalBody.getElement();
            var activeTable = document.activeElement && document.activeElement.closest('[data-script-list]');
            var heldList = activeTable && slot.contains(activeTable) ? activeTable.getAttribute('data-script-list') : null;
            var heldGroupTab = slot.contains(document.activeElement)
                && document.activeElement.getAttribute('data-script-group');
            Object.keys(navigations).forEach(function(kind) { navigations[kind].cleanup(); });
            navigations = {};
            slot.textContent = '';
            if (state.loading) {
                slot.appendChild(create('div', { className: 'gpo-editor-empty', text: st('loading') }).getElement());
                return;
            }
            if (state.error) {
                slot.appendChild(editorStatus.renderError(state.error, {
                    onRefresh: function() { void loadEvent(); },
                    onReconcile: function() { void API.reconcile().then(loadEvent, setError); }
                }).getElement());
            }
            if (!state.view) return;
            if (state.envelope && state.envelope.pending_publication) {
                var pending = editorStatus.renderPending(state.envelope.pending_publication, function() {
                    void API.reconcile().then(loadEvent, setError);
                });
                if (pending) slot.appendChild(pending.getElement());
            }
            var diagnostics = groupView().diagnostics || [];
            if (!groupView().editable) {
                slot.appendChild(create('p', {
                    className: 'gpo-editor-scripts__hint', text: st('readOnlyScripts')
                }).getElement());
            }
            if (diagnostics.length) slot.appendChild(editorStatus.renderDiagnostics(diagnostics).getElement());
            if (state.saveStatus) slot.appendChild(create('p', {
                className: 'gpo-editor-scripts__save-status',
                attrs: { role: 'status', 'aria-live': 'polite' },
                text: state.saveStatus === 'saving' ? st('saving')
                    : state.saveStatus === 'saved' ? st('saved') : ''
            }).getElement());
            if (config.mode !== 'assets') {
                slot.appendChild(create('div', {
                    className: 'preference__modal-tabs',
                    children: [create('div', {
                        className: 'tab-buttons', attrs: { role: 'tablist' },
                        children: GROUPS.map(function(group) {
                            return create('button', {
                                className: ['preference__tab-button', group === state.group ? 'active' : null],
                                attrs: { type: 'button', role: 'tab',
                                    'data-script-group': group,
                                    'aria-selected': group === state.group ? 'true' : 'false' },
                                text: st(group),
                                events: { click: function() { state.group = group; renderBody(); } }
                            });
                        })
                    }), renderEntries()]
                }).getElement());
                slot.appendChild(renderOrder().getElement());
                if (config.mode === 'event' && typeof config.openFolder === 'function') {
                    slot.appendChild(button(st('showFiles'), config.openFolder, state.busy,
                        'gpo-editor-scripts__show-files').getElement());
                }
            }
            if (config.mode !== 'event') slot.appendChild(renderAssets().getElement());
            if (heldGroupTab) {
                var restoredTab = slot.querySelector('[data-script-group="' + heldGroupTab + '"]');
                if (restoredTab) restoredTab.focus({ preventScroll: true });
            } else if (heldList && navigations[heldList]) navigations[heldList].focusSelected();
        }
        function bindTable(table, kind, options) {
            table.getElement().setAttribute('data-script-list', kind);
            navigations[kind] = listNavigation.bind(table.getElement(), Object.assign({}, options, {
                busy: function() { return !current() || state.busy || state.loading || Boolean(state.form || state.picker || state.confirmation); }
            }));
            return navigations[kind];
        }
        root.hasUnsavedChanges = function() {
            return state.busy || Boolean(state.formState && state.formState.dirty())
                || Boolean(state.view && state.orderDraft !== state.view.execution_order);
        };
        root.isBusy = function() { return state.busy; };
        root.updateResponse = function(response) { if (current()) applyResponse(response); };
        root.applyChanges = async function() {
            if (state.busy) return false;
            if (state.formState && state.formState.dirty()) {
                if (!await state.formState.submit()) return false;
            }
            return saveOrderDraft();
        };
        root.cancelChanges = function() {
            if (state.busy) return false;
            closeForm(true);
            if (state.view) state.orderDraft = state.view.execution_order;
            renderBody();
            return true;
        };
        root.cleanup = function() {
            state.disposed = true;
            Object.keys(navigations).forEach(function(kind) { navigations[kind].cleanup(); });
            ++state.requestId;
            closeForm(true); closeConfirmation();
            headerListeners.forEach(function(remove) { remove(); });
            if (ownsHeader()) {
                headerControls.style.display = 'none';
                headerControls.removeAttribute('data-script-owner');
                [createButton, editButton, deleteButton].forEach(function(control, index) {
                    if (!control) return;
                    control.classList.remove('active');
                    control.textContent = headerLabels[index];
                });
            }
            if (headerActions && headerActions.getAttribute('data-script-owner') === headerOwner) {
                headerActions.removeAttribute('data-script-owner');
                headerActions.style.display = '';
                if (admxActions) admxActions.style.display = '';
                if (helpSeparator) helpSeparator.style.display = '';
            }
        };
        void loadEvent();
        return root;
    }

    function renderScriptsTemplate(options) {
        var config = options || {};
        // Existing event links can still be opened while navigation migrates to one Scripts leaf.
        if (config.item && config.item.event) return renderScriptEventEditor(config);

        var scope = config.item && config.item.scope === 'user' ? 'user' : 'computer';
        var events = EVENTS[scope];
        var state = {
            selectedEvent: events.indexOf(config.item && config.item.scriptEvent) !== -1
                ? config.item.scriptEvent : events[0],
            summaries: {}, errors: {}, generations: {},
            modal: null, confirmation: null, disposed: false
        };
        var overviewNavigation = null;
        var root = create('div', { className: ['gp__scripts', 'gp__preference', 'gpo-editor-scripts'] });
        var rootElement = root.getElement();
        var overview = create('div', { className: ['preference__data-table', 'gpo-editor-scripts__overview'] });
        if (!config.hideHeading) root.append(create('h2', { className: 'gpo-editor-scripts__title', text: config.categoryPath || st('scripts'),
            attrs: { 'data-category-path': '' } }));
        root.append(overview);

        var headerElement = config.header && config.header.getElement
            ? config.header.getElement() : null;
        var headerControls = headerElement && headerElement.querySelector('.gp__control');
        var headerActions = headerElement && headerElement.querySelector('.gp__control-actions');
        var admxActions = headerElement && headerElement.querySelector('.gp__control-admx');
        var helpSeparator = headerElement && headerElement.querySelector('.gp__control-separator');
        var createButton = headerControls && headerControls.querySelector('.preferences__btn-create');
        var editButton = headerControls && headerControls.querySelector('.preferences__btn-edit');
        var deleteButton = headerControls && headerControls.querySelector('.preferences__btn-delete');
        var headerOwner = 'scripts-' + nextHeaderOwnerId++;
        var oldHeader = [createButton, editButton, deleteButton].map(function(control) {
            return control ? {
                text: control.textContent, display: control.style.display,
                disabled: control.disabled, active: control.classList.contains('active')
            } : null;
        });
        var folderButton = button(st('openFolder'), function() { openModal('assets'); }, false);
        folderButton.addClass('gpo-editor-scripts__folder-button');
        if (headerControls) {
            headerControls.setAttribute('data-script-owner', headerOwner);
            headerControls.style.display = 'flex';
            if (createButton) createButton.style.display = 'none';
            if (deleteButton) deleteButton.style.display = 'none';
            if (editButton) {
                editButton.textContent = st('openEvent');
                editButton.classList.add('active');
                editButton.addEventListener('click', onOpenEvent);
            }
            headerControls.appendChild(folderButton.getElement());
        }
        if (headerActions) {
            headerActions.setAttribute('data-script-owner', headerOwner);
            headerActions.style.display = 'flex';
        }
        if (admxActions) admxActions.style.display = 'none';
        if (helpSeparator) helpSeparator.style.display = 'none';

        function current() {
            return !state.disposed
                && (typeof config.isCurrent !== 'function' || config.isCurrent());
        }
        function ownsHeader() {
            return Boolean(headerControls
                && headerControls.getAttribute('data-script-owner') === headerOwner);
        }
        function updateHeader() {
            if (!ownsHeader()) return;
            var enabled = !state.modal;
            if (editButton) {
                editButton.disabled = !enabled;
                editButton.classList.toggle('active', enabled);
            }
            folderButton.getElement().disabled = !enabled;
            folderButton.getElement().classList.toggle('active', enabled);
        }
        function refreshEvent(event) {
            var generation = (state.generations[event] || 0) + 1;
            state.generations[event] = generation;
            return API.scriptsShow(scope, event).then(function(response) {
                if (!current() || state.generations[event] !== generation) return;
                state.summaries[event] = response && response.scripts || null;
                delete state.errors[event];
                renderOverview();
            }, function(error) {
                if (!current() || state.generations[event] !== generation) return;
                state.errors[event] = error;
                renderOverview();
            });
        }
        function renderOverview() {
            if (!current()) return;
            var heldFocus = overview.getElement().contains(document.activeElement);
            if (overviewNavigation) overviewNavigation.cleanup();
            function selectRow(row, event) {
                state.selectedEvent = event;
                Array.prototype.forEach.call(table.getElement().querySelectorAll('tbody tr'), function(candidate) {
                    candidate.classList.toggle('active', candidate === row.getElement());
                });
                renderOverviewError();
                if (overviewNavigation) overviewNavigation.sync();
            }
            var table = create('table', {
                className: ['preference__table', 'gpo-catalog-table', 'gpo-editor-scripts__event-table'],
                children: [create('thead', { children: [create('tr', { children: [
                    create('th', { text: st('eventColumn') }),
                    create('th', { text: st('scriptsColumn') }),
                    create('th', { text: st('powershellColumn') })
                ] })] }), create('tbody', { children: events.map(function(event) {
                    var view = state.summaries[event];
                    var row = create('tr', {
                        className: event === state.selectedEvent ? 'active' : null,
                        attrs: { tabindex: '-1', 'data-script-event': event },
                        children: [nameCell(eventLabel(event), editorIcons.scriptEvent(event)),
                            create('td', { text: view ? String(view.classic.entries.length) : '—' }),
                            create('td', { text: view ? String(view.powershell.entries.length) : '—' })]
                    });
                    row.getElement().__select = function() { selectRow(row, event); };
                    row.on('click', function() { selectRow(row, event); overviewNavigation.focusSelected(); });
                    row.on('dblclick', function() { if (!state.modal) { selectRow(row, event); openModal('event'); } });
                    return row;
                }) })]
            });
            var slot = overview.getElement();
            slot.replaceChildren(table.getElement());
            overviewNavigation = listNavigation.bind(table.getElement(), {
                rows: function() { return Array.from(table.getElement().querySelectorAll('[data-script-event]')); },
                selected: function() { return Array.from(table.getElement().querySelectorAll('[data-script-event]')).find(function(row) { return row.getAttribute('data-script-event') === state.selectedEvent; }) || null; },
                select: function(row) { row.__select(); }, activate: function() { openModal('event'); },
                busy: function() { return !current() || Boolean(state.modal); }
            });
            renderOverviewError();
            if (heldFocus) overviewNavigation.focusSelected();
        }
        function renderOverviewError() {
            var slot = overview.getElement();
            var prior = slot.querySelector('.gpo-editor-scripts__overview-error');
            if (prior) prior.remove();
            if (state.errors[state.selectedEvent]) {
                var error = create('div', { className: 'gpo-editor-scripts__overview-error' });
                error.append(editorStatus.renderError(state.errors[state.selectedEvent], {
                    onRefresh: function() { void refreshEvent(state.selectedEvent); }
                }));
                slot.appendChild(error.getElement());
            }
        }
        function onOpenEvent() {
            if (ownsHeader() && !state.modal) openModal('event');
        }
        function closeModal(force, afterClose) {
            var active = state.modal;
            if (!active || active.detail && active.detail.isBusy()) return false;
            if (!force && active.detail && active.detail.hasUnsavedChanges()) {
                if (!state.confirmation) state.confirmation = confirmationDialog.open(rootElement, {
                    message: st('discardFormConfirm'),
                    onCancel: function() { state.confirmation = null; },
                    onConfirm: function() { state.confirmation = null; closeModal(true, afterClose); }
                });
                return false;
            }
            if (active.detail) active.detail.cleanup();
            active.dialog.remove();
            active.overlay.remove();
            state.modal = null;
            updateHeader();
            void refreshEvent(active.event);
            if (current()) {
                if (active.previousFocus && active.previousFocus.isConnected) active.previousFocus.focus();
                else if (overviewNavigation) overviewNavigation.focusSelected();
            }
            if (typeof afterClose === 'function') afterClose();
            return true;
        }
        function openModal(mode) {
            if (!current() || state.modal) return;
            var event = state.selectedEvent;
            var previousFocus = document.activeElement;
            var overlay = create('div', {
                className: ['scripts__overlay', 'active', 'gpo-editor-scripts__dialog-overlay'],
                events: { click: function() { closeModal(); } }
            });
            var host = create('div', { className: 'gpo-editor-scripts__detail-host' });
            var title = mode === 'assets'
                ? st('folderForEvent').replace('{event}', eventLabel(event)) : eventLabel(event);
            var content = create('div', {
                className: 'preference__modal-content',
                children: [host]
            });
            var dialog = create('div', {
                className: ['preference__modal', 'active', mode === 'assets'
                    ? 'gpo-editor-scripts__explorer' : 'gpo-editor-scripts__event-dialog'],
                attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
                events: { keydown: function(keyEvent) {
                    if (keyEvent.defaultPrevented || keyEvent.target.closest('[role="dialog"], [role="alertdialog"]') !== dialog.getElement()) return;
                    if (keyEvent.key === 'Escape') {
                        keyEvent.preventDefault(); keyEvent.stopPropagation(); closeModal();
                    }
                    editorDialog.trapTab(keyEvent, dialog.getElement());
                } },
                children: [create('div', {
                    className: 'preference__modal-wrapper',
                    children: [create('div', {
                        className: 'preference__modal-header',
                        children: [create('div', {
                            className: 'title', text: title
                        }), create('button', {
                            className: 'close', attrs: { type: 'button', 'aria-label': st('close') },
                            events: { click: function() { closeModal(); } }
                        })]
                    }), content, create('div', {
                        className: 'preference__modal-footer',
                        children: [button(st('closeDialog'), function() { closeModal(); }, false, 'btn-cancel')]
                    })]
                })]
            });
            rootElement.appendChild(overlay.getElement());
            rootElement.appendChild(dialog.getElement());
            state.modal = { mode: mode, event: event, detail: null,
                dialog: dialog.getElement(), overlay: overlay.getElement(),
                previousFocus: previousFocus };
            updateHeader();
            mountDetail();
            dialog.getElement().querySelector('.btn-cancel').focus();

            function mountDetail() {
                var active = state.modal;
                if (!active || active.dialog !== dialog.getElement()) return;
                if (active.detail) active.detail.cleanup();
                active.detail = renderScriptEventEditor({
                    item: { scope: scope, event: event }, mode: mode,
                    isCurrent: function() { return current() && state.modal === active; },
                    openFolder: function() {
                        closeModal(false, function() { openModal('assets'); });
                    }
                });
                host.getElement().replaceChildren(active.detail.getElement());
                renderOverview();
            }
        }
        root.hasUnsavedChanges = function() {
            return Boolean(state.modal && state.modal.detail
                && state.modal.detail.hasUnsavedChanges());
        };
        root.applyChanges = function() {
            return state.modal && state.modal.detail
                ? state.modal.detail.applyChanges() : Promise.resolve(true);
        };
        root.cancelChanges = function() {
            if (state.modal && state.modal.detail && state.modal.detail.isBusy()) return false;
            if (state.modal) closeModal(true);
            return true;
        };
        root.cleanup = function() {
            state.disposed = true;
            if (overviewNavigation) overviewNavigation.cleanup();
            if (state.confirmation) { state.confirmation.close(); state.confirmation = null; }
            if (state.modal && state.modal.detail) state.modal.detail.cleanup();
            if (state.modal) { state.modal.dialog.remove(); state.modal.overlay.remove(); state.modal = null; }
            if (ownsHeader()) {
                editButton && editButton.removeEventListener('click', onOpenEvent);
                folderButton.getElement().remove();
                [createButton, editButton, deleteButton].forEach(function(control, index) {
                    if (!control) return;
                    control.textContent = oldHeader[index].text;
                    control.style.display = oldHeader[index].display;
                    control.disabled = oldHeader[index].disabled;
                    control.classList.toggle('active', oldHeader[index].active);
                });
                headerControls.removeAttribute('data-script-owner');
                headerControls.style.display = 'none';
            }
            if (headerActions && headerActions.getAttribute('data-script-owner') === headerOwner) {
                headerActions.removeAttribute('data-script-owner');
                headerActions.style.display = '';
                if (admxActions) admxActions.style.display = '';
                if (helpSeparator) helpSeparator.style.display = '';
            }
        };
        root.onMounted = function() {
            if (config.item && config.item.openPolicyDialog && current()) openModal('event');
        };
        renderOverview();
        events.forEach(function(event) { void refreshEvent(event); });
        return root;
    }

    function openScriptsDialog(host, options) {
        var config = options || {};
        var item = config.item || {};
        var scope = item.scope === 'user' ? 'user' : 'computer';
        var event = item.scriptEvent || item.event;
        if (EVENTS[scope].indexOf(event) === -1) event = EVENTS[scope][0];
        var closed = false;
        var explorer = null;
        var detailHost = create('div', { className: 'gpo-editor-scripts__detail-host' });
        var editor = renderScriptEventEditor({
            item: { scope: scope, event: event }, mode: 'event',
            isCurrent: current,
            onSaved: config.onSaved,
            openFolder: openFolder
        });
        detailHost.append(editor);
        var dialog = editorDialog.open(host, {
            title: eventLabel(event), className: ['gpo-editor-scripts__event-dialog'],
            hostClassName: ['gpo-editor-scripts'], content: detailHost,
            readOnly: true, cancelLabel: st('closeDialog'), closeLabel: st('close'),
            canClose: function() { return !editor.isBusy() && !explorer; },
            isDirty: editor.hasUnsavedChanges,
            discardMessage: st('discardFormConfirm'),
            onClose: function() {
                cleanup();
                if (config.onClose) config.onClose();
            },
            restoreFocus: config.restoreFocus
        });

        function current() {
            return !closed && (typeof config.isCurrent !== 'function' || config.isCurrent());
        }
        function openFolder() {
            if (!current() || explorer || editor.isBusy()) return;
            var filesHost = create('div', { className: 'gpo-editor-scripts__detail-host' });
            var files = renderScriptEventEditor({
                item: { scope: scope, event: event }, mode: 'assets',
                isCurrent: function() { return current() && Boolean(explorer); },
                onSaved: function(response) {
                    editor.updateResponse(response);
                    if (typeof config.onSaved === 'function') config.onSaved(response);
                }
            });
            filesHost.append(files);
            dialog.root.getElement().inert = true;
            var filesDialog = editorDialog.open(host, {
                title: st('folderForEvent').replace('{event}', eventLabel(event)),
                className: ['gpo-editor-scripts__explorer'], hostClassName: ['gpo-editor-scripts'],
                content: filesHost, readOnly: true,
                cancelLabel: st('closeDialog'), closeLabel: st('close'),
                canClose: function() { return !files.isBusy(); },
                isDirty: files.hasUnsavedChanges,
                onClose: function() {
                    files.cleanup(); explorer = null;
                    if (!closed) dialog.root.getElement().inert = false;
                }
            });
            explorer = { editor: files, dialog: filesDialog };
        }
        function cleanup() {
            if (closed) return;
            closed = true;
            if (explorer) explorer.dialog.close();
            editor.cleanup();
        }
        // The All Policies controller owns one lifecycle even while the files
        // explorer is temporarily displayed above the selected script event.
        var controller = {
            hasUnsavedChanges: function() { return editor.hasUnsavedChanges() || Boolean(explorer && explorer.editor.hasUnsavedChanges()); },
            isBusy: function() { return editor.isBusy() || Boolean(explorer && explorer.editor.isBusy()); },
            applyChanges: async function() {
                if (explorer && !await explorer.editor.applyChanges()) return false;
                return editor.applyChanges();
            },
            cancelChanges: function() {
                if (editor.isBusy() || explorer && explorer.editor.isBusy()) return false;
                if (explorer) explorer.dialog.close();
                return editor.cancelChanges();
            },
            cleanup: cleanup,
            getElement: function() { return editor.getElement(); }
        };
        return { editor: controller, dialog: dialog };
    }
    return { renderScriptsTemplate: renderScriptsTemplate,
        openScriptsDialog: openScriptsDialog,
        _test: { fileBase64: fileBase64, saveDownloadedAsset: saveDownloadedAsset } };
});
