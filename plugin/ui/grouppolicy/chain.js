define(
    [
        'freeipa/ipa',
        'freeipa/menu',
        'freeipa/phases',
        'freeipa/reg',
        'freeipa/rpc',
        './gpo'
    ],
    function(IPA, menu, phases, reg, rpc, gpo_module) {

        var exp = IPA.grouppolicy = {};

        exp.enable_action = function(spec) {
            spec = spec || {};
            spec.name = spec.name || 'enable';
            spec.label = spec.label || 'Enable';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : true;
            spec.confirm_msg = spec.confirm_msg || 'Are you sure you want to enable the selected chain?';

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one chain to enable', 'error');
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
                        IPA.notify_success('Chain "' + chain_name + '" enabled successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = 'Failed to enable chain';
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
            spec.label = spec.label || 'Disable';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : true;
            spec.confirm_msg = spec.confirm_msg || 'Are you sure you want to disable the selected chain?';

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one chain to disable', 'error');
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
                        IPA.notify_success('Chain "' + chain_name + '" disabled successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = 'Failed to disable chain';
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
            spec.label = spec.label || 'Move Up';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one chain to move', 'error');
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
                        IPA.notify_success('Chain moved up successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        IPA.notify('Failed to move chain up: ' + (error_thrown.message || text_status), 'error');
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
            spec.label = spec.label || 'Move Down';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one chain to move', 'error');
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
                        IPA.notify_success('Chain moved down successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        IPA.notify('Failed to move chain down: ' + (error_thrown.message || text_status), 'error');
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
            spec.label = spec.label || 'Move GPC Up';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one GPC to move', 'error');
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
                    IPA.notify('Unable to determine chain name for move up', 'error');
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
                        IPA.notify_success('GPC "' + gpc_name + '" moved up successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = 'Failed to move GPC up';
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
            spec.label = spec.label || 'Move GPC Down';
            spec.enable_cond = spec.enable_cond || ['item-selected'];
            spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

            var that = IPA.action(spec);

            that.execute_action = function(facet, on_success, on_error) {
                var selected = facet.get_selected_values();

                if (selected.length !== 1) {
                    IPA.notify('Please select exactly one GPC to move', 'error');
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
                    IPA.notify('Unable to determine chain name for move down', 'error');
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
                        IPA.notify_success('GPC "' + gpc_name + '" moved down successfully');
                        if (on_success) on_success(data);
                    },
                    on_error: function(xhr, text_status, error_thrown) {
                        var msg = 'Failed to move GPC down';
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
                    return 'Unknown';
                }

                if (typeof value === 'boolean') {
                    return value ? 'Active' : 'Inactive';
                }

                if (typeof value === 'string') {
                    var lower = value.toLowerCase();
                    if (lower === 'true' || lower === '1' || lower === 'yes') {
                        return 'Active';
                    }
                    if (lower === 'false' || lower === '0' || lower === 'no') {
                        return 'Inactive';
                    }
                }

                if (Array.isArray(value) && value.length > 0) {
                    return that.format(value[0]);
                }

                return 'Unknown';
            };

            return that;
        };

        var add_chain_details_facet_fields = function (spec) {
            spec.fields = [
                {
                    name: 'cn',
                    read_only: true
                },
                {
                    $type: 'entity_select',
                    name: 'usergroup',
                    other_entity: 'group',
                    other_field: 'cn',
                    filter_options: {'posix': true}
                },
                {
                    $type: 'entity_select',
                    name: 'computergroup',
                    other_entity: 'hostgroup',
                    other_field: 'cn'
                },
                {
                    name: 'active',
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
                        label: 'Group Policy Chains',
                        sort_enabled: false,
                        server_sort: true,
                        columns: [
                            {
                                name: 'cn',
                                label: 'Chain Name',
                                sortable: false
                            },
                            {
                                name: 'usergroup',
                                label: 'User Group',
                                sortable: false
                            },
                            {
                                name: 'computergroup',
                                label: 'Computer Group',
                                sortable: false
                            },
                            {
                                name: 'active',
                                label: 'Active',
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
                                label: 'Enable',
                                icon: 'fa-check-circle'
                            },
                            {
                                name: 'disable',
                                label: 'Disable',
                                icon: 'fa-times-circle'
                            },
                            {
                                name: 'move_up',
                                label: 'Move Up',
                                icon: 'fa-arrow-up'
                            },
                            {
                                name: 'move_down',
                                label: 'Move Down',
                                icon: 'fa-arrow-down'
                            }
                        ]
                    },
                    {
                        $type: 'details',
                        name: 'details',
                        check_rights: false
                    },
                    {
                        $type: 'association',
                        name: 'gpo',
                        attribute_member: 'gplink',
                        facet_group: 'member',
                        sort_enabled: false,
                        server_sort: true,
                        label: 'Group Policy Objects',
                        tab_label: 'Group Policy Objects',
                        columns: [
                            {
                                name: 'displayname',
                                label: 'Policy Name',
                                primary_key: true,
                                sortable: false
                            },
                            {
                                name: 'cn',
                                label: 'Container Name',
                                sortable: false
                            },
                            {
                                name: 'gpcfilesyspath',
                                label: 'File System Path',
                                sortable: false
                            },
                            {
                                name: 'versionnumber',
                                label: 'Version',
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
                        add_title: 'Add Group Policy Objects to Chain',
                        remove_title: 'Remove Group Policy Objects from Chain',
                        add_method: 'add_gpo',
                        remove_method: 'remove_gpo',
                        actions: [
                            'move_gpc_up',
                            'move_gpc_down'
                        ],
                        control_buttons: [
                            {
                                name: 'move_gpc_up',
                                label: 'Move Up',
                                icon: 'fa-arrow-up'
                            },
                            {
                                name: 'move_gpc_down',
                                label: 'Move Down',
                                icon: 'fa-arrow-down'
                            }
                        ],
                    }
                ],
                adder_dialog: {
                    title: 'Add Group Policy Chain',
                    fields: [
                        {
                            name: 'cn',
                            label: 'Chain Name',
                            doc: 'Unique name for the Group Policy Chain',
                            required: true,
                            width: '400px'
                        },
                        {
                            $type: 'entity_select',
                            name: 'usergroup',
                            label: 'User Group',
                            doc: 'Select a user group for this chain',
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
                            label: 'Computer Group',
                            doc: 'Select a computer group for this chain',
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
                            label: 'Group Policy Links',
                            doc: 'Select Group Policy Objects to link to this chain',
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
            label: 'GROUP Policy',
            children: [
                {
                    entity: 'chain',
                    label: 'Chains'
                },
                {
                    entity: 'gpo',
                    label: 'Group Policy Objects'
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