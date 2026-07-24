define([
    '../../../util/API',
    './admx-constants',
    './admx-policy-normalizers',
    './admx-value-parser',
    './admx-form-state'
], function(__dep0, __dep1, __dep2, __dep3, __dep4) {
var API = __dep0;
var { ADMX_DEFAULT_STATE } = __dep1;
var { normalizeAdmxState, getDefaultControlValue } = __dep2;
var { parseAdmxCurrentValue, buildAdmxSetValue } = __dep3;
var {
    syncControlsWithPolicyState,
    getControlElementByStoragePath,
    readControlValue,
    applyControlValue,
    buildAdmxFormSnapshot,
    applyAdmxFormSnapshot,
    applyDefaultValuesToAdmxForm,
    setSelectedAdmxState,
    getSelectedAdmxState,
} = __dep4;

function isEmptyValue(value, metadata = {}) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (metadata?.type !== 'boolean' && value === '') return true;
    return false;
}

function addManagedEventListener(cleanups, target, eventName, handler, options) {
    if (!target || typeof target.addEventListener !== 'function' || typeof handler !== 'function') {
        return;
    }

    target.addEventListener(eventName, handler, options);
    cleanups.push(() => target.removeEventListener(eventName, handler, options));
}

function setupAdmxTemplateController({
    admxTemplate,
    admxTemplateElement,
    statePolicyElement,
    header = null,
    effectiveTarget = '',
    controlEntries = [],
    initialFormSnapshot = null,
} = {}) {
    const headerEl = header?.getElement?.();
    const controlActions = headerEl?.querySelector('.gp__control-actions');
    if (controlActions) controlActions.style.display = 'flex';
    const controlPref = headerEl?.querySelector('.gp__control');
    if (controlPref) controlPref.style.display = 'none';
    const btnApply = headerEl?.querySelector('.admx__btn-apply') ?? null;
    const btnCancel = headerEl?.querySelector('.admx__btn-cancel') ?? null;
    const cleanups = [];

    let isSaving = false;

    const setHeaderAdmxButtonsActive = (active) => {
        const canUseButtons = !isSaving && initialFormSnapshot !== null;

        if (btnApply) {
            btnApply.classList.toggle('active', canUseButtons && active);
        }

        if (btnCancel) {
            btnCancel.classList.toggle('active', canUseButtons && active);
        }
    };

    const refreshHeaderAdmxButtons = () => {
        if (initialFormSnapshot === null) {
            setHeaderAdmxButtonsActive(false);
            return;
        }

        const currentSnapshot = buildAdmxFormSnapshot({
            rootElement: admxTemplateElement,
            controlEntries,
        });

        setHeaderAdmxButtonsActive(JSON.stringify(currentSnapshot) !== JSON.stringify(initialFormSnapshot));
    };

    setHeaderAdmxButtonsActive(false);

    const handleStatePolicyChange = (event) => {
        if (isSaving) {
            return;
        }

        const targetElement = event.target;

        if (!(targetElement instanceof HTMLInputElement)) {
            return;
        }

        if (targetElement.name !== 'admx-state') {
            return;
        }

        syncControlsWithPolicyState(admxTemplateElement);
        refreshHeaderAdmxButtons();
    };

    const handleControlsChange = (event) => {
        if (isSaving) {
            return;
        }

        const targetElement = event.target;

        if (!(targetElement instanceof HTMLElement)) {
            return;
        }

        if (!targetElement.closest('.gp__admx-options')) {
            return;
        }

        refreshHeaderAdmxButtons();
    };

    const handleCancel = () => {
        if (!btnCancel?.classList.contains('active') || initialFormSnapshot === null || isSaving) {
            return;
        }

        applyAdmxFormSnapshot({
            rootElement: admxTemplateElement,
            snapshot: initialFormSnapshot,
            controlEntries,
        });
        refreshHeaderAdmxButtons();
    };

    const handleApply = async () => {
        if (!btnApply?.classList.contains('active') || isSaving) {
            return false;
        }

        try {
            isSaving = true;
            setHeaderAdmxButtonsActive(false);

            const currentNameGpt = await API.waitForNameGpt();
            const selectedState = getSelectedAdmxState(admxTemplateElement);

            if (!currentNameGpt) {
                throw new Error('GPO file system path is not available.');
            }

            if (!effectiveTarget) {
                throw new Error('ADMX target is not available.');
            }

            let hasNonEmptyValue = false;

            await Promise.all(controlEntries.map(async (controlEntry) => {
                const controlPath = controlEntry.storagePath || controlEntry.policyPath;

                if (!controlPath) {
                    return;
                }

                if (selectedState === ADMX_DEFAULT_STATE) {
                    await API.deletePolicy(currentNameGpt, effectiveTarget, controlPath);
                    return;
                }

                const controlElement = getControlElementByStoragePath(admxTemplateElement, controlEntry.storagePath);
                const controlValue = readControlValue(controlElement, controlEntry.metadata);

                if (isEmptyValue(controlValue, controlEntry.metadata)) {
                    await API.deletePolicy(currentNameGpt, effectiveTarget, controlPath);
                    return;
                }

                hasNonEmptyValue = true;
                const setValue = buildAdmxSetValue(selectedState, controlValue);
                await API.set(
                    currentNameGpt,
                    effectiveTarget,
                    controlPath,
                    setValue,
                    controlEntry.metadataPath || controlPath
                );
            }));

            if (selectedState === ADMX_DEFAULT_STATE || (!hasNonEmptyValue && selectedState !== ADMX_DEFAULT_STATE)) {
                applyDefaultValuesToAdmxForm({
                    rootElement: admxTemplateElement,
                    controlEntries,
                });

                initialFormSnapshot = buildAdmxFormSnapshot({
                    rootElement: admxTemplateElement,
                    controlEntries,
                });
                return true;
            }

            if (selectedState === 'disabled') {
                setSelectedAdmxState(admxTemplateElement, selectedState);

                controlEntries.forEach(({ storagePath, metadata }) => {
                    const controlElement = getControlElementByStoragePath(admxTemplateElement, storagePath);
                    applyControlValue(controlElement, metadata, getDefaultControlValue(metadata));
                });

                syncControlsWithPolicyState(admxTemplateElement);
            }

            initialFormSnapshot = buildAdmxFormSnapshot({
                rootElement: admxTemplateElement,
                controlEntries,
            });
        } catch (error) {
            console.error('[ADMX] Failed to apply policy values.', error);
            alert('Failed to apply policy: ' + (error.message || error));
            return false;
        } finally {
            isSaving = false;
            refreshHeaderAdmxButtons();
        }

        return true;
    };

    const packagesModal = admxTemplateElement.querySelector('.packages-control__modal');

    if (packagesModal) {
        const packagesContent = packagesModal.querySelector('.packages-control__modal-content');
        const packagesBtnNew = packagesModal.querySelector('.btn-new');
        const packagesBtnDelete = packagesModal.querySelector('.btn-delete');
        const packagesBtnCancel = packagesModal.querySelector('.btn-cancel');
        const packagesBtnOk = packagesModal.querySelector('.btn-ok');
        const packagesClose = packagesModal.querySelector('.close');
        const packagesTitle = packagesModal.querySelector('.packages-control__modal-header .title');

        let workingPackages = [];
        let currentHiddenInput = null;

        const renderPackageItems = () => {
            packagesContent.innerHTML = '';

            workingPackages.forEach((pkg, index) => {
                const item = document.createElement('div');
                item.className = 'packages-control__package-item';
                item.setAttribute('contenteditable', 'false');
                item.textContent = pkg;

                item.addEventListener('click', (e) => {
                    if (item.isContentEditable) return;
                    const wasSelected = item.classList.contains('selected');
                    packagesContent.querySelectorAll('.packages-control__package-item').forEach(el => el.classList.remove('selected'));
                    if (!wasSelected) {
                        item.classList.add('selected');
                    }
                });

                item.addEventListener('dblclick', () => {
                    item.setAttribute('contenteditable', 'true');
                    item.focus();
                    const range = document.createRange();
                    range.selectNodeContents(item);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                });

                item.addEventListener('blur', () => {
                    item.setAttribute('contenteditable', 'false');
                    workingPackages[index] = item.textContent.trim();
                });

                item.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        item.blur();
                    }
                });

                packagesContent.appendChild(item);
            });
        };

        const handleEditBtnClick = (event) => {
            const btn = event.target.closest('.packages-control__btn-edit');
            if (!btn) return;
            if (btn.disabled) return;

            const fieldElement = btn.closest('.field__element');
            const hiddenInput = fieldElement ? fieldElement.querySelector('input[type="hidden"]') : null;
            if (!hiddenInput) return;

            currentHiddenInput = hiddenInput;

            const raw = hiddenInput.value || '';
            if (raw === '') {
                workingPackages = [];
            } else {
                workingPackages = raw.split(',').map(s => s.trim()).filter(Boolean);
            }

            const storagePath = hiddenInput.getAttribute('data-storage-path') || '';
            const listEntry = controlEntries.find(e => e.storagePath === storagePath || e.policyPath === storagePath);
            if (packagesTitle && listEntry?.metadata?.label) {
                packagesTitle.textContent = listEntry.metadata.label;
            }

            renderPackageItems();
            packagesModal.classList.add('active');
        };

        const handlePackagesNew = () => {
            workingPackages.push('');
            renderPackageItems();
            const items = packagesContent.querySelectorAll('.packages-control__package-item');
            const lastItem = items[items.length - 1];
            if (lastItem) {
                lastItem.setAttribute('contenteditable', 'true');
                lastItem.focus();
            }
        };

        const handlePackagesDelete = () => {
            const selected = packagesContent.querySelector('.packages-control__package-item.selected');
            if (!selected) return;
            const items = Array.from(packagesContent.querySelectorAll('.packages-control__package-item'));
            const index = items.indexOf(selected);
            if (index !== -1) {
                workingPackages.splice(index, 1);
                renderPackageItems();
            }
        };

        const closePackagesModal = () => {
            packagesModal.classList.remove('active');
            packagesContent.innerHTML = '';
            workingPackages = [];
            currentHiddenInput = null;
        };

        const handlePackagesOk = () => {
            if (currentHiddenInput) {
                workingPackages = workingPackages.map(pkg => typeof pkg === 'string' ? pkg.trim() : pkg).filter(Boolean);
                currentHiddenInput.value = workingPackages.join(',');
                currentHiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            closePackagesModal();
        };

        addManagedEventListener(cleanups, admxTemplateElement, 'click', handleEditBtnClick);
        addManagedEventListener(cleanups, packagesBtnNew, 'click', handlePackagesNew);
        addManagedEventListener(cleanups, packagesBtnDelete, 'click', handlePackagesDelete);
        addManagedEventListener(cleanups, packagesBtnCancel, 'click', closePackagesModal);
        addManagedEventListener(cleanups, packagesBtnOk, 'click', handlePackagesOk);
        addManagedEventListener(cleanups, packagesClose, 'click', closePackagesModal);
    }

    addManagedEventListener(cleanups, statePolicyElement, 'change', handleStatePolicyChange);
    addManagedEventListener(cleanups, admxTemplateElement, 'change', handleControlsChange);
    addManagedEventListener(cleanups, admxTemplateElement, 'input', handleControlsChange);
    addManagedEventListener(cleanups, btnCancel, 'click', handleCancel);
    addManagedEventListener(cleanups, btnApply, 'click', handleApply);

    setHeaderAdmxButtonsActive(false);

    let cleanedUp = false;
    admxTemplate.cleanup = () => {
        if (cleanedUp) {
            return;
        }

        cleanedUp = true;

        while (cleanups.length > 0) {
            const cleanup = cleanups.pop();
            if (typeof cleanup === 'function') {
                cleanup();
            }
        }

        setHeaderAdmxButtonsActive(false);

        if (controlPref) controlPref.style.display = 'none';
    };

    admxTemplate.applyChanges = handleApply;
    admxTemplate.cancelChanges = handleCancel;
    admxTemplate.hasUnsavedChanges = () => btnApply?.classList.contains('active') ?? false;

    return admxTemplate;
}

async function prepareAdmxInitialState({
    rootElement,
    controlEntries = [],
    effectiveTarget = '',
} = {}) {
    try {
        const currentNameGpt = await API.waitForNameGpt();

        if (!currentNameGpt || !effectiveTarget) {
            applyDefaultValuesToAdmxForm({
                rootElement,
                controlEntries,
            });

            return buildAdmxFormSnapshot({
                rootElement,
                controlEntries,
            });
        }

        const results = await Promise.all(controlEntries.map(async (controlEntry) => {
            const controlPath = controlEntry.storagePath || controlEntry.policyPath;

            if (!controlPath) {
                return {
                    controlEntry,
                    parsedValue: {
                        hasData: false,
                        state: ADMX_DEFAULT_STATE,
                        value: null,
                    },
                };
            }

            const rawValue = await API.get_current_value(currentNameGpt, effectiveTarget, controlPath);

            return {
                controlEntry,
                parsedValue: parseAdmxCurrentValue(rawValue),
            };
        }));

        const hasAnyData = results.some(({ parsedValue }) => parsedValue?.hasData);

        if (!hasAnyData) {
            applyDefaultValuesToAdmxForm({
                rootElement,
                controlEntries,
            });

            return buildAdmxFormSnapshot({
                rootElement,
                controlEntries,
            });
        }

        const firstValueWithData = results.find(({ parsedValue }) => parsedValue?.hasData)?.parsedValue ?? null;
        setSelectedAdmxState(rootElement, normalizeAdmxState(firstValueWithData?.state));
        const loadedState = getSelectedAdmxState(rootElement);

        results.forEach(({ controlEntry, parsedValue }) => {
            const controlElement = getControlElementByStoragePath(rootElement, controlEntry.storagePath);
            const nextValue = loadedState === 'disabled'
                ? getDefaultControlValue(controlEntry.metadata)
                : (
                    parsedValue?.hasData
                        ? parsedValue.value
                        : getDefaultControlValue(controlEntry.metadata)
                );

            applyControlValue(controlElement, controlEntry.metadata, nextValue);
        });

        syncControlsWithPolicyState(rootElement);
    } catch (error) {
        console.error('[ADMX] Failed to load current values.', error);
        applyDefaultValuesToAdmxForm({
            rootElement,
            controlEntries,
        });
    }

    return buildAdmxFormSnapshot({
        rootElement,
        controlEntries,
    });
}

    return { setupAdmxTemplateController, prepareAdmxInitialState };
});
