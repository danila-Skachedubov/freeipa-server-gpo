define([
    'require',
    'freeipa/ipa',
    'freeipa/phases',
    'freeipa/reg',
    'freeipa/navigation',
    'freeipa/rpc'
], function(require, IPA, phases, reg, navigation, rpc) {

    var exp = IPA.gpo = {};

    (function loadCSS() {
        var files = [
            'js/plugins/chain/css/main.css',
            'js/plugins/chain/css/other.css'
        ];
        files.forEach(function(href) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = href;
            document.head.appendChild(link);
        });
    })();

    var make_gpo_spec = function() {
        return {
            name: 'gpo',
            facet_groups: ['settings'],
            facets: [
                {
                    $type: 'search',
                    name: 'search',
                    label: 'Group Policy Objects',
                    columns: [
                        {
                            name: 'displayname',
                            label: 'Policy Name',
                            primary_key: true
                        },
                        {
                            name: 'cn',
                            label: 'GUID'
                        },
                        {
                            name: 'versionnumber',
                            label: 'Version'
                        },
                        {
                            name: 'flags',
                            label: 'Flags'
                        }
                    ],
                    actions: ['gpui'],
                    control_buttons: [
                        {
                            name: 'gpui',
                            label: 'GPUI',
                            icon: 'fa-external-link'
                        }
                    ]
                },
                {
                    $type: 'details',
                    name: 'details',
                    check_rights: false,
                    actions: ['gpo_save', 'revert', 'refresh', 'gpui'],
                    sections: [
                        {
                            name: 'identity',
                            label: 'Identity',
                            fields: [
                                {
                                    name: 'displayname',
                                    label: 'Policy Name',
                                    read_only: false
                                },
                                {
                                    name: 'cn',
                                    label: 'GUID',
                                    read_only: true
                                },
                                {
                                    name: 'distinguishedname',
                                    label: 'Distinguished Name',
                                    read_only: true
                                },
                                {
                                    name: 'versionnumber',
                                    label: 'Version Number',
                                    read_only: true
                                },
                                {
                                    name: 'flags',
                                    label: 'Flags'
                                }
                            ]
                        }
                    ],
                    control_buttons: [
                        {
                            name: 'gpui',
                            label: 'GPUI',
                            icon: 'fa-external-link'
                        }
                    ]
                }
            ],
            adder_dialog: {
                title: 'Add Group Policy Object',
                fields: [
                    {
                        name: 'displayname',
                        label: 'Policy Name',
                        required: true
                    }
                ]
            }
        };
    };

    exp.gpo_entity_spec = make_gpo_spec();

    exp.save_action = function(spec) {
        spec = spec || {};
        spec.name = spec.name || 'gpo_save';
        spec.label = spec.label || 'Save';
        spec.enable_cond = spec.enable_cond || ['dirty'];
        spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

        var that = IPA.action(spec);

        that.execute_action = function(facet, on_success, on_error) {
            // Get current values from facet
            var values = facet.get_values();
            var original_values = facet.get_original_values();

            var mod_data = {};
            var has_changes = false;

            var current_displayname = String(original_values.displayname || '').trim();
            var new_displayname = String(values.displayname || '').trim();

            if (new_displayname && new_displayname !== current_displayname) {
                mod_data.rename = new_displayname;
                has_changes = true;
            }

            var current_flags = parseInt(original_values.flags || 0, 10);
            var new_flags = parseInt(values.flags || 0, 10);
            if (Number.isFinite(new_flags) && new_flags !== current_flags) {
                mod_data.flags = new_flags;
                has_changes = true;
            }

            if (!has_changes) {
                IPA.notify('No changes made', 'info');
                if (on_success) on_success();
                return;
            }

            // Get the GPO name (primary key)
            var gpo_name = facet.entity.get_primary_key(original_values);

            // Execute modify command
            var mod_command = rpc.command({
                entity: 'gpo',
                method: 'mod',
                args: [gpo_name],
                options: mod_data,
                on_success: function(mod_result) {
                    facet.refresh();
                    var success_msg = 'GPO "' + gpo_name + '" updated successfully';
                    if (mod_data.rename) {
                        success_msg = 'GPO renamed from "' + gpo_name + '" to "' + mod_data.rename + '" successfully';
                    }
                    IPA.notify_success(success_msg);
                    if (on_success) on_success(mod_result);
                },
                on_error: function(xhr, text_status, error_thrown) {
                    var msg = 'Failed to update GPO';
                    if (error_thrown && error_thrown.message) {
                        msg += ': ' + error_thrown.message;
                    }
                    IPA.notify(msg, 'error');
                    if (on_error) on_error(xhr, text_status, error_thrown);
                }
            });
            mod_command.execute();
        };

        return that;
    };

        exp.gpui_action = function(spec) {
        spec = spec || {};
        spec.name = spec.name || 'gpui';
        spec.label = spec.label || 'GPUI';
        spec.enable_cond = spec.enable_cond || [];

        var that = IPA.action(spec);

        that.execute_action = function(facet) {
            var policyName;

            if (typeof facet.get_selected_values === 'function') {
                var selected = facet.get_selected_values();
                if (selected && selected.length === 1) {
                    policyName = selected[0];
                }
            }

            if (!policyName && typeof facet.get_original_values === 'function') {
                var values = facet.get_original_values();
                if (values) {
                    policyName = values.displayname || facet.entity.get_primary_key(values);
                }
            }

            if (!policyName) {
                var hash = window.location.hash;
                var parts = hash.split('/');
                var idx = parts.indexOf('gpo');
                if (idx >= 0 && parts[idx + 2]) {
                    policyName = decodeURIComponent(parts[idx + 2]);
                }
            }

            if (!policyName) {
                IPA.notify('Cannot determine GPO name', 'error');
                return;
            }

            var backdrop = $('<div class="modal-backdrop fade in"></div>');
            var modal = $(
                '<div class="modal fade in modal-gpui" style="display:block;" tabindex="-1" role="dialog">' +
                    '<div class="modal-dialog" role="document">' +
                        '<div class="modal-content">' +
                            '<div class="modal-header">' +
                                '<button type="button" class="close" aria-label="Close">' +
                                    '<span aria-hidden="true">&times;</span>' +
                                '</button>' +
                                 '<h4 class="modal-title"></h4>' +
                            '</div>' +
                            '<div class="modal-body">' +
                                '<div id="gp__container" class="gp__container"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>'
            );

            var close_modal = function() {
                modal.remove();
                backdrop.remove();
                facet.refresh();
            };

            modal.find('.close').on('click', close_modal);
            //modal.find('.btn-close-modal').on('click', close_modal);
            backdrop.on('click', close_modal);

            modal.find('.modal-title').text('GPUI | ' + policyName);

            $('body').append(backdrop).append(modal);

            require(['./js/app'], function(app) {
                if (app && typeof app.init === 'function') {
                    app.init({
                        containerId: 'gp__container',
                        policyName: policyName,
                        path: '/'
                    });
                    return;
                }

                IPA.notify('Failed to initialize GPUI module', 'error');
            }, function(err) {
                IPA.notify('Failed to load GPUI module', 'error');
                if (window.console && console.error) {
                    console.error('[gpui] Failed to load app module.', err);
                }
            });
        };

        return that;
    };

    exp.register = function() {
        var e = reg.entity;
        var a = reg.action;

        a.register('gpo_save', exp.save_action);
        a.register('gpui', exp.gpui_action);
        e.register({type: 'gpo', spec: exp.gpo_entity_spec});
    };

    phases.on('registration', exp.register);

    return exp;
});
