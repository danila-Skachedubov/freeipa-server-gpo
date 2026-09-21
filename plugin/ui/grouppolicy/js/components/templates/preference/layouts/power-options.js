define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.element' },
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.name' }
        ],
        general: [],
        filters: 'basic',
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' }
        ]
    };
});
