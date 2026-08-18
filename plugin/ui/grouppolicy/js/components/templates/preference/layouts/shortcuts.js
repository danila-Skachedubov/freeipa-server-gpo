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
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.shortcutPath', labelKey: 'columnShortcutPath' }
        ]
    };
});
