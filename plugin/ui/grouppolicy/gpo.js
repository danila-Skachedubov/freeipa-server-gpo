define([
    'freeipa/ipa',
    'freeipa/phases',
    'freeipa/reg',
    'freeipa/navigation',
    'freeipa/rpc'
], function(IPA, phases, reg, navigation, rpc) {

    var exp = IPA.gpo = {};

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
                    actions: ['edit'],
                    control_buttons: [
                        {
                            name: 'edit',
                            label: 'Edit',
                            icon: 'fa-pencil'
                        }
                    ]
                },
                {
                    $type: 'details',
                    name: 'details',
                    check_rights: false,
                    actions: ['save', 'revert', 'refresh'],
                    sections: [
                        {
                            name: 'identity',
                            label: 'Identity',
                            fields: [
                                {
                                    name: 'displayname',
                                    label: 'Policy Name',
                                    read_only: false
                                }
                            ]
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

    exp.edit_action = function(spec) {
        spec = spec || {};
        spec.name = spec.name || 'edit';
        spec.label = spec.label || 'Edit';
        spec.enable_cond = spec.enable_cond || ['item-selected'];
        spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

        var that = IPA.action(spec);

        that.execute_action = function(facet, on_success, on_error) {
            var selected = facet.get_selected_values();

            if (selected.length !== 1) {
                IPA.notify('Please select exactly one GPO to edit', 'error');
                return;
            }

            var gpo_name = selected[0];

            // First fetch current GPO data
            var command = rpc.command({
                entity: 'gpo',
                method: 'show',
                args: [gpo_name],
                options: {
                    version: IPA.api_version
                },
                on_success: function(data) {
                    // Ensure we have result data
                    // Note: data.result contains {result: {...}, value: "...", summary: "..."}
                    var result = (data.result && data.result.result) || {};
                    console.log('Loaded GPO data:', data, 'Extracted result:', result);

                    // Create edit dialog with current values
                    var dialog = IPA.dialog({
                        title: 'Edit Group Policy Object: ' + gpo_name,
                        width: 600,
                        fields: [
                            {
                                $type: 'text',
                                name: 'displayname',
                                label: 'Policy Name',
                                value: result.displayname || '',
                                required: true,
                                width: '100%'
                            },
                            {
                                $type: 'textarea',
                                name: 'admx_json',
                                label: 'ADMX Policies JSON',
                                value: 'Loading ADMX policies...',
                                rows: 20,
                                read_only: true,
                                width: '100%'
                            }
                        ]
                    });



                    // Add Save button
                    dialog.create_button({
                        name: 'save',
                        label: 'Save',
                        click: function() {
                            // Get values from dialog fields
                            var displayname_widget = dialog.get_field('displayname').widget;
                            var displayname_value = displayname_widget.get_value()[0] || '';

                            // Prepare modification data
                            var mod_data = {};

                            // Check ONLY for rename (displayname change)
                            // Convert both to strings and trim for comparison
                            var current_displayname = String(result.displayname || '').trim();
                            var new_displayname = String(displayname_value || '').trim();

                            // Only rename if name is actually different (not empty, not same)
                            if (new_displayname && new_displayname !== current_displayname) {
                                mod_data.rename = new_displayname;
                            }

                            // DO NOT check for changes in other fields
                            // Only version will be automatically incremented
                            // Other fields remain unchanged unless explicitly renamed

                            // ALWAYS increment version when Save is clicked
                            var current_version = parseInt(result.versionnumber || 0);
                            var new_version = current_version + 1;
                            mod_data.versionnumber = new_version;

                            // Execute modify command
                            console.log('Sending GPO mod command:', {
                                entity: 'gpo',
                                method: 'mod',
                                args: [gpo_name],
                                options: mod_data,
                                current_version: current_version,
                                new_version: new_version
                            });
                            var mod_command = rpc.command({
                                entity: 'gpo',
                                method: 'mod',
                                args: [gpo_name],
                                options: mod_data,
                                on_success: function(mod_result) {
                                    dialog.close();
                                    facet.refresh();
                                    var success_msg = 'GPO "' + gpo_name + '" updated successfully. Version incremented from ' + current_version + ' to ' + new_version + '.';
                                    if (mod_data.rename) {
                                        success_msg = 'GPO renamed from "' + gpo_name + '" to "' + mod_data.rename + '" successfully. Version incremented from ' + current_version + ' to ' + new_version + '.';
                                    }
                                    IPA.notify_success(success_msg);
                                    if (on_success) on_success(mod_result);
                                },
                                on_error: function(xhr, text_status, error_thrown) {
                                    var msg = 'Failed to update GPO';
                                    if (error_thrown && error_thrown.message) {
                                        msg += ': ' + error_thrown.message;
                                    }
                                    // Log full error details for debugging
                                    console.error('GPO update error - full details:');
                                    console.error('xhr:', xhr);
                                    console.error('xhr.responseText:', xhr.responseText);
                                    console.error('text_status:', text_status);
                                    console.error('error_thrown:', error_thrown);
                                    IPA.notify(msg, 'error');
                                    if (on_error) on_error(xhr, text_status, error_thrown);
                                }
                            });
                            mod_command.execute();
                        }
                    });

                    // Add Cancel button
                    dialog.create_button({
                        name: 'cancel',
                        label: 'Cancel',
                        click: function() {
                            dialog.close();
                        }
                    });

                    dialog.open();

                    // Load ADMX policies
                    var parse_command = rpc.command({
                        entity: 'gpo',
                        method: 'parse_admx',
                        args: [],
                        options: {
                            version: IPA.api_version
                        },
                        on_success: function(parse_data) {
                            var parse_result = parse_data.result.result || {};
                            var json_str = JSON.stringify(parse_result, null, 2);
                            var admx_field = dialog.get_field('admx_json');
                            if (admx_field && admx_field.widget) {
                                admx_field.widget.set_value([json_str]);
                            }
                        },
                        on_error: function(xhr, text_status, error_thrown) {
                            var msg = 'Failed to load ADMX policies';
                            if (error_thrown && error_thrown.message) {
                                msg += ': ' + error_thrown.message;
                            }
                            IPA.notify(msg, 'error');
                            // Update field with error
                            var admx_field = dialog.get_field('admx_json');
                            if (admx_field && admx_field.widget) {
                                admx_field.widget.set_value(['Error: ' + msg]);
                            }
                        }
                    });
                    parse_command.execute();
                },
                on_error: function(xhr, text_status, error_thrown) {
                    var msg = 'Failed to load GPO data';
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

    exp.save_action = function(spec) {
        spec = spec || {};
        spec.name = spec.name || 'save';
        spec.label = spec.label || 'Save';
        spec.enable_cond = spec.enable_cond || ['dirty'];
        spec.needs_confirm = spec.needs_confirm !== undefined ? spec.needs_confirm : false;

        var that = IPA.action(spec);

        that.execute_action = function(facet, on_success, on_error) {
            // Get current values from facet
            var values = facet.get_values();
            var original_values = facet.get_original_values();

            // Prepare modification data
            var mod_data = {};
            var has_changes = false;

            // Check ONLY for rename (displayname change)
            // Convert both to strings and trim for comparison
            var current_displayname = String(original_values.displayname || '').trim();
            var new_displayname = String(values.displayname || '').trim();

            // Only rename if name is actually different (not empty, not same)
            if (new_displayname && new_displayname !== current_displayname) {
                mod_data.rename = new_displayname;
                has_changes = true;
            }

            // DO NOT check for changes in other fields
            // Only version will be automatically incremented
            // Other fields remain unchanged unless explicitly renamed
            // Always set has_changes to true to allow version increment
            if (!has_changes) {
                has_changes = true;
            }

            // Check if versionnumber was manually changed
            var version_changed_manually = parseInt(values.versionnumber) !== parseInt(original_values.versionnumber || 0);
            if (version_changed_manually) {
                // Validate manual version change
                var new_version = parseInt(values.versionnumber);
                var current_version = parseInt(original_values.versionnumber || 0);

                if (new_version <= current_version) {
                    IPA.notify('Version number must be greater than current version (' + current_version + '). Auto-incrementing to version ' + (current_version + 1) + '.', 'warning');
                    // Auto-increment instead
                    mod_data.versionnumber = current_version + 1;
                } else {
                    mod_data.versionnumber = new_version;
                    IPA.notify('Using manually specified version: ' + new_version, 'info');
                }
                has_changes = true;
            }

            // If no changes, just return
            if (!has_changes) {
                IPA.notify('No changes made', 'info');
                if (on_success) on_success();
                return;
            }

            // Automatically increment version if there are changes (unless manually changed with valid version)
            if (has_changes && !version_changed_manually) {
                var current_version = parseInt(original_values.versionnumber || 0);
                mod_data.versionnumber = current_version + 1;
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
                    // Add version info to success message
                    if (mod_data.versionnumber !== undefined) {
                        success_msg += ' (version: ' + mod_data.versionnumber + ')';
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



    exp.register = function() {
        var e = reg.entity;
        var a = reg.action;

        a.register('edit', exp.edit_action);
        a.register('save', exp.save_action);
        e.register({type: 'gpo', spec: exp.gpo_entity_spec});
    };

    phases.on('registration', exp.register);

    return exp;
});
