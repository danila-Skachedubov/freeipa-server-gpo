define([], function() {
    "use strict";

    return {
        basic: [
            { field: 'properties.element' },
            { field: 'properties.action' },
            { line: true },
            { field: 'properties.user' },
            { field: 'properties.name' },
            { field: 'properties.ipAddress' },
            { field: 'properties.useDNS' },
            { field: 'properties.useIPv6' },
            { line: true },
            { field: 'properties.dialFirst' },
            { field: 'properties.trayIcon' },
            { field: 'properties.showProgress' },
            { field: 'properties.showPassword' },
            { field: 'properties.showDomain' },
            { field: 'properties.redialCount' },
            { field: 'properties.redialPause' },
            { field: 'properties.idleDisconnect' },
            { field: 'properties.reconnect' },
            { line: true },
            { field: 'properties.customSettings' },
            { field: 'properties.securePassword' },
            { field: 'properties.secureData' },
            { field: 'properties.useLogon' },
            { field: 'properties.vpnStrategy' },
            { field: 'properties.encryptionType' },
            { line: true },
            { field: 'properties.eap' },
            { field: 'properties.pap' },
            { field: 'properties.spap' },
            { field: 'properties.chap' },
            { field: 'properties.msChap' },
            { field: 'properties.oldMsChap' },
            { field: 'properties.msChapV2' }
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
            { field: 'properties.ipAddress', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.useDNS', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.useIPv6', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.dialFirst', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.trayIcon', enabledWhen: [
                { source: 'properties.action', notEquals: 'delete' }
            ] },
            { field: 'properties.eap', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] },
            { field: 'properties.pap', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] },
            { field: 'properties.spap', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] },
            { field: 'properties.chap', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] },
            { field: 'properties.msChap', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] },
            { field: 'properties.oldMsChap', enabledWhen: [
                { source: 'properties.customSettings', equals: true },
                { source: 'properties.msChap', equals: true }
            ] },
            { field: 'properties.msChapV2', enabledWhen: [
                { source: 'properties.customSettings', equals: true }
            ] }
        ],
        columns: [
            { source: 'name',  labelKey: 'columnName' },
            { source: 'order', labelKey: 'columnOrder' },
            { source: 'field', field: 'properties.action', labelKey: 'columnAction', format: 'action' },
            { source: 'field', field: 'properties.ipAddress', labelKey: 'columnIpAddress' }
        ]
    };
});
