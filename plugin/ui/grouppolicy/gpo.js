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

    // Список позиций (entity|new_pkey -> индекс в родительском списке),
    // которые нужно восстановить после переименования.
    var pending_rename_positions = exp.pending_rename_positions = {};

    var get_pkey_name = exp.get_pkey_name = function(facet) {
        if (facet.managed_entity && facet.managed_entity.metadata) {
            return facet.managed_entity.metadata.primary_key;
        }
        return facet.primary_key_name || 'cn';
    };

    var get_record_pkey = exp.get_record_pkey = function(record, pkey_name) {
        if (!record) return null;
        var value = record[pkey_name];
        if (Array.isArray(value) && value.length) value = value[0];
        if (value === null || value === undefined) value = '';
        return String(value);
    };

    // Извлекает упорядоченный список цепочек из gpmaster.show.
    exp.get_chainlist = function(data) {
        var value = data && data.result && data.result.chainlist;
        if (value === null || value === undefined) return [];
        if (Array.isArray(value)) {
            return value.map(function(item) { return String(item); });
        }
        return [String(value)];
    };

    // Запоминает индекс строки с old_name в родительском списке (search-фасет).
    // Нужно вызывать ДО успешного переименования, пока старые записи ещё в списке.
    exp.capture_rename_position = function(facet, entity_name, old_name, new_name) {
        if (!facet || !facet.entity || !new_name) return;
        var search_facet = facet.entity.get_facet('search');
        if (!search_facet || !search_facet.table || !search_facet.table.records) return;

        var pkey_name = get_pkey_name(search_facet);
        var records = search_facet.table.records;
        for (var i = 0; i < records.length; i++) {
            if (get_record_pkey(records[i], pkey_name) === String(old_name)) {
                pending_rename_positions[entity_name + '|' + new_name] = i;
                return;
            }
        }
    };

    exp.clear_rename_position = function(entity_name, new_name) {
        delete pending_rename_positions[entity_name + '|' + new_name];
    };

    exp.rename_position_policy = function(spec) {
        spec = spec || {};
        var that = IPA.facet_policy(spec);
        var sort_key = spec.sort_key;

        that.sort_records = function(facet, records) {
            if (!sort_key) return;
            var key_func;
            if (typeof sort_key === 'function') {
                key_func = function(record, pkey_name) {
                    var key = sort_key(record, pkey_name);
                    if (key === null || key === undefined) key = '';
                    return String(key);
                };
            } else {
                key_func = function(record, pkey_name) {
                    var value = record[sort_key];
                    if (Array.isArray(value) && value.length) value = value[0];
                    if (value === null || value === undefined) value = '';
                    return String(value);
                };
            }

            var pkey_name = get_pkey_name(facet);
            var order = [];
            var i;
            for (i = 0; i < records.length; i++) order.push(i);
            order.sort(function(a, b) {
                var ka = key_func(records[a], pkey_name);
                var kb = key_func(records[b], pkey_name);
                if (ka < kb) return -1;
                if (ka > kb) return 1;
                return 0;
            });

            var sorted = true;
            for (i = 0; i < order.length; i++) {
                if (order[i] !== i) {
                    sorted = false;
                    break;
                }
            }
            if (sorted) return;

            var sorted_records = [];
            for (i = 0; i < order.length; i++) {
                sorted_records.push(records[order[i]]);
            }
            for (i = 0; i < records.length; i++) {
                records[i] = sorted_records[i];
            }

            var tbody = facet.table.tbody;
            var trs = tbody.children('tr');
            for (i = 0; i < order.length; i++) {
                tbody.append(trs.eq(order[i]));
            }
        };

        that.post_load = function() {
            var facet = that.container;
            if (!facet || !facet.entity || !facet.table) return;
            if (!facet.table.records || !facet.table.tbody) return;

            var entity_name = facet.entity.name;
            var pkey_name = get_pkey_name(facet);
            var records = facet.table.records;
            var tbody = facet.table.tbody;
            var pending = pending_rename_positions;

            // При pagination:false список грузится в серверном порядке,
            // поэтому алфавитный порядок поддерживаем здесь.
            that.sort_records(facet, records);

            var has_pending = false;
            for (var key in pending) {
                if (!Object.prototype.hasOwnProperty.call(pending, key)) continue;
                var sep = key.indexOf('|');
                if (sep < 0) continue;
                if (key.substring(0, sep) !== entity_name) continue;
                has_pending = true;
            }

            if (!has_pending) return;

            var positions = {};
            var order = [];
            for (var key in pending) {
                if (!Object.prototype.hasOwnProperty.call(pending, key)) continue;
                var sep = key.indexOf('|');
                if (sep < 0 || key.substring(0, sep) !== entity_name) continue;
                positions[key.substring(sep + 1)] = pending[key];
                order.push(key);
            }

            for (var j = 0; j < order.length; j++) {
                var this_key = order[j];
                var this_sep = this_key.indexOf('|');
                var new_name = this_key.substring(this_sep + 1);
                var target = positions[new_name];

                var idx = -1;
                for (var i = 0; i < records.length; i++) {
                    if (get_record_pkey(records[i], pkey_name) === String(new_name)) {
                        idx = i;
                        break;
                    }
                }
                if (idx < 0 || idx === target) continue;

                var row = records[idx];
                records.splice(idx, 1);
                if (target > records.length) target = records.length;
                records.splice(target, 0, row);

                var tr = tbody.children('tr').eq(idx);
                if (tr.length) {
                    if (target === 0) {
                        tbody.prepend(tr);
                    } else {
                        tr.insertAfter(tbody.children('tr').eq(target - 1));
                    }
                }
                delete pending[this_key];
            }
        };

        return that;
    };

    // После успешного переименования на details-фасете переключает
    // первичный ключ и URL на новое имя без полной перезагрузки.
    exp.handle_rename_success = function(facet, entity_name, new_name) {
        if (!facet) return;

        if (facet.name === 'details') {
            if (facet.set_pkeys) facet.set_pkeys([new_name]);

            // Заголовок (h1 .facet-pkey) и хлебные крошки.
            if (facet.header && facet.header.set_pkey) {
                facet.header.set_pkey(new_name);
            }

            // Протухаем родительский search штатной details_facet_update_policy.
            if (facet.on_update) facet.on_update.notify();

            // Принудительно обновляем таблицу search в фоне, чтобы при
            // возврате в список отображалось новое имя без перезагрузки.
            var search_facet = facet.entity && facet.entity.get_facet
                ? facet.entity.get_facet('search') : null;
            if (search_facet && search_facet.refresh) {
                search_facet.refresh();
            }

            var hash = navigation.get_entity_hash(entity_name, 'details', [new_name]);
            if (hash) {
                window.location.hash = hash;
            }
            return;
        }

        if (facet.refresh) facet.refresh();
    };

    // Подменяет серверный pattern_errmsg у перечисленных полей details-фасета
    // на локализованный текст.
    exp.pattern_error_policy = function(spec) {
        spec = spec || {};
        var that = IPA.facet_policy(spec);
        var names = spec.fields || [];

        var apply = function() {
            var facet = that.container;
            if (!facet || !facet.fields || !facet.fields.get_field) return;
            for (var i = 0; i < names.length; i++) {
                var field = facet.fields.get_field(names[i]);
                if (field && field.metadata && field.metadata.pattern && field.metadata.pattern_errmsg) {
                    field.metadata.pattern_errmsg = spec.message;
                }
            }
        };

        that.post_create = apply;
        that.post_load = apply;
        return that;
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
                    no_update: true,
                    $pre_ops: [order_control_buttons(['refresh', 'gpui', 'save', 'revert'])],
                    actions: ['gpo_save', 'gpui'],
                    policies: [
                        {
                            $factory: exp.pattern_error_policy,
                            fields: ['displayname'],
                            message: t('gpo.patternError')
                        }
                    ],
                    sections: [
                        {
                            name: 'identity',
                            label: t('gpo.fields.identity'),
                            fields: [
                                {
                                    name: 'displayname',
                                    label: t('gpo.fields.policyName'),
                                    read_only: false,
                                    check_writable_from_metadata: false
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
                            name: 'save',
                            action: 'gpo_save',
                            label: '@i18n:buttons.save',
                            icon: 'fa-upload'
                        },
                        {
                            name: 'revert',
                            label: '@i18n:buttons.revert',
                            icon: 'fa-undo'
                        },
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
            if (!facet.validate()) {
                facet.show_validation_error();
                return;
            }

            var dn_field = facet.get_field('displayname');

            if (dn_field.dirty && dn_field.is_editable()) {
                var new_values = dn_field.get_widget_values();
                var old_value = String(facet.get_pkey());
                var new_value = String(new_values.length ? new_values[0] : '');
                var new_name = new_value.trim();
                var is_rename = new_value.trim() !== '' && new_value.trim() !== old_value;

                if (is_rename) {
                    // Reuse the standard details command so every other dirty
                    // field is saved in the same request. The standard command
                    // builder intentionally skips the primary key, therefore
                    // the rename option is added explicitly.
                    var command = facet.create_update_command();
                    command.set_option('rename', new_name);

                    command.on_success = function(data) {
                        // displayName is the API key, while the LDAP RDN is the
                        // stable GPO GUID. Switch the facet key and load the
                        // server response to reset dirty/pristine field state.
                        facet.set_pkeys([new_name]);
                        facet.load(data);
                        facet.on_update.notify();

                        var msg = t('gpo.renamedSuccessfully')
                            .replace('%s', old_value)
                            .replace('%s', new_name);
                        IPA.notify_success(msg);

                        navigation.show_entity(
                            facet.entity.name,
                            facet.name,
                            [new_name]
                        );

                        if (on_success) on_success(data);
                    };

                    command.on_error = function(xhr, text_status, error_thrown) {
                        var msg = t('gpo.updateFailed');
                        if (error_thrown && error_thrown.message) {
                            msg += ': ' + error_thrown.message;
                        }
                        IPA.notify(msg, 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    };

                    command.execute();
                    return;
                }
            }

            // Нет переименования — обычное обновление details-фасета
            facet.update(on_success, on_error);
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
