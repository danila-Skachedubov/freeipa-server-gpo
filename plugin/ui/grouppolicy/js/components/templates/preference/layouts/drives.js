define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.path' },
            { field: 'properties.thisDrive' },
            { field: 'properties.allDrives' },
            { line: true },
            { field: 'properties.userName' },
            { field: 'properties.label' },
            { line: true },
            { field: 'properties.persistent' },
            { field: 'properties.useLetter' },
            { field: 'properties.letter' }
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
