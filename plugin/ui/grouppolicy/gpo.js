define([
    'require',
    'freeipa/ipa',
    'freeipa/phases',
    'freeipa/reg',
    'freeipa/navigation',
    'freeipa/rpc',
    './js/locales/translations'
], function(require, IPA, phases, reg, navigation, rpc, translationsModule) {

    var exp = IPA.gpo = {};

    translationsModule.setLanguage((navigator.language || 'en').slice(0, 2).toLowerCase());
    var t = translationsModule.t;

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

    var order_control_buttons = exp.order_control_buttons = function(order) {
        return function(spec) {
            var rank = {};
            order.forEach(function(name, i) { rank[name] = i; });
            spec.control_buttons.sort(function(a, b) {
                var ra = rank[a.name] !== undefined ? rank[a.name] : order.length;
                var rb = rank[b.name] !== undefined ? rank[b.name] : order.length;
                return ra - rb;
            });
            return spec;
        };
    };

    var make_gpo_spec = function() {
        return {
            name: 'gpo',
            facet_groups: ['settings'],
            facets: [
                {
                    $type: 'search',
                    name: 'search',
                    title: t('gpo.title'),
                    label: t('gpo.title'),
                    $pre_ops: [order_control_buttons(['refresh', 'add', 'gpui', 'remove'])],
                    columns: [
                        {
                            name: 'displayname',
                            label: t('gpo.fields.policyName'),
                            primary_key: true
                        },
                        {
                            name: 'cn',
                            label: t('gpo.fields.guid')
                        },
                        {
                            name: 'versionnumber',
                            label: t('gpo.fields.version')
                        },
                        {
                            name: 'flags',
                            label: t('gpo.fields.flags')
                        }
                    ],
                    actions: ['gpui'],
                    control_buttons: [
                        {
                            name: 'gpui',
                            label: t('common.edit'),
                            icon: 'fa-pencil'
                        }
                    ]
                },
                {
                    $type: 'details',
                    name: 'details',
                    title: t('gpo.titleSingular'),
                    label: t('gpo.titleSingular'),
                    check_rights: false,
                    $pre_ops: [order_control_buttons(['refresh', 'gpui', 'save', 'revert'])],
                    actions: ['gpo_save', 'revert', 'refresh', 'gpui'],
                    sections: [
                        {
                            name: 'identity',
                            label: t('gpo.fields.identity'),
                            fields: [
                                {
                                    name: 'displayname',
                                    label: t('gpo.fields.policyName'),
                                    read_only: false
                                },
                                {
                                    name: 'cn',
                                    label: t('gpo.fields.guid'),
                                    read_only: true
                                },
                                {
                                    name: 'distinguishedname',
                                    label: t('gpo.fields.distinguishedName'),
                                    read_only: true
                                },
                                {
                                    name: 'versionnumber',
                                    label: t('gpo.fields.versionNumber'),
                                    read_only: true
                                },
                                {
                                    name: 'flags',
                                    label: t('gpo.fields.flags')
                                }
                            ]
                        }
                    ],
                    control_buttons: [
                        {
                            name: 'gpui',
                            label: t('common.edit'),
                            icon: 'fa-pencil'
                        }
                    ]
                }
            ],
            adder_dialog: {
                title: t('gpo.addTitle'),
                fields: [
                    {
                        name: 'displayname',
                        label: t('gpo.fields.policyName'),
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
        spec.label = spec.label || t('common.save');
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
                IPA.notify(t('gpo.noChanges'), 'info');
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
                    var success_msg = t('gpo.updatedSuccessfully').replace('%s', gpo_name);
                    if (mod_data.rename) {
                        success_msg = t('gpo.renamedSuccessfully')
                            .replace('%s', gpo_name)
                            .replace('%s', mod_data.rename);
                    }
                    IPA.notify_success(success_msg);
                    if (on_success) on_success(mod_result);
                },
                on_error: function(xhr, text_status, error_thrown) {
                    var msg = t('gpo.updateFailed');
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
        spec.label = spec.label || t('common.edit');
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
                IPA.notify(t('gpo.cannotDetermineName'), 'error');
                return;
            }

            var backdrop = $('<div class="modal-backdrop fade modal-gpui-backdrop"></div>');
            var modal = $(
                '<div class="modal fade modal-gpui" style="display:block;" tabindex="-1" role="dialog">' +
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
                modal.removeClass('in');
                backdrop.removeClass('in');
                setTimeout(function() {
                    modal.remove();
                    backdrop.remove();
                    facet.refresh();
                }, 500);
            };

            modal.find('.close').on('click', close_modal);
            //modal.find('.btn-close-modal').on('click', close_modal);
            backdrop.on('click', close_modal);

            modal.find('.modal-title').text('GPUI | ' + policyName);

            $('body').append(backdrop).append(modal);
            void modal[0].offsetHeight;
            modal.addClass('in');
            backdrop.addClass('in');

            require(['./js/app'], function(app) {
                if (app && typeof app.init === 'function') {
                    app.init({
                        containerId: 'gp__container',
                        policyName: policyName,
                        path: '/'
                    });
                    return;
                }

                IPA.notify(t('gpo.gpuiInitializeFailed'), 'error');
            }, function(err) {
                IPA.notify(t('gpo.gpuiLoadFailed'), 'error');
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
