define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.deviceName' },
            { field: 'properties.deviceAction' },
            { line: true },
            { field: 'properties.deviceId' },
            { field: 'properties.deviceClass' },
            { field: 'properties.classGuid' }
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
