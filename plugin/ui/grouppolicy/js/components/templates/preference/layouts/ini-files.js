define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.path' },
            { line: true },
            { field: 'properties.section' },
            { field: 'properties.property' },
            { field: 'properties.value' }
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
            { field: 'properties.section', enabledWhen: [
                { source: 'properties.path', nonEmpty: true }
            ] },
            { field: 'properties.property', enabledWhen: [
                { source: 'properties.section', nonEmpty: true }
            ] },
            { field: 'properties.value', enabledWhen: [
                { source: 'properties.property', nonEmpty: true },
                { source: 'properties.action', notEquals: 'delete' }
            ] }
        ],
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.path',     labelKey: 'columnPath' },
            { source: 'field', field: 'properties.section',  labelKey: 'columnSection' },
            { source: 'field', field: 'properties.property', labelKey: 'columnProperty' },
            { source: 'field', field: 'properties.value',    labelKey: 'columnValue' }
        ]
    };
});
