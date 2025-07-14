define([
    'freeipa/ipa',
    'freeipa/phases', 
    'freeipa/reg'
], function(IPA, phases, reg) {

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
                    ]
                },
                {
                    $type: 'details',
                    name: 'details',
                    check_rights: false,
                    sections: [
                        {
                            name: 'identity',
                            label: 'Identity',
                            fields: [
                                {
                                    name: 'displayname',
                                    label: 'Policy Name',
                                    read_only: true
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
                                    name: 'gpcfilesyspath',
                                    label: 'File System Path'
                                },
                                {
                                    name: 'versionnumber',
                                    label: 'Version Number'
                                },
                                {
                                    name: 'flags',
                                    label: 'Flags'
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

    exp.register = function() {
        var e = reg.entity;
        e.register({type: 'gpo', spec: exp.gpo_entity_spec});
    };

    phases.on('registration', exp.register);

    return exp;
});
