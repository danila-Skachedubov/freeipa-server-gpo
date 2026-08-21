import logging
import re

from ipalib import api, errors, _, ngettext
from ipalib import Str, Command, output, Flag, Bool
from ipalib.plugable import Registry
from ipalib import constants
from ipapython.dn import DN

from ipaserver.plugins.baseldap import (
    LDAPObject, LDAPCreate, LDAPDelete, LDAPUpdate,
    LDAPSearch, LDAPRetrieve, LDAPAddMember, LDAPRemoveMember,
)

logger = logging.getLogger(__name__)
register = Registry()

PLUGIN_CONFIG = (
    ('container_system', DN(('cn', 'System'))),
    ('container_grouppolicychain', DN(('cn', 'Chains'), ('cn', 'System'))),
)

OBJECT_TYPE_MAPPING = {
    'usergroup': ('group', 'cn'),
    'computergroup': ('hostgroup', 'cn'),
}

GP_LOOKUP_ATTRIBUTES = ['displayName', 'cn']

def verify_gpo_schema(ldap, api):
    """
    Checking for the presence of the Group Policy schema for GPO objects.
    Called at the beginning of each command.
    """
    try:
        gpo_container_dn = DN(('cn', 'Policies'), ('cn', 'System'), api.env.basedn)
        ldap.get_entry(gpo_container_dn, attrs_list=['cn'])
    except errors.NotFound:
        raise errors.NotFound(
            name=_('Group Policy schema'),
            reason=_(
                'Group Policy schema is not installed. '
                'Cannot create or modify Group Policy Objects. '
                'Please run the ipa-gpo-install command to extend the schema.'
            )
        )
    except errors.PublicError as e:
        error_str = str(e).lower()
        schema_errors = ['object class', 'schema', 'structural object class',
                         'no such object class', 'undefined object class']

        for schema_error in schema_errors:
            if schema_error in error_str:
                raise errors.NotFound(
                    name=_('Group Policy schema'),
                    reason=_(
                        'Group Policy schema is not installed. '
                        'The required LDAP object class "groupPolicyContainer" is missing.'
                        'Please run the ipa-gpo-install command to extend the schema.'
                    )
                )
    except Exception as e:
        logger.debug("GPO schema check error: %s", str(e))

def _normalize_to_list(value):
    """Normalize value to list."""
    if isinstance(value, str):
        return [value]
    elif isinstance(value, (tuple, set)):
        return list(value)
    elif value is None:
        return []
    return list(value)

def _first_value(value, default=None):
    """Return the first normalized value without losing falsey numbers."""
    values = _normalize_to_list(value)
    if not values or values[0] is None:
        return default
    return values[0]

def _extract_displayname_from_value(value):
    """Extract a displayName RDN value without case-sensitive assumptions."""
    text = str(value)
    first_part = text.split(',', 1)[0]
    attr_name, separator, attr_value = first_part.partition('=')
    if separator and attr_name.lower() == 'displayname':
        return attr_value
    return text

def is_dn(value):
    """Check if the string looks like a DN."""
    return str(value).lower().startswith('cn=')

def get_display_name(entry):
    """Get displayName or fallback to cn or DN string."""
    display_names = _normalize_to_list(entry.get('displayName'))
    common_names = _normalize_to_list(entry.get('cn'))
    return (
        (display_names[0] if display_names else None) or
        (common_names[0] if common_names else None) or
        str(entry.dn)
    )

def safe_ldap_get_entry(ldap, dn, attrs):
    """Safe LDAP get_entry."""
    try:
        return ldap.get_entry(DN(dn), attrs_list=attrs)
    except Exception:
        return None

def resolve_dns_to_names(ldap, dns, attrs=('displayName', 'cn')):
    """Batch resolve DNs to display names."""
    result = {}
    dns = [str(dn) for dn in dns if is_dn(dn)]
    if not dns:
        return result

    try:
        entries = ldap.get_entries([DN(dn) for dn in dns], attrs_list=list(attrs))
        for entry in entries:
            result[str(entry.dn)] = get_display_name(entry)
    except Exception:
        for dn in dns:
            entry = safe_ldap_get_entry(ldap, dn, attrs)
            result[dn] = get_display_name(entry) if entry else dn
    return result

def convert_dns_in_entries(entries, ldap, attrs_by_field, extra_processing=None):
    """Convert DNs to names across multiple attributes in entries."""
    all_dns = set()
    for entry in entries:
        for field in attrs_by_field:
            all_dns.update(map(str, _normalize_to_list(entry.get(field, []))))

    attrs_needed = set()
    for attr_list in attrs_by_field.values():
        attrs_needed.update(attr_list)

    resolved = resolve_dns_to_names(ldap, all_dns, attrs=list(attrs_needed))

    for entry in entries:
        for field in attrs_by_field:
            original_dns = _normalize_to_list(entry.get(field, []))
            converted = [resolved.get(str(dn), str(dn)) for dn in original_dns]
            entry[field] = converted
            if extra_processing and field in extra_processing:
                extra_processing[field](entry, converted)

@register()
class chain(LDAPObject):
    """Group Policy Chain object."""

    container_dn = None
    object_name = _('Group Policy Chain')
    object_name_plural = _('Group Policy Chains')
    object_class = ['groupPolicyChain']
    permission_filter_objectclasses = ['groupPolicyChain']
    default_attributes = ['cn', 'description', 'userGroup', 'computerGroup', 'gpLink']
    attribute_members = {'gplink': ['gpo']}
    allow_rename = True
    label = _('Group Policy Chains')
    label_singular = _('Group Policy Chain')

    managed_permissions = {
        'System: Read Group Policy Chains': {
            'replaces_global_anonymous_aci': True,
            'ipapermbindruletype': 'all',
            'ipapermright': {'read', 'search', 'compare'},
            'ipapermdefaultattr': {
                'cn', 'objectclass', 'description', 'usergroup',
                'computergroup', 'gplink'
            },
        },
        'System: Add Group Policy Chains': {
            'ipapermright': {'add'},
            'default_privileges': {'Group Policy Administrators'},
        },
        'System: Delete Group Policy Chains': {
            'ipapermright': {'delete'},
            'default_privileges': {'Group Policy Administrators'},
        },
        'System: Modify Group Policy Chains': {
            'ipapermright': {'write'},
            'ipapermdefaultattr': {
                'cn', 'description', 'usergroup', 'computergroup', 'gplink'
            },
            'default_privileges': {'Group Policy Administrators'},
        },
    }

    takes_params = (
        Str('cn', cli_name='name', label=_('Chain name'),
            doc=_('Group Policy Chain name'), primary_key=True,
            autofill=False, pattern=constants.PATTERN_GROUPUSER_NAME,
            pattern_errmsg=constants.ERRMSG_GROUPUSER_NAME.format('chain')),
        Str('description?', cli_name='desc',
            label=_('Description'),
            doc=_('Description for the chain')),
        Str('usergroup?', cli_name='user_group', label=_('User group'),
            doc=_('User group name for this chain')),
        Str('computergroup?', cli_name='computer_group',
            label=_('Computer group'),
            doc=_('Computer group name for this chain')),
        Str('gplink*', cli_name='gp_link', label=_('Group Policy links'),
            doc=_('List of Group Policy Container names')),
        Bool('active?',
            cli_name='active', label=_('Active'),
            doc=_('Whether this chain is active (computed from chainList)'),
            flags=['no_create', 'no_update']),
    )

    def __json__(self):
        """Handle missing schema gracefully."""
        try:
            return super(chain, self).__json__()
        except KeyError as e:
            if 'groupPolicyChain' in str(e):
                result = {
                    'name': self.name,
                    'doc': self.doc,
                    'label': self.label,
                    'label_singular': self.label_singular,
                    'object_class': self.object_class,
                }
                if hasattr(self, 'takes_params'):
                    result['takes_params'] = [
                        {'name': p.name, 'label': p.label}
                        for p in self.takes_params
                    ]
                if hasattr(self, 'default_attributes'):
                    result['default_attributes'] = self.default_attributes
                if hasattr(self, 'attribute_members'):
                    result['attribute_members'] = self.attribute_members
                return result
            raise

    def _on_finalize(self):
        self.env._merge(**dict(PLUGIN_CONFIG))
        self.container_dn = self.env.container_grouppolicychain
        super(chain, self)._on_finalize()

    def find_gp_by_displayname(self, displayname):
        """Find Group Policy Container by displayName."""
        try:
            ldap = self.api.Backend.ldap2
            entry = ldap.find_entry_by_attr(
                'displayName', displayname, 'groupPolicyContainer',
                base_dn=DN('cn=Policies,cn=System', api.env.basedn)
            )
            return entry.dn
        except errors.NotFound:
            raise errors.NotFound(reason=_("Group Policy '{}' not found").format(displayname))

    def get_attrs_list(self, ldap, dn, attrs_list, **options):
        """Include gplink attribute for association tables."""
        attrs_list = super(chain, self).get_attrs_list(ldap, dn, attrs_list, **options)
        if 'gplink' not in attrs_list:
            attrs_list.append('gplink')
        return attrs_list

    def convert_attribute_members(self, entry_attrs, *keys, **options):
        """Convert attribute members for display."""
        if options.get('raw', False):
            return

        try:
            ldap = self.api.Backend.ldap2

            self._convert_groups([entry_attrs], ldap)
            self._convert_gpos([entry_attrs], ldap)

        except Exception as e:
            logger.error("Error in convert_attribute_members: %s", str(e))
            raise

    def _convert_groups(self, entries, ldap):
        convert_dns_in_entries(
            entries, ldap,
            attrs_by_field={
                'usergroup': ['cn'],
                'computergroup': ['cn']
            }
        )

    def _convert_gpos(self, entries, ldap):
        convert_dns_in_entries(
            entries, ldap,
            attrs_by_field={
                'gplink': ['displayName', 'cn']
            },
            extra_processing={
                'gplink': lambda entry, converted: entry.__setitem__('gplink_gpo', list(converted))
            }
        )

    def resolve_object_name(self, attr_name, name, strict=False):
        """Universal resolver for names to DN."""
        try:
            if is_dn(name):
                if strict:
                    if attr_name in OBJECT_TYPE_MAPPING:
                        attrs = [OBJECT_TYPE_MAPPING[attr_name][1]]
                    elif attr_name == 'gplink':
                        attrs = GP_LOOKUP_ATTRIBUTES
                    else:
                        attrs = ['cn']
                    ldap = self.api.Backend.ldap2
                    ldap.get_entry(DN(name), attrs_list=attrs)
                return name

            if attr_name in OBJECT_TYPE_MAPPING:
                obj_type, name_attr = OBJECT_TYPE_MAPPING[attr_name]
                group_dn = self.api.Object[obj_type].get_dn(name)
                if strict:
                    ldap = self.api.Backend.ldap2
                    ldap.get_entry(group_dn, attrs_list=[name_attr])
                return str(group_dn)
            elif attr_name == 'gplink':
                return str(self.find_gp_by_displayname(name))
            else:
                return name
        except errors.NotFound:
            if strict:
                obj_name = OBJECT_TYPE_MAPPING.get(attr_name, [attr_name])[0]
                raise errors.NotFound(reason=_("{} '{}' not found").format(obj_name.title(), name))
            return name
        except Exception as e:
            if strict:
                obj_name = OBJECT_TYPE_MAPPING.get(attr_name, [attr_name])[0]
                raise errors.ValidationError(
                    name=attr_name,
                    error=_("Failed to resolve {} '{}': {}").format(obj_name, name, str(e))
                )
            return name

    def convert_names_to_dns(self, options, strict=False):
        """Convert readable names to DNs for search/operations."""
        converted = {}
        for attr_name in OBJECT_TYPE_MAPPING:
            if attr_name in options and options[attr_name]:
                converted[attr_name] = self.resolve_object_name(
                    attr_name, options[attr_name], strict
                )

        if 'gplink' in options and options['gplink']:
            gp_names = options['gplink']
            if isinstance(gp_names, str):
                converted['gplink'] = [
                    self.resolve_object_name('gplink', gp_names, strict)
                ]
            elif isinstance(gp_names, tuple):
                converted['gplink'] = [
                    self.resolve_object_name('gplink', name, strict) for name in gp_names
                ]
            else:
                converted['gplink'] = [
                    self.resolve_object_name('gplink', name, strict) for name in gp_names
                ]

        return converted

@register()
class chain_show(LDAPRetrieve):
    """Display information about a Group Policy Chain."""

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        chain_name = keys[0] if keys else None
        if chain_name:
            try:
                gpmaster_result = api.Command.gpmaster_show()
                active_chains = gpmaster_result['result'].get('chainlist', [])
                entry_attrs['active'] = [chain_name in active_chains]
            except Exception:
                entry_attrs['active'] = [False]

        return dn

class chain_toggle_base(Command):
    def _toggle_chain(self, cn, enable=True):
        try:
            gpmaster_result = api.Command.gpmaster_show()
            current_chains = gpmaster_result['result'].get('chainlist', [])
            is_active = cn in current_chains

            if enable and is_active:
                raise errors.ValidationError(
                    name='chain',
                    error=_("Chain '{}' is already enabled").format(cn)
                )
            if not enable and not is_active:
                raise errors.ValidationError(
                    name='chain',
                    error=_("Chain '{}' is already disabled").format(cn)
                )

            if enable:
                api.Command.gpmaster_mod(add_chain=[cn])
            else:
                api.Command.gpmaster_mod(remove_chain=[cn])

            updated_chain = api.Command.chain_show(cn)
            return {'result': updated_chain['result']}

        except Exception as exc:
            logger.error("Failed to %s chain '%s': %s",
                        'enable' if enable else 'disable', cn, str(exc))
            raise

@register()
class chain_enable(chain_toggle_base):
    """Enable a Group Policy Chain."""

    takes_args = (
        Str('cn', cli_name='name', label=_('Chain name'), doc=_('Group Policy Chain name')),
    )

    has_output = (
        output.Output('result', type=dict, doc=_('Operation result')),
    )

    def execute(self, cn, **options):
        return self._toggle_chain(cn, enable=True)

@register()
class chain_disable(chain_toggle_base):
    """Disable a Group Policy Chain."""

    takes_args = (
        Str('cn', cli_name='name', label=_('Chain name'), doc=_('Group Policy Chain name')),
    )

    has_output = (
        output.Output('result', type=dict, doc=_('Operation result')),
    )

    def execute(self, cn, **options):
        return self._toggle_chain(cn, enable=False)

@register()
class chain_add(LDAPCreate):
    """Create a new Group Policy Chain."""
    msg_summary = _('Added Group Policy Chain "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        """Convert names to DNs with strict validation."""
        verify_gpo_schema(ldap, self.api)
        chain_name = keys[0]
        if not re.match(constants.PATTERN_GROUPUSER_NAME, chain_name):
            raise errors.ValidationError(
                name='cn',
                error=constants.ERRMSG_GROUPUSER_NAME.format('chain')
            )
        converted = self.obj.convert_names_to_dns(options, strict=True)
        entry_attrs.update(converted)
        return dn

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        """Automatically add chain to GPMaster."""
        chain_name = keys[0]

        try:
            gpmaster_result = api.Command.gpmaster_show()
            current_chains = gpmaster_result['result'].get('chainlist', [])

            if chain_name not in current_chains:
                api.Command.gpmaster_mod(add_chain=[chain_name])
        except Exception as exc:
            logger.warning(
                "Failed to activate newly created chain '%s': %s",
                chain_name,
                str(exc),
            )

        return dn

@register()
class chain_mod(LDAPUpdate):
    """Modify a Group Policy Chain."""
    msg_summary = _('Modified Group Policy Chain "%(value)s"')

    takes_options = (
        Str('add_usergroup?',
            cli_name='add_user_group',
            label=_('Add user group'),
            doc=_('Add user group to chain'),
        ),
        Flag('remove_usergroup',
            cli_name='remove_user_group',
            label=_('Remove user group'),
            doc=_('Remove user group from chain'),
            default=False,
        ),
        Str('add_computergroup?',
            cli_name='add_computer_group',
            label=_('Add computer group'),
            doc=_('Add computer group to chain'),
        ),
        Flag('remove_computergroup',
            cli_name='remove_computer_group',
            label=_('Remove computer group'),
            doc=_('Remove computer group from chain'),
            default=False,
        ),
        Str('moveup_gpc*',
            cli_name='moveup_gpc',
            label=_('Move GPC up'),
            doc=_('Move GPC higher in chain priority'),
        ),
        Str('movedown_gpc*',
            cli_name='movedown_gpc',
            label=_('Move GPC down'),
            doc=_('Move GPC lower in chain priority'),
        ),
    )

    def _validate_modification_options(self, options):
        """Reject combinations whose results would overwrite each other."""
        group_options = {
            'usergroup': (
                'usergroup', 'add_usergroup', 'remove_usergroup'
            ),
            'computergroup': (
                'computergroup',
                'add_computergroup',
                'remove_computergroup',
            ),
        }
        for attr_name, option_names in group_options.items():
            active_options = [
                name for name in option_names if options.get(name)
            ]
            if len(active_options) > 1:
                raise errors.ValidationError(
                    name=attr_name,
                    error=_(
                        "Cannot combine conflicting modifications: {}"
                    ).format(', '.join(active_options))
                )

        move_requested = (
            options.get('moveup_gpc') or options.get('movedown_gpc')
        )
        standard_option_names = {
            'rename', 'description', 'usergroup', 'computergroup', 'gplink',
            'add_usergroup', 'remove_usergroup',
            'add_computergroup', 'remove_computergroup',
            'setattr', 'addattr', 'delattr',
        }
        conflicting_options = [
            name for name in standard_option_names if options.get(name)
        ]
        if move_requested and conflicting_options:
            raise errors.ValidationError(
                name='move_gpc',
                error=_(
                    "Cannot combine GPO movement with other modifications: {}"
                ).format(', '.join(sorted(conflicting_options)))
            )

    def execute(self, *keys, **options):
        """Handle move operations separately, everything else normally."""
        self._validate_modification_options(options)

        if ('moveup_gpc' in options and options['moveup_gpc']) or \
           ('movedown_gpc' in options and options['movedown_gpc']):

            ldap = self.api.Backend.ldap2
            verify_gpo_schema(ldap, self.api)
            dn = self.obj.get_dn(*keys)

            self._do_move_operation(ldap, dn, keys, options)

            entry_attrs = ldap.get_entry(dn, self.obj.default_attributes)
            if not options.get('raw', False):
                self.obj.convert_attribute_members(entry_attrs, *keys, **options)

            result_dict = {}
            for attr_name in entry_attrs:
                attr_value = entry_attrs[attr_name]
                if (isinstance(attr_value, list) and len(attr_value) == 1 and
                    attr_name not in ['gplink']):
                    result_dict[attr_name] = attr_value[0]
                else:
                    result_dict[attr_name] = attr_value

            return {
                'result': result_dict,
                'value': keys[0],
                'summary': self.msg_summary % {'value': keys[0]}
            }

        result = super(chain_mod, self).execute(*keys, **options)
        return result

    def _do_move_operation(self, ldap, dn, keys, options):
        """Move operation for GPCs in chain."""
        if options.get('moveup_gpc') and options.get('movedown_gpc'):
            raise errors.ValidationError(
                name='move_gpc',
                error=_(
                    "Cannot move GPOs up and down in the same operation"
                )
            )

        entry = ldap.get_entry(dn, attrs_list=['gplink'])
        current_gplinks = [str(gp_dn) for gp_dn in entry.get('gplink', [])]
        original_gplinks = list(current_gplinks)

        if len(current_gplinks) < 2:
            return

        gp_names = options.get('moveup_gpc') or options.get('movedown_gpc')
        direction = 'up' if options.get('moveup_gpc') else 'down'
        option_name = 'moveup_gpc' if direction == 'up' else 'movedown_gpc'

        if isinstance(gp_names, str):
            gp_names = [gp_names]
        elif isinstance(gp_names, tuple):
            gp_names = list(gp_names)

        for gp_name in gp_names:
            gp_dn = None
            for existing_dn in current_gplinks:
                try:
                    gp_entry = ldap.get_entry(DN(existing_dn), attrs_list=GP_LOOKUP_ATTRIBUTES)
                    display_name = get_display_name(gp_entry)
                    if display_name == gp_name:
                        gp_dn = existing_dn
                        break
                except errors.NotFound:
                    continue
            if not gp_dn:
                raise errors.ValidationError(
                    name=option_name,
                    error=_(
                        "Cannot move unlinked GPO '{}'. "
                        "Only linked GPOs can be moved."
                    ).format(gp_name)
                )

            current_index = current_gplinks.index(gp_dn)
            if direction == 'up' and current_index > 0:
                new_index = current_index - 1
            elif direction == 'down' and current_index < len(current_gplinks) - 1:
                new_index = current_index + 1
            else:
                continue
            gp_to_move = current_gplinks.pop(current_index)
            current_gplinks.insert(new_index, gp_to_move)

        if current_gplinks == original_gplinks:
            return

        entry['gplink'] = []
        ldap.update_entry(entry)

        entry = ldap.get_entry(dn)
        entry['gplink'] = current_gplinks
        ldap.update_entry(entry)

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        """Standard operations only - move operations handled in execute."""
        verify_gpo_schema(ldap, self.api)
        if options.get('rename'):
            new_name = options['rename']
            if not re.match(constants.PATTERN_GROUPUSER_NAME, new_name):
                raise errors.ValidationError(
                    name='cn',
                    error=constants.ERRMSG_GROUPUSER_NAME.format('chain')
                )
        current_entry = ldap.get_entry(dn, attrs_list=['usergroup', 'computergroup', 'gplink'])

        self._handle_add_operations(entry_attrs, options, keys)
        self._handle_remove_operations(ldap, current_entry, entry_attrs, options)
        self._handle_standard_modifications(entry_attrs, options)

        return dn

    def _handle_add_operations(self, entry_attrs, options, keys):
        """Handle add operations."""
        if 'add_usergroup' in options and options['add_usergroup']:
            group_name = options['add_usergroup']
            validated = self.obj.convert_names_to_dns({'usergroup': group_name}, strict=True)
            entry_attrs['usergroup'] = validated['usergroup']

        if 'add_computergroup' in options and options['add_computergroup']:
            hostgroup_name = options['add_computergroup']
            validated = self.obj.convert_names_to_dns(
                {'computergroup': hostgroup_name}, strict=True
            )
            entry_attrs['computergroup'] = validated['computergroup']

    def _handle_remove_operations(self, ldap, current_entry, entry_attrs, options):
        """Handle remove operations."""
        if 'remove_usergroup' in options and options['remove_usergroup']:
            if not current_entry.get('usergroup'):
                raise errors.ValidationError(
                    name='remove_usergroup',
                    error=_("No user group assigned to this chain")
                )
            entry_attrs['usergroup'] = None

        if 'remove_computergroup' in options and options['remove_computergroup']:
            if not current_entry.get('computergroup'):
                raise errors.ValidationError(
                    name='remove_computergroup',
                    error=_("No computer group assigned to this chain")
                )
            entry_attrs['computergroup'] = None

    def _handle_standard_modifications(self, entry_attrs, options):
        """Handle standard modification operations."""
        standard_options = {k: v for k, v in options.items()
                           if k in ['usergroup', 'computergroup', 'gplink'] and v}

        if standard_options:
            converted = self.obj.convert_names_to_dns(standard_options, strict=True)
            entry_attrs.update(converted)

@register()
class chain_del(LDAPDelete):
    """Delete a Group Policy Chain."""
    msg_summary = _('Deleted Group Policy Chain "%(value)s"')

@register()
class chain_find(LDAPSearch):
    """Search for Group Policy Chains."""

    msg_summary = ngettext('%(count)d Group Policy Chain matched',
                          '%(count)d Group Policy Chains matched', 0)
    sort_result_entries = False

    def args_options_2_entry(self, *args, **options):
        """Convert search options to LDAP entry attributes for filtering."""
        options_copy = dict(options)
        options_copy.pop('active', None)

        converted = self.obj.convert_names_to_dns(options_copy, strict=False)
        options_copy.update(converted)
        return super(chain_find, self).args_options_2_entry(*args, **options_copy)

    def post_callback(self, ldap, entries, truncated, *args, **options):
        """Sort chains by GPMaster order."""
        raw = options.get('raw', False)
        active_filter_requested = 'active' in options
        gpmaster_chains = []

        if entries and (not raw or active_filter_requested):
            try:
                gpmaster_result = api.Command.gpmaster_show()
                gpmaster_chains = gpmaster_result['result'].get('chainlist', [])
            except Exception:
                if active_filter_requested:
                    raise
                gpmaster_chains = []

        if entries and (not raw or active_filter_requested):
            for entry_attrs in entries:
                chain_name = entry_attrs.get('cn', [None])
                if chain_name and isinstance(chain_name, list):
                    chain_name = chain_name[0]
                is_active = bool(chain_name and chain_name in gpmaster_chains)

                if not raw:
                    entry_attrs['active'] = [is_active]

        if active_filter_requested:
            requested_active = bool(options['active'])
            entries[:] = [
                entry for entry in entries
                if bool(
                    entry.get('cn') and
                    entry.get('cn')[0] in gpmaster_chains
                ) == requested_active
            ]

        if not raw:
            ordered_entries = self._order_by_gpmaster(entries, gpmaster_chains)
        else:
            ordered_entries = list(entries)

        entries.clear()
        entries.extend(ordered_entries)

        return truncated

    def _order_by_gpmaster(self, entries, gpmaster_chains):
        """Sort chains by GPMaster order."""
        chain_order = {name: idx for idx, name in enumerate(gpmaster_chains)}
        active_entries = []
        inactive_entries = []

        for entry in entries:
            chain_name = entry.get('cn', [None])
            if chain_name and isinstance(chain_name, list):
                chain_name = chain_name[0]

            if chain_name and chain_name in chain_order:
                active_entries.append((chain_order[chain_name], entry))
            else:
                inactive_entries.append(entry)

        active_entries.sort(key=lambda x: x[0])
        inactive_entries.sort(key=lambda x: x.get('cn', [''])[0])

        return [entry for _, entry in active_entries] + inactive_entries

    def execute(self, *args, **options):
        """Override execute to preserve GPMaster ordering."""
        try:
            result = super(chain_find, self).execute(*args, **options)
        except errors.NotFound:
            return {
                'result': [],
                'count': 0,
                'truncated': False,
                'summary': self.msg_summary % {'count': 0}
            }

        return result

class ChainResolveBase(Command):
    def _get_active_chains_optimized(self):
        """Get active chains using API instead of direct LDAP."""
        gpmaster_result = api.Command.gpmaster_show()
        return gpmaster_result['result'].get('chainlist', [])

    def _get_matching_policies(self, target_groups, chain_group_attr):
        if not target_groups:
            return []

        active_chains = self._get_active_chains_optimized()
        if not active_chains:
            return []

        ordered_policies = []
        seen_policies = set()

        for chain_name in active_chains:
            try:
                chain_info = api.Command.chain_show(chain_name)['result']

                chain_groups = chain_info.get(chain_group_attr, [])
                if self._groups_match(target_groups, chain_groups):
                    for policy_name in chain_info.get('gplink', []):
                        if policy_name not in seen_policies:
                            ordered_policies.append(policy_name)
                            seen_policies.add(policy_name)
            except errors.NotFound:
                continue

        return ordered_policies

    def _groups_match(self, target_groups, chain_groups):
        for target_group in target_groups:
            for chain_group in chain_groups:
                if target_group == chain_group:
                    return True
        return False

    def _build_policies_list(self, policy_names):
        policies_list = []
        for policy_name in policy_names:
            try:
                policy_result = api.Command.gpo_show(policy_name, all=True)['result']

                display_name = _first_value(
                    policy_result.get('displayname'), policy_name
                )

                policy_dict = {
                    'name': display_name or policy_name,
                    'flags': _first_value(policy_result.get('flags'), ''),
                    'file_system_path': _first_value(
                        policy_result.get('gpcfilesyspath'), ''
                    ),
                    'version': _first_value(
                        policy_result.get('versionnumber'), ''
                    )
                }
                policies_list.append(policy_dict)

            except Exception:
                policy_dict = {
                    'name': policy_name,
                    'flags': '',
                    'file_system_path': '',
                    'version': '',
                    'error': 'Failed to retrieve policy details'
                }
                policies_list.append(policy_dict)

        return policies_list

@register()
class chain_resolve_for_user(ChainResolveBase):
    """Get applicable policies for user with essential attributes."""
    NO_CLI = True
    takes_args = (
        Str('username',
            label=_('Username'),
            doc=_('Username'),
        ),
    )

    def execute(self, username, **options):
        user_info = api.Command.user_show(username)['result']
        user_groups = list(dict.fromkeys(
            _normalize_to_list(user_info.get('memberof_group')) +
            _normalize_to_list(user_info.get('memberofindirect_group'))
        ))
        policy_names = self._get_matching_policies(user_groups, 'usergroup')
        policies_list = self._build_policies_list(policy_names)

        return {'result': policies_list}

@register()
class chain_resolve_for_host(ChainResolveBase):
    """Get applicable policies for host with essential attributes."""
    NO_CLI = True
    takes_args = (
        Str('hostname',
            label=_('Hostname'),
            doc=_('Hostname (FQDN)'),
        ),
    )

    def execute(self, hostname, **options):
        host_info = api.Command.host_show(hostname)['result']
        host_groups = list(dict.fromkeys(
            _normalize_to_list(host_info.get('memberof_hostgroup')) +
            _normalize_to_list(host_info.get('memberofindirect_hostgroup'))
        ))
        policy_names = self._get_matching_policies(
            host_groups, 'computergroup'
        )
        policies_list = self._build_policies_list(policy_names)

        return {'result': policies_list}

@register()
class chain_add_gpo(LDAPAddMember):
    """Add Group Policy Objects to a chain."""

    member_attributes = ['gplink']
    member_count_out = ('%i GPO added.', '%i GPOs added.')

    def pre_callback(self, ldap, dn, found, not_found, *keys, **options):
        """Pre-processing before adding GPOs."""
        assert isinstance(dn, DN)
        verify_gpo_schema(ldap, self.api)

        try:
            entry_attrs = ldap.get_entry(dn, self.obj.default_attributes)
            dn = entry_attrs.dn
        except errors.NotFound:
            raise self.obj.handle_not_found(*keys)

        for attr_name in self.member_attributes:
            if attr_name in found and 'gpo' in found[attr_name]:
                gpo_names = found[attr_name]['gpo'][:]
                found[attr_name]['gpo'] = []

                for gpo_value in gpo_names:
                    try:
                        gpo_displayname = self._extract_displayname_from_value(gpo_value)
                        if is_dn(gpo_displayname):
                            gpo_dn = DN(gpo_displayname)
                            ldap.get_entry(
                                gpo_dn,
                                attrs_list=GP_LOOKUP_ATTRIBUTES,
                            )
                        else:
                            gpo_dn = self.obj.find_gp_by_displayname(
                                gpo_displayname
                            )
                        found[attr_name]['gpo'].append(gpo_dn)
                    except errors.NotFound:
                        if attr_name not in not_found:
                            not_found[attr_name] = {}
                        if 'gpo' not in not_found[attr_name]:
                            not_found[attr_name]['gpo'] = []
                        not_found[attr_name]['gpo'].append((gpo_value, "GPO not found"))

        return dn

    def _extract_displayname_from_value(self, value):
        """Extract displayName from value."""
        return _extract_displayname_from_value(value)

    def post_callback(self, ldap, completed, failed, dn, entry_attrs, *keys, **options):
        """Post-processing after adding GPOs."""
        return (completed, dn)

@register()
class chain_remove_gpo(LDAPRemoveMember):
    """Remove Group Policy Objects from a chain."""

    member_attributes = ['gplink']
    member_count_out = ('%i GPO removed.', '%i GPOs removed.')

    def pre_callback(self, ldap, dn, found, not_found, *keys, **options):
        """Pre-processing before removing GPOs."""
        assert isinstance(dn, DN)
        verify_gpo_schema(ldap, self.api)

        try:
            entry_attrs = ldap.get_entry(dn, self.obj.default_attributes)
            dn = entry_attrs.dn
        except errors.NotFound:
            raise self.obj.handle_not_found(*keys)

        requested_gpos = any(
            attr_name in found and found[attr_name].get('gpo')
            for attr_name in self.member_attributes
        )
        if not requested_gpos:
            return dn

        current_gplinks = entry_attrs.get('gplink', [])
        if not current_gplinks:
            raise errors.ValidationError(
                name='gpo',
                error=_("No Group Policies assigned to this chain")
            )

        for attr_name in self.member_attributes:
            if attr_name in found and 'gpo' in found[attr_name]:
                gpo_names = found[attr_name]['gpo'][:]
                found[attr_name]['gpo'] = []

                for gpo_value in gpo_names:
                    gpo_dn = None
                    gpo_displayname = self._extract_displayname_from_value(gpo_value)

                    if is_dn(gpo_displayname):
                        requested_dn = DN(gpo_displayname)
                        for existing_dn in current_gplinks:
                            if DN(existing_dn) == requested_dn:
                                gpo_dn = existing_dn
                                break
                    else:
                        try:
                            resolved_dn = self.obj.find_gp_by_displayname(
                                gpo_displayname
                            )
                            for existing_dn in current_gplinks:
                                if DN(existing_dn) == DN(resolved_dn):
                                    gpo_dn = existing_dn
                                    break
                        except errors.NotFound:
                            pass

                    if not gpo_dn and not is_dn(gpo_displayname):
                        for existing_dn in current_gplinks:
                            try:
                                gp_entry = ldap.get_entry(DN(existing_dn),
                                                        attrs_list=GP_LOOKUP_ATTRIBUTES)
                                existing_name = get_display_name(gp_entry)
                                if existing_name == gpo_displayname:
                                    gpo_dn = existing_dn
                                    break
                            except errors.NotFound:
                                continue

                    if gpo_dn:
                        found[attr_name]['gpo'].append(gpo_dn)
                    else:
                        if attr_name not in not_found:
                            not_found[attr_name] = {}
                        if 'gpo' not in not_found[attr_name]:
                            not_found[attr_name]['gpo'] = []
                        not_found[attr_name]['gpo'].append((gpo_value, "GPO not found in chain"))

        return dn

    def _extract_displayname_from_value(self, value):
        """Extract displayName from value."""
        return _extract_displayname_from_value(value)

    def post_callback(self, ldap, completed, failed, dn, entry_attrs, *keys, **options):
        """Post-processing after removing GPOs."""
        return (completed, dn)
