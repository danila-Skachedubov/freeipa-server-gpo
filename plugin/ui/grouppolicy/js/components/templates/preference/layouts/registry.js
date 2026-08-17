define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.hive' },
            { field: 'properties.key' },
            { line: true },
            { field: 'properties.name' },
            { field: 'properties.type' },
            { field: 'properties.value' },
            { line: true },
            { field: 'properties.default' },
            { field: 'properties.displayDecimal' },
            { field: 'properties.defaultValue' },
            { field: 'properties.bitfield' }
        ],
        general: [
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'properties.disabled' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general'
    };
});
