define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.name' },
            { field: 'properties.path' },
            { line: true },
            { field: 'properties.allRegular' },
            { field: 'properties.allHidden' },
            { field: 'properties.allAdminDrive' },
            { line: true },
            { field: 'properties.limitUsers' },
            { field: 'properties.userLimit' },
            { field: 'properties.abe' }
        ],
        general: [
            { field: 'properties.comment', textarea: true },
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'properties.disabled' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general',
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.path',      labelKey: 'columnPath' },
            { source: 'field', field: 'properties.userLimit', labelKey: 'columnUserLimit' },
            { source: 'field', field: 'properties.abe',       labelKey: 'columnAbe' }
        ]
    };
});
