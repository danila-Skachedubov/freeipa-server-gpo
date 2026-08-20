define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.element' },
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.userName' },
            { field: 'properties.newName' },
            { field: 'properties.fullName' },
            { field: 'properties.description' },
            { line: true },
            { field: 'properties.changeLogon' },
            { field: 'properties.noChange' },
            { field: 'properties.neverExpires' },
            { field: 'properties.acctDisabled' },
            { field: 'properties.expires' }
        ],
        general: [
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general',
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.userName', labelKey: 'columnUserName' }
        ]
    };
});
