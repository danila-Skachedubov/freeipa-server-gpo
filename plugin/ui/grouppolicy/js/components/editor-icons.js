/** Semantic, presentation-only icons shared by the tree and editor catalogs. */
define([], function() {
    'use strict';

    var preferences = Object.freeze({
        applications: 'applications', control_panel: 'components',
        data_sources: 'database', devices: 'device', drives: 'drive',
        environment_variables: 'environment', files: 'files',
        folder_options: 'folder-settings', folders: 'folder', ini_files: 'ini',
        internet_settings: 'browser', local_users_and_groups: 'users',
        network_options: 'network', network_shares: 'shared-folder',
        power_options: 'power', printers: 'printer', regional_options: 'globe',
        registry: 'registry', scheduled_tasks: 'scheduled-task',
        services: 'services', shortcuts: 'shortcut', start_menu: 'start-menu'
    });
    var targeting = Object.freeze({
        battery: 'battery', computer: 'computer', cpu: 'cpu', date: 'calendar',
        disk: 'drive', domain: 'domain', dun: 'connection', file: 'file-match',
        ip_range: 'ip-range', language: 'language', ldap: 'directory-query',
        mac_range: 'network-card', msi: 'package-query', org_unit: 'org-unit',
        pcmcia: 'expansion-card', portable: 'laptop', proc_mode: 'processing',
        ram: 'memory', run_once: 'run-once', site: 'site', terminal: 'terminal',
        time: 'clock', user: 'user', variable: 'environment', os: 'system',
        registry: 'registry', wmi: 'system-query', group: 'security-group',
        collection: 'collection'
    });
    var categories = Object.freeze({
        system_settings: 'system-settings', control_panel_settings: 'components',
        other_settings: 'other-settings'
    });
    var scriptEvents = Object.freeze({
        startup: 'script-start', shutdown: 'script-stop',
        logon: 'script-logon', logoff: 'script-logoff'
    });

    function icon(name) { return 'gpo-icon gpo-icon-' + name; }
    function mapped(table, key, fallback) {
        return icon(Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback);
    }

    return Object.freeze({
        preferenceKinds: Object.freeze(Object.keys(preferences)),
        targetingKinds: Object.freeze(Object.keys(targeting)),
        preference: function(kind) { return mapped(preferences, kind, 'preferences'); },
        preferenceCategory: function(category) { return mapped(categories, category, 'other-settings'); },
        preferencesRoot: function() { return icon('preferences'); },
        targeting: function(kind) { return mapped(targeting, kind, 'filter-unknown'); },
        scripts: function() { return icon('script'); },
        scriptEvent: function(event) { return mapped(scriptEvents, event, 'script'); },
        scriptFile: function(group) { return icon(group === 'powershell' ? 'powershell' : 'script'); }
    });
});
