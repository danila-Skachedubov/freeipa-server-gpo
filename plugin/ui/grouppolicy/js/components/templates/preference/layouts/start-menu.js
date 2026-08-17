define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.element' },
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.pinCCPN' },
            { field: 'properties.pinHelp' },
            { field: 'properties.pinNetwork' },
            { field: 'properties.pinSystem' },
            { field: 'properties.pinDefault' },
            { field: 'properties.largeMSC' }
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
