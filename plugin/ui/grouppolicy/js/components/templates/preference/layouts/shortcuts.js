define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.targetType' },
            { field: 'properties.shortcutPath' },
            { line: true },
            { field: 'properties.targetPath' },
            { field: 'properties.arguments' },
            { line: true },
            { field: 'properties.iconPath' },
            { field: 'properties.iconIndex' },
            { line: true },
            { field: 'properties.startIn' },
            { field: 'properties.shortcutKey' },
            { field: 'properties.run' }
        ],
        general: [
            { field: 'properties.comment', textarea: true },
            { field: 'metadata.bypassErrors' },
            { field: 'metadata.userContext' },
            { field: 'metadata.removePolicy' },
            { field: 'properties.disabled' },
            { field: 'metadata.desc', textarea: true }
        ],
        filters: 'general',
        dependencies: [
            { field: 'properties.targetPath', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.arguments', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' },
                { source: 'properties.targetType', notIn: ['URL', 'SHELL'] }
            ] },
            { field: 'properties.iconPath', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.iconIndex', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' },
                { source: 'properties.iconPath', nonEmpty: true },
                { source: 'properties.iconPath', suffix: '.dll' }
            ] },
            { field: 'properties.startIn', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' },
                { source: 'properties.targetType', notIn: ['URL', 'SHELL'] }
            ] },
            { field: 'properties.shortcutKey', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.run', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' },
                { source: 'properties.targetType', notEquals: 'URL' }
            ] },
            { field: 'properties.comment', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' },
                { source: 'properties.targetType', notEquals: 'URL' }
            ] }
        ],
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.shortcutPath', labelKey: 'columnShortcutPath' }
        ]
    };
});
