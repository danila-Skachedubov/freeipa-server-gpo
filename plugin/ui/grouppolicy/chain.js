define(
    [
        'freeipa/ipa',
        'freeipa/menu',
        'freeipa/phases',
        'freeipa/reg',
        'freeipa/rpc',
        'freeipa/jquery',
        './gpo',
        './js/locales/translations',
        'freeipa/text'
    ],
    function(IPA, menu, phases, reg, rpc, $, gpo_module, translationsModule, text) {

        var exp = IPA.grouppolicy = {};

        var t = translationsModule.t;

        exp.enable_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'enable';
            spec.label = spec.label || t('chain.enable');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : true;
            spec.confirm_msg = spec.confirm_msg || t('chain.enableConfirm');

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneChainEnable'), 'error');
                    return;
                }

                var chain_name = selected[0];

                var command = rpc.command({
                    entity: 'chain',
                    method: 'enable',
                    args: [chain_name],
                    options: {
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.enabledSuccessfully').replace('%s', chain_name));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = t('chain.enableFailed');
                        if (error_thrown && error_thrown.message) {
                            msg += ': ' + error_thrown.message;
                        }
                        IPA.notify(msg, 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.disable_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'disable';
            spec.label = spec.label || t('chain.disable');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : true;
            spec.confirm_msg = spec.confirm_msg || t('chain.disableConfirm');

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneChainDisable'), 'error');
                    return;
                }

                var chain_name = selected[0];

                var command = rpc.command({
                    entity: 'chain',
                    method: 'disable',
                    args: [chain_name],
                    options: {
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.disabledSuccessfully').replace('%s', chain_name));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = t('chain.disableFailed');
                        if (error_thrown && error_thrown.message) {
                            msg += ': ' + error_thrown.message;
                        }
                        IPA.notify(msg, 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.move_up_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'move_up';
            spec.label = spec.label || t('chain.moveUp');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneChainMove'), 'error');
                    return;
                }

                var chain_name = selected[0];

                var command = rpc.command({
                    entity: 'gpmaster',
                    method: 'mod',
                    options: {
                        'moveup_chain': chain_name,
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.movedUpSuccessfully'));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        IPA.notify(t('chain.moveUpFailed').replace('%s', error_thrown.message || text_status), 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.move_down_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'move_down';
            spec.label = spec.label || t('chain.moveDown');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneChainMove'), 'error');
                    return;
                }

                var chain_name = selected[0];

                var command = rpc.command({
                    entity: 'gpmaster',
                    method: 'mod',
                    options: {
                        'movedown_chain': chain_name,
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.movedDownSuccessfully'));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        IPA.notify(t('chain.moveDownFailed').replace('%s', error_thrown.message || text_status), 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.move_gpc_up_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'move_gpc_up';
            spec.label = spec.label || t('chain.moveGpcUp');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneGpc'), 'error');
                    return;
                }

                var gpc_name = selected[0];
                var hash = window.location.hash;
                var pkey;
                var parts = hash.split('/');

                var chainIndex = parts.indexOf('chain');
                if (chainIndex >= 0 && parts[chainIndex + 1] === 'gpo' && parts[chainIndex + 2]) {
                    pkey = parts[chainIndex + 2];
                }

                if (!pkey) {
                    IPA.notify(t('chain.unableToDetermineChainUp'), 'error');
                    return;
                }

                var command = rpc.command({
                    entity: 'chain',
                    method: 'mod',
                    args: [pkey],
                    options: {
                        'moveup_gpc': [gpc_name],
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.gpcMovedUp').replace('%s', gpc_name));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = t('chain.gpcMoveUpFailed');
                        if (error_thrown && error_thrown.message) {
                            msg += ': ' + error_thrown.message;
                        }
                        IPA.notify(msg, 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.move_gpc_down_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'move_gpc_down';
            spec.label = spec.label || t('chain.moveGpcDown');
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify(t('chain.selectOneGpc'), 'error');
                    return;
                }

                var gpc_name = selected[0];
                var hash = window.location.hash;
                var pkey;
                var parts = hash.split('/');

                var chainIndex = parts.indexOf('chain');
                if (chainIndex >= 0 && parts[chainIndex + 1] === 'gpo' && parts[chainIndex + 2]) {
                    pkey = parts[chainIndex + 2];
                }

                if (!pkey) {
                    IPA.notify(t('chain.unableToDetermineChainDown'), 'error');
                    return;
                }

                var command = rpc.command({
                    entity: 'chain',
                    method: 'mod',
                    args: [pkey],
                    options: {
                        'movedown_gpc': [gpc_name],
                        version: IPA.api_version
                    },
                    on_success: function(data) {
                        facet.refresh();
                        IPA.notify_success(t('chain.gpcMovedDown').replace('%s', gpc_name));
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = t('chain.gpcMoveDownFailed');
                        if (error_thrown && error_thrown.message) {
                            msg += ': ' + error_thrown.message;
                        }
                        IPA.notify(msg, 'error');
                        if (on_error) on_error(xhr, text_status, error_thrown);
                    }
                });

                command.execute();
            };

            return that;
        };

        exp.boolean_status_formatter = function(spec) {
            spec = spec || {};

            var that = IPA.formatter(spec);

            that.format = function(value) {
                if (value === null || value === undefined) {
                    return t('chain.statusUnknown');
                }

                if (typeof value === 'boolean') {
                    return value ? t('chain.statusActive') : t('chain.statusInactive');
                }

                if (typeof value === 'string') {
                    var lower = value.toLowerCase();
                    if (lower === 'true' || lower === '1' || lower === 'yes') {
                        return t('chain.statusActive');
                    }
                    if (lower === 'false' || lower === '0' || lower === 'no') {
                        return t('chain.statusInactive');
                    }
                }

                if (Array.isArray(value) && value.length > 0) {
                    return that.format(value[0]);
                }

                return t('chain.statusUnknown');
            };

            return that;
        };

        exp.chain_dnd_policy = function(spec) {
            spec = spec || {};
            var that = IPA.facet_policy(spec);
            that.initialized = false;
            that.dragged_name = null;
            that.tbody = null;

            that.get_table = function() {
                var facet = that.container;
                return facet && facet.table ? facet.table : null;
            };

            that.chain_rows = function() {
                var table = that.get_table();
                if (!table || !table.records || !table.tbody) return null;

                var info = [];
                var row_els = table.tbody.children('tr');
                for (var i = 0; i < table.records.length && i < row_els.length; i++) {
                    var rec = table.records[i];
                    if (rec === null || rec === undefined) continue;
                    if (rec.cn === null || rec.cn === undefined) return null;
                    info.push({
                        name: String(rec.cn),
                        active: rec.active === true,
                        row: row_els.eq(i)
                    });
                }
                return info;
            };

            that.chain_name_from_row = function(tr) {
                var table = that.get_table();
                if (!table || !table.records || !table.tbody) return null;
                var idx = table.tbody.children('tr').index(tr);
                if (idx >= 0 && table.records[idx] && table.records[idx].cn !== undefined) {
                    return String(table.records[idx].cn);
                }
                var checkbox = tr.find('input[type="checkbox"]').first();
                if (checkbox.length) {
                    return String(checkbox.val() || '');
                }
                return null;
            };

            that.apply_draggable = function() {
                var info = that.chain_rows();
                if (!info) return;

                var active_count = 0;
                for (var i = 0; i < info.length; i++) {
                    if (info[i].active) active_count++;
                }
                var enable = active_count >= 2;

                for (var j = 0; j < info.length; j++) {
                    var entry = info[j];
                    var div = entry.row.find('div[name="cn"]').first();
                    if (!div.length) continue;
                    if (enable && entry.active) {
                        div.attr('draggable', 'true');
                        div.find('a').attr('draggable', 'false');
                        div.removeClass('chain-dnd-disabled');
                    } else {
                        div.removeAttr('draggable');
                        div.addClass('chain-dnd-disabled');
                    }
                }
            };

            that.placement = function(e) {
                var info = that.chain_rows();
                if (!info || !that.dragged_name) return null;

                var reduced = [];
                var from = -1;
                for (var i = 0; i < info.length; i++) {
                    var entry = info[i];
                    if (!entry.active) continue;
                    if (entry.name === that.dragged_name) {
                        from = reduced.length;
                        continue;
                    }
                    reduced.push(entry);
                }
                if (from < 0) return null;

                var y = e.clientY !== undefined ? e.clientY : e.originalEvent.clientY;
                var to = reduced.length;
                for (var j = 0; j < reduced.length; j++) {
                    var node = reduced[j].row.get(0);
                    if (!node) break;
                    var rect = node.getBoundingClientRect();
                    if (y < rect.top + rect.height / 2) {
                        to = j;
                        break;
                    }
                }
                return {from: from, to: to};
            };

            that.clear_indicator = function() {
                if (!that.tbody) return;
                that.tbody.find('tr').removeClass(
                    'chain-dnd-insert chain-dnd-before chain-dnd-after'
                );
                that.tbody.removeClass('chain-dnd-active');
            };

            that.show_indicator = function(placement_result) {
                that.clear_indicator();
                if (!that.tbody) return;
                that.tbody.addClass('chain-dnd-active');

                var info = that.chain_rows();
                if (!info) return;
                var reduced = [];
                for (var i = 0; i < info.length; i++) {
                    var entry = info[i];
                    if (entry.active && entry.name !== that.dragged_name) {
                        reduced.push(entry);
                    }
                }
                var to = placement_result.to;
                if (to >= reduced.length) {
                    if (reduced.length > 0) {
                        reduced[reduced.length - 1].row
                            .addClass('chain-dnd-insert chain-dnd-after');
                    }
                } else {
                    reduced[to].row.addClass('chain-dnd-insert chain-dnd-before');
                }
            };

            that.after_move = function(name, facet, ok) {
                if (facet && facet.refresh) facet.refresh();
                if (ok) {
                    IPA.notify_success(t('chain.movedSuccessfully').replace('%s', name));
                } else {
                    IPA.notify(t('chain.moveFailed'), 'error');
                }
            };

            that.move_chain = function(name, from, to, facet) {
                var delta = to - from;
                if (delta === 0) return;

                var option = delta < 0 ? 'moveup_chain' : 'movedown_chain';
                var steps = Math.abs(delta);

                var batch = rpc.batch_command({
                    name: 'chain_dnd_move',
                    error_message: t('chain.reorderFailed')
                });

                for (var i = 0; i < steps; i++) {
                    var opts = {};
                    opts[option] = name;
                    opts.version = IPA.api_version;
                    batch.add_command(rpc.command({
                        entity: 'gpmaster',
                        method: 'mod',
                        options: opts
                    }));
                }

                batch.on_success = function() {
                    that.after_move(name, facet, true);
                };
                batch.on_error = function() {
                    that.after_move(name, facet, false);
                };
                batch.execute();
            };

            that.on_dragstart = function(e) {
                var tr = $(this).closest('tr');
                var name = that.chain_name_from_row(tr);
                if (!name) return false;

                var info = that.chain_rows();
                var active = false;
                if (info) {
                    for (var i = 0; i < info.length; i++) {
                        if (info[i].active && info[i].name === name) {
                            active = true;
                            break;
                        }
                    }
                }
                if (!active) return false;

                that.dragged_name = name;
                var native_event = e.originalEvent || e;
                if (native_event.dataTransfer) {
                    native_event.dataTransfer.effectAllowed = 'move';
                    native_event.dataTransfer.setData('text/plain', name);
                }
                tr.addClass('chain-dnd-source');
                return true;
            };

            that.on_dragover = function(e) {
                if (!that.dragged_name) return;
                var info = that.chain_rows();
                if (!info) return;
                var placement_result = that.placement(e);
                if (!placement_result) return;
                e.preventDefault();
                var native_event = e.originalEvent || e;
                if (native_event.dataTransfer) {
                    native_event.dataTransfer.dropEffect = 'move';
                }
                that.show_indicator(placement_result);
            };

            that.on_drop = function(e) {
                if (!that.dragged_name) return;
                var placement_result = that.placement(e);
                var name = that.dragged_name;
                that.dragged_name = null;
                that.clear_indicator();
                if (that.tbody) that.tbody.find('tr').removeClass('chain-dnd-source');
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();

                var facet = that.container;
                if (!placement_result) return;
                that.move_chain(name, placement_result.from, placement_result.to, facet);
            };

            that.on_dragend = function() {
                that.dragged_name = null;
                if (that.tbody) {
                    that.tbody.find('tr').removeClass('chain-dnd-source');
                }
                that.clear_indicator();
            };

            that.init_events = function() {
                var tbody = that.tbody;
                tbody.on('dragstart', 'div[name="cn"]', that.on_dragstart);
                tbody.on('dragover', that.on_dragover);
                tbody.on('drop', that.on_drop);
                tbody.on('dragend', 'div[name="cn"]', that.on_dragend);
            };

            that.post_load = function(data) {
                var facet = that.container;
                if (!facet || !facet.table || !facet.table.tbody) return;
                that.tbody = facet.table.tbody;
                that.apply_draggable();
                if (!that.initialized) {
                    that.init_events();
                    that.initialized = true;
                }
            };

            return that;
        };

        exp.chain_search_summary_policy = function(spec) {
            var that = IPA.facet_policy(spec);

            that.post_load = function(data) {
                if (!data || !data.result || data.result.truncated) return;

                var facet = that.container;
                if (!facet || !facet.table || !facet.table.summary) return;

                var total = data.result.count;
                if (total === undefined && data.result.result) {
                    total = data.result.result.length;
                }

                if (!total) {
                    facet.table.summary.text(text.get('@i18n:association.no_entries'));
                    return;
                }

                var message = text.get('@i18n:association.paging');
                message = message.replace('${start}', 1)
                                 .replace('${end}', total)
                                 .replace('${total}', total);
                facet.table.summary.text(message);
            };

            return that;
        };

        var add_chain_details_facet_fields = function (spec) {
            spec.fields = [
                {
                    name: 'cn',
                    label: t('chain.fields.cn'),
                    read_only: true
                },
                {
                    $type: 'entity_select',
                    name: 'usergroup',
                    label: t('chain.fields.usergroup'),
                    other_entity: 'group',
                    other_field: 'cn',
                    filter_options: {'posix': true}
                },
                {
                    $type: 'entity_select',
                    name: 'computergroup',
                    label: t('chain.fields.computergroup'),
                    other_entity: 'hostgroup',
                    other_field: 'cn'
                },
                {
                    name: 'active',
                    label: t('chain.fields.active'),
                    read_only: true,
                    formatter: 'boolean_status_formatter'
                }
            ];
        };

        var make_chain_spec = function() {
            var spec = {
                name: 'chain',
                facet_groups: ['settings', 'member'],
                facets: [
                    {
                         $type: 'search',
                         name: 'search',
                         title: t('chain.titlePlural'),
                         label: t('chain.titlePlural'),
                         $pre_ops: [gpo_module.order_control_buttons(['refresh', 'add', 'enable', 'disable', 'move_up', 'move_down', 'remove'])],
                        sort_enabled: false,
                        server_sort: true,
                        pagination: false,
                         policies: [
                             {
                                 $factory: exp.chain_dnd_policy
                             },
                             {
                                 $factory: exp.chain_search_summary_policy
                             }
                         ],
                        columns: [
                            {
                                name: 'cn',
                                label: t('chain.fields.cn'),
                                sortable: false
                            },
                            {
                                name: 'usergroup',
                                label: t('chain.fields.usergroup'),
                                sortable: false
                            },
                            {
                                name: 'computergroup',
                                label: t('chain.fields.computergroup'),
                                sortable: false
                            },
                            {
                                name: 'active',
                                label: t('chain.fields.active'),
                                sortable: false,
                                formatter: 'boolean_status_formatter'
                            }
                        ],
                        actions: [
                            'enable',
                            'disable',
                            'move_up',
                            'move_down'
                        ],
                        control_buttons: [
                            {
                                name: 'enable',
                                label: t('chain.enable'),
                                icon: 'fa-check-circle'
                            },
                            {
                                name: 'disable',
                                label: t('chain.disable'),
                                icon: 'fa-times-circle'
                            },
                            {
                                name: 'move_up',
                                label: t('chain.moveUp'),
                                icon: 'fa-arrow-up'
                            },
                            {
                                name: 'move_down',
                                label: t('chain.moveDown'),
                                icon: 'fa-arrow-down'
                            }
                        ]
                    },
                    {
                        $type: 'details',
                        name: 'details',
                        title: t('chain.title'),
                        label: t('chain.title'),
                        check_rights: false,
                        $pre_ops: [gpo_module.order_control_buttons(['refresh', 'save', 'revert'])]
                    },
                    {
                        $type: 'association',
                        name: 'gpo',
                        attribute_member: 'gplink',
                        facet_group: 'member',
                        sort_enabled: false,
                        server_sort: true,
                         label: t('chain.gpoTab'),
                         tab_label: t('chain.gpoTab'),
                        columns: [
                            {
                                name: 'displayname',
                                label: t('gpo.fields.policyName'),
                                primary_key: true,
                                sortable: false
                            },
                            {
                                name: 'cn',
                                label: t('gpo.fields.containerName'),
                                sortable: false
                            },
                            {
                                name: 'versionnumber',
                                label: t('gpo.fields.version'),
                                sortable: false
                            }
                        ],
                        adder_columns: [
                            {
                                name: 'displayname',
                                primary_key: true,
                                width: '100%'
                            }
                        ],
                        add_title: t('gpo.addToChainTitle'),
                        remove_title: t('gpo.removeFromChainTitle'),
                        add_method: 'add_gpo',
                        remove_method: 'remove_gpo',
                        actions: [
                            'move_gpc_up',
                            'move_gpc_down'
                        ],
                        control_buttons: [
                            {
                                name: 'move_gpc_up',
                                label: t('chain.moveUp'),
                                icon: 'fa-arrow-up'
                            },
                            {
                                name: 'move_gpc_down',
                                label: t('chain.moveDown'),
                                icon: 'fa-arrow-down'
                            }
                        ],
                    }
                ],
                adder_dialog: {
                    title: t('chain.addTitle'),
                    fields: [
                        {
                            name: 'cn',
                            label: t('chain.fields.cn'),
                            doc: t('chain.fields.chainNameDoc'),
                            required: true,
                            width: '400px'
                        },
                        {
                            $type: 'entity_select',
                            name: 'usergroup',
                            label: t('chain.fields.usergroup'),
                            doc: t('chain.fields.userGroupDoc'),
                            other_entity: 'group',
                            other_field: 'cn',
                            label_field: 'cn',
                            searchable: true,
                            editable: true,
                            filter_options: {'posix': true},
                            required: false,
                            width: '300px'
                        },
                        {
                            $type: 'entity_select',
                            name: 'computergroup',
                            label: t('chain.fields.computergroup'),
                            doc: t('chain.fields.computerGroupDoc'),
                            other_entity: 'hostgroup',
                            other_field: 'cn',
                            label_field: 'cn',
                            searchable: true,
                            editable: true,
                            required: false,
                            width: '300px'
                        },
                        {
                            $type: 'multivalued',
                            name: 'gplink',
                            label: t('chain.fields.gplink'),
                            doc: t('chain.fields.gplinkDoc'),
                            child_spec: {
                                $type: 'entity_select',
                                other_entity: 'gpo',
                                other_field: 'displayname',
                                label_field: 'displayname',
                                searchable: true,
                                editable: true,
                                width: '350px'
                            }
                        }
                    ]
                }
            };

            add_chain_details_facet_fields(spec.facets[1]);
            return spec;
        };

        exp.chain_entity_spec = make_chain_spec();

        exp.register = function() {
            var e = reg.entity;
            var a = reg.action;
            var f = reg.formatter;

            f.register('boolean_status_formatter', exp.boolean_status_formatter);

            a.register('enable', exp.enable_action);
            a.register('disable', exp.disable_action);
            a.register('move_up', exp.move_up_action);
            a.register('move_down', exp.move_down_action);
            a.register('move_gpc_up', exp.move_gpc_up_action);
            a.register('move_gpc_down', exp.move_gpc_down_action);

            e.register({type: 'chain', spec: exp.chain_entity_spec});
        };

        exp.grouppolicy_menu_spec = {
            name: 'grouppolicy',
            label: t('menu.groupPolicy'),
            children: [
                {
                    entity: 'chain',
                    label: t('menu.chains')
                },
                {
                    entity: 'gpo',
                    label: t('menu.groupPolicyObjects')
                }
            ]
        };

        exp.add_menu_items = function() {
            var policy_item = menu.query({name: 'policy'});

            if (policy_item.length > 0) {
                menu.add_item(exp.grouppolicy_menu_spec, 'policy');
            }
        };

        phases.on('registration', exp.register);
        phases.on('profile', exp.add_menu_items, 20);

        return exp;
    }
);
