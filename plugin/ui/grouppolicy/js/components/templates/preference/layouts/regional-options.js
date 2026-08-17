define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.systemLocale' },
            { field: 'properties.userLocale' },
            { line: true },
            { field: 'properties.inputLocale' },
            { field: 'properties.userInputLocale' }
        ],
        general: [
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general'
    };
});
