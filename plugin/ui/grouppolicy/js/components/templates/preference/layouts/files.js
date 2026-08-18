define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.fromPath' },
            { field: 'properties.targetPath' },
            { line: true },
            { field: 'properties.readOnly' },
            { field: 'properties.archive' },
            { field: 'properties.hidden' },
            { field: 'properties.suppress' },
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
            { source: 'field', field: 'properties.fromPath',   labelKey: 'columnSourcePath' },
            { source: 'field', field: 'properties.targetPath', labelKey: 'columnTargetPath' }
        ]
    };
});
