define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.element' },
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.name' },
            { field: 'properties.appName' },
            { field: 'properties.args' },
            { field: 'properties.startIn' },
            { field: 'properties.comment' },
            { line: true },
            { field: 'properties.runAs' },
            { field: 'properties.enabled' },
            { field: 'properties.deleteWhenDone' },
            { line: true },
            { field: 'properties.startOnlyIfIdle' },
            { field: 'properties.stopOnIdleEnd' },
            { field: 'properties.noStartIfOnBatteries' },
            { field: 'properties.stopIfGoingOnBatteries' },
            { field: 'properties.systemRequired' },
            { field: 'properties.maxRunTime' },
            { field: 'properties.idleMinutes' },
            { field: 'properties.deadlineMinutes' }
        ],
        general: [],
        filters: 'basic'
    };
});
