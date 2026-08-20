define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.serviceName' },
            { field: 'properties.startupType' },
            { field: 'properties.serviceAction' },
            { line: true },
            { field: 'properties.timeout' },
            { field: 'properties.accountName' },
            { field: 'properties.interact' },
            { line: true },
            { field: 'properties.firstFailure' },
            { field: 'properties.secondFailure' },
            { field: 'properties.thirdFailure' },
            { line: true },
            { field: 'properties.resetFailCountDelay' },
            { field: 'properties.restartServiceDelay' },
            { field: 'properties.restartComputerDelay' },
            { field: 'properties.restartComputerMessage' },
            { line: true },
            { field: 'properties.program' },
            { field: 'properties.args' },
            { field: 'properties.append' }
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
            { source: 'field', field: 'properties.startupType',   labelKey: 'columnStartupType' },
            { source: 'field', field: 'properties.serviceAction', labelKey: 'columnServiceAction' }
        ]
    };
});
