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
        filters: 'general',
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.deviceClass', labelKey: 'columnDeviceClass' },
            { source: 'field', field: 'properties.deviceId',    labelKey: 'columnDeviceId' }
        ]
    };
});
