define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.dsn' },
            { field: 'properties.driver' },
            { field: 'properties.description' },
            { field: 'properties.server' },
            { field: 'properties.database' },
            { line: true },
            { field: 'properties.lastUser' },
            { field: 'properties.username' }
        ],
        general: [
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'properties.disabled' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general',
        dependencies: [
            { field: 'properties.dsn', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.username', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] }
        ],
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.driver',   labelKey: 'columnDriver' },
            { source: 'field', field: 'properties.server',   labelKey: 'columnServer' },
            { source: 'field', field: 'properties.database', labelKey: 'columnDatabase' }
        ]
    };
});
