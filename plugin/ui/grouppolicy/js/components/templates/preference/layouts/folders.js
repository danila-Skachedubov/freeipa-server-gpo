define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.path' },
            { line: true },
            { field: 'properties.readOnly' },
            { field: 'properties.archive' },
            { field: 'properties.hidden' },
            { line: true },
            { field: 'properties.deleteReadOnly' },
            { field: 'properties.deleteAll' },
            { field: 'properties.deleteSubFolders' }
        ],
        general: [
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
            { source: 'field', field: 'properties.path',   labelKey: 'columnPath' }
        ]
    };
});
