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
        filters: 'general'
    };
});
