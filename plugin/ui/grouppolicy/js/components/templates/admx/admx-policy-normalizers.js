define(['./admx-constants'], function(__dep0) {
var { ADMX_DEFAULT_STATE, VALID_ADMX_STATES } = __dep0;

function extractStoragePathFromData(data = '') {
    if (typeof data !== 'string') {
        return '';
    }

    const match = data.match(/Read_Path_GPT\((['"])(.*?)\1\)/);
    return match?.[2] ?? '';
}

function resolvePolicyPath({ entryKey = '', metadata = {}, policyHeader = {} } = {}) {
    if (entryKey.startsWith('\\')) {
        const headerKey = policyHeader?.key ?? '';
        const valueName = metadata?.valueName ?? '';

        if (headerKey && valueName) {
            return `${headerKey}\\${valueName}`;
        }

        if (valueName) {
            return valueName;
        }
    }

    return entryKey;
}

function normalizePolicyEntries(policyData = {}, policyHeader = {}) {
    const controlEntries = [];
    let policyValueEntry = null;

    Object.entries(policyData).forEach(([entryKey, entryValue]) => {
        if (entryKey === 'displayName' || entryKey === 'header') {
            return;
        }

        const metadata = entryValue?.metadata;

        if (!metadata) {
            return;
        }

        const resolvedPolicyPath = resolvePolicyPath({ entryKey, metadata, policyHeader });
        const normalizedEntry = {
            entryKey,
            metadata,
            policyPath: resolvedPolicyPath,
            storagePath: extractStoragePathFromData(entryValue?.data) || resolvedPolicyPath,
            metadataPath: extractStoragePathFromData(entryValue?.data) || resolvedPolicyPath,
        };

        if (metadata.type === 'policyValue') {
            if (!policyValueEntry) {
                policyValueEntry = normalizedEntry;
            }
            return;
        }

        controlEntries.push(normalizedEntry);
    });

    return { controlEntries, policyValueEntry };
}

function getEnumDefaultValue(items = {}, defaultItem) {
    const itemKeys = Object.keys(items);

    if (itemKeys.length === 0) {
        return '';
    }

    if (defaultItem !== undefined && defaultItem !== null) {
        const normalizedDefault = String(defaultItem);
        if (Object.prototype.hasOwnProperty.call(items, normalizedDefault)) {
            return normalizedDefault;
        }
    }

    return itemKeys[0];
}

function isPlainObject(value) {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value);
}

function normalizeAdmxState(state) {
    return VALID_ADMX_STATES.has(state)
        ? state
        : ADMX_DEFAULT_STATE;
}

function getDefaultControlValue(metadata = {}) {
    switch (metadata?.type) {
        case 'enum':
            return getEnumDefaultValue(metadata.items ?? {}, metadata.defaultItem);
        case 'boolean':
            return Object.prototype.hasOwnProperty.call(metadata, 'falseValue')
                ? metadata.falseValue
                : false;
        case 'list':
            return [];
        case 'decimal':
        case 'text':
        default:
            return metadata.defaultValue ?? '';
    }
}

    return {
        extractStoragePathFromData,
        resolvePolicyPath,
        normalizePolicyEntries,
        getEnumDefaultValue,
        isPlainObject,
        normalizeAdmxState,
        getDefaultControlValue,
    };
});
