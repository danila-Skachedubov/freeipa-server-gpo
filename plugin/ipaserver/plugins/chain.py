import logging

from ipalib import api, errors, _, ngettext
from ipalib import Str, Command, output, Flag, Bool
from ipalib.plugable import Registry
from ipapython.dn import DN

from ipaserver.plugins.baseldap import (
    LDAPObject, LDAPCreate, LDAPDelete, LDAPUpdate,
    LDAPSearch, LDAPRetrieve, LDAPAddMember, LDAPRemoveMember,
)

logger = logging.getLogger(__name__)
register = Registry()

PLUGIN_CONFIG = (
    ('container_system', DN(('cn', 'System'))),
    ('container_grouppolicychain', DN(('cn', 'System'))),
)

OBJECT_TYPE_MAPPING = {
    'usergroup': ('group', 'cn'),
    'computergroup': ('hostgroup', 'cn'),
}

GP_LOOKUP_ATTRIBUTES = ['displayName', 'cn']

def _normalize_to_list(value):
    """Normalize value to list."""
    if isinstance(value, str):
        return [value]
    elif isinstance(value, (tuple, set)):
        return list(value)
    elif value is None:
        return []
    return list(value)

def is_dn(value):
    """Check if the string looks like a DN."""
    return str(value).lower().startswith('cn=')

def get_display_name(entry):
    """Get displayName or fallback to cn or DN string."""
    return (
        entry.get('displayName', [None])[0] or
        entry.get('cn', [None])[0] or
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
    default_attributes = ['cn', 'displayName', 'userGroup', 'computerGroup', 'gpLink', 'active']
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
                'cn', 'objectclass', 'displayname', 'usergroup',
                'computergroup', 'gplink', 'active'
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
                'cn', 'displayname', 'usergroup', 'computergroup', 'gplink', 'active'
            },
            'default_privileges': {'Group Policy Administrators'},
        },
    }

    takes_params = (
        Str('cn', cli_name='name', label=_('Chain name'),
            doc=_('Group Policy Chain name'), primary_key=True,
            autofill=False),
        Str('displayname?', cli_name='display_name',
            label=_('Display name'),
            doc=_('Display name for the chain')),
        Str('usergroup?', cli_name='user_group', label=_('User group'),
            doc=_('User group name for this chain')),
        Str('computergroup?', cli_name='computer_group',
            label=_('Computer group'),
            doc=_('Computer group name for this chain')),
        Str('gplink*', cli_name='gp_link', label=_('Group Policy links'),
            doc=_('List of Group Policy Container names')),
        Bool('active?', cli_name='active', label=_('Active'),
             doc=_('Whether this chain is active'), default=False),
    )

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
        try:
            ldap = self.api.Backend.ldap2

            active_value = entry_attrs.get('active', [])
            if active_value:
                if isinstance(active_value, list):
                    is_true = (active_value[0].upper() == 'TRUE'
                            if isinstance(active_value[0], str)
                            else bool(active_value[0]))
                    entry_attrs['active'] = [is_true]
                else:
                    is_true = (active_value.upper() == 'TRUE'
                              if isinstance(active_value, str)
                              else bool(active_value))
                    entry_attrs['active'] = [is_true]
            else:
                entry_attrs['active'] = [False]

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
        if name.startswith(('cn=', 'CN=')):
            return name

        try:
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

    def update_chain_active_status(self, chain_dn, active):
        """Update active status of chain in LDAP."""
        try:
            ldap = self.api.Backend.ldap2
            entry = ldap.get_entry(chain_dn, attrs_list=['active'])
            entry['active'] = ['TRUE' if active else 'FALSE']
            ldap.update_entry(entry)
        except Exception as e:
            logger.error("Failed to update chain '%s' active status: %s", chain_dn, str(e))
            raise

@register()
class chain_show(LDAPRetrieve):
    """Display information about a Group Policy Chain."""

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        if not options.get('raw', False):
            self.obj.convert_attribute_members(entry_attrs, *keys, **options)
        return dn

class chain_toggle_base(Command):
    def _toggle_chain(self, cn, enable=True):
        try:
            chain_result = api.Command.chain_show(cn)
            current_active = chain_result['result'].get('active', [False])[0]

            if enable and current_active:
                raise errors.ValidationError(
                    name='chain',
                    error=_("Chain '{}' is already enabled").format(cn)
                )
            if not enable and not current_active:
                raise errors.ValidationError(
                    name='chain',
                    error=_("Chain '{}' is already disabled").format(cn)
                )

            chain_dn = api.Object.chain.get_dn(cn)
            api.Object.chain.update_chain_active_status(chain_dn, enable)

            if enable:
                try:
                    api.Command.gpmaster_mod(add_chain=[cn])
                except Exception:
                    pass
            else:
                try:
                    api.Command.gpmaster_mod(remove_chain=[cn])
                except Exception:
                    pass

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
        converted = self.obj.convert_names_to_dns(options, strict=True)
        entry_attrs.update(converted)
        entry_attrs['active'] = 'TRUE'
        return dn

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        """Automatically add chain to GPMaster."""
        chain_name = keys[0]

        try:
            gpmaster_result = api.Command.gpmaster_show()
            current_chains = gpmaster_result['result'].get('chainlist', [])

            if chain_name not in current_chains:
                api.Command.gpmaster_mod(add_chain=[chain_name])
        except Exception:
            pass

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

    def execute(self, *keys, **options):
        """Handle move operations separately, everything else normally."""
        if ('moveup_gpc' in options and options['moveup_gpc']) or \
           ('movedown_gpc' in options and options['movedown_gpc']):

            ldap = self.api.Backend.ldap2
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
        entry = ldap.get_entry(dn, attrs_list=['gplink'])
        current_gplinks = [str(gp_dn) for gp_dn in entry.get('gplink', [])]

        if len(current_gplinks) < 2:
            return

        gp_names = options.get('moveup_gpc') or options.get('movedown_gpc')
        direction = 'up' if 'moveup_gpc' in options else 'down'

        if isinstance(gp_names, str):
            gp_names = [gp_names]
        elif isinstance(gp_names, tuple):
            gp_names = list(gp_names)

        for gp_name in gp_names:
            gp_dn = None
            for existing_dn in current_gplinks:
                try:
                    gp_entry = ldap.get_entry(DN(existing_dn), attrs_list=GP_LOOKUP_ATTRIBUTES)
                    display_name = (
                        gp_entry.get('displayName', [None])[0] or
                        gp_entry.get('cn', [None])[0]
                    )
                    if display_name == gp_name:
                        gp_dn = existing_dn
                        break
                except Exception:
                    continue
            if not gp_dn:
                continue

            current_index = current_gplinks.index(gp_dn)
            if direction == 'up' and current_index > 0:
                new_index = current_index - 1
            elif direction == 'down' and current_index < len(current_gplinks) - 1:
                new_index = current_index + 1
            else:
                continue
            gp_to_move = current_gplinks.pop(current_index)
            current_gplinks.insert(new_index, gp_to_move)

        entry['gplink'] = []
        ldap.update_entry(entry)

        entry = ldap.get_entry(dn)
        entry['gplink'] = current_gplinks
        ldap.update_entry(entry)

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        """Standard operations only - move operations handled in execute."""
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
                    name='remove_user_group',
                    error=_("No user group assigned to this chain")
                )
            entry_attrs['usergroup'] = None

        if 'remove_computergroup' in options and options['remove_computergroup']:
            if not current_entry.get('computergroup'):
                raise errors.ValidationError(
                    name='remove_computer_group',
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

    def __init__(self, *args, **kwargs):
        super(chain_find, self).__init__(*args, **kwargs)
        self._ordered_entries = None

    def args_options_2_entry(self, *args, **options):
        """Convert search options to LDAP entry attributes for filtering."""
        converted = self.obj.convert_names_to_dns(options, strict=False)
        options.update(converted)
        return super(chain_find, self).args_options_2_entry(*args, **options)

    def post_callback(self, ldap, entries, truncated, *args, **options):
        """Sort chains by GPMaster order."""

        if not options.get('raw', False) and entries:
            for entry_attrs in entries:
                entry_attrs['_chain_find_processed'] = True

            try:
                gpmaster_result = api.Command.gpmaster_show()
                gpmaster_chains = gpmaster_result['result'].get('chainlist', [])
            except Exception:
                gpmaster_chains = []

            self.obj._convert_groups(entries, ldap)
            self.obj._convert_gpos(entries, ldap)

            for entry_attrs in entries:
                chain_name = entry_attrs.get('cn', [None])
                if chain_name and isinstance(chain_name, list):
                    chain_name = chain_name[0]
                    is_active = chain_name in gpmaster_chains
                    entry_attrs['active'] = [is_active]

                    try:
                        current_ldap_active = entry_attrs.get('active', [False])
                        ldap_active_bool = current_ldap_active[0] if current_ldap_active else False
                        if isinstance(ldap_active_bool, str):
                            ldap_active_bool = ldap_active_bool.upper() == 'TRUE'

                        if ldap_active_bool != is_active:
                            chain_dn = api.Object.chain.get_dn(chain_name)
                            self.obj.update_chain_active_status(chain_dn, is_active)
                    except Exception:
                        pass
                else:
                    entry_attrs['active'] = [False]

                entry_attrs.pop('gplink_gpo', None)

            ordered_entries = self._order_by_gpmaster(entries, gpmaster_chains)
        else:
            ordered_entries = entries

        entries.clear()
        entries.extend(ordered_entries)
        self._ordered_entries = entries[:]

        return truncated

    def _order_by_gpmaster(self, entries, gpmaster_chains):
        """Sort chains by GPMaster order."""
        if not gpmaster_chains:
            return entries

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
        result = super(chain_find, self).execute(*args, **options)

        if (self._ordered_entries and 'result' in result and isinstance(result['result'], list)):
            result_entries = {}
            for entry in result['result']:
                cn = entry.get('cn', [])
                if cn and isinstance(cn, list):
                    result_entries[cn[0]] = entry

            ordered_result = []
            for ordered_entry in self._ordered_entries:
                cn = ordered_entry.get('cn', [])
                if cn and isinstance(cn, list) and cn[0] in result_entries:
                    ordered_result.append(result_entries[cn[0]])

            result['result'] = ordered_result
            result['count'] = len(ordered_result)

        return result

class ChainResolveBase(Command):
    def _get_active_chains_optimized(self):
        """Get active chains directly from LDAP."""
        try:
            ldap = self.api.Backend.ldap2
            base_dn = DN(('cn', 'System'), self.api.env.basedn)
            filter_str = '(&(objectClass=groupPolicyChain)(active=TRUE))'

            entries = ldap.find_entries(
                filter=filter_str,
                base_dn=base_dn,
                attrs_list=['cn']
            )[0]

            return [entry.get('cn', [None])[0] for entry in entries if entry.get('cn')]
        except Exception:
            return []

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
            except Exception:
                continue

        return ordered_policies

    def _groups_match(self, target_groups, chain_groups):
        for target_group in target_groups:
            for chain_group in chain_groups:
                if target_group in chain_group:
                    return True
        return False

    def _build_policies_list(self, policy_names):
        policies_list = []
        for policy_name in policy_names:
            try:
                policy_result = api.Command.gpo_show(policy_name, all=True)['result']

                policy_dict = {
                    'name': policy_result.get('displayname', [''])[0] or policy_name,
                    'flags': policy_result.get('flags', [''])[0] or '',
                    'file_system_path': policy_result.get('gpcfilesyspath', [''])[0] or '',
                    'version': policy_result.get('versionnumber', [''])[0] or ''
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

    takes_args = (
        Str('username',
            label=_('Username'),
            doc=_('Username'),
        ),
    )

    def execute(self, username, **options):
        try:
            user_groups = api.Command.user_show(username)['result'].get('memberof_group', [])
            policy_names = self._get_matching_policies(user_groups, 'usergroup')
            policies_list = self._build_policies_list(policy_names)

            return {'result': policies_list}

        except Exception:
            return {'result': []}

@register()
class chain_resolve_for_host(ChainResolveBase):
    """Get applicable policies for host with essential attributes."""

    takes_args = (
        Str('hostname',
            label=_('Hostname'),
            doc=_('Hostname (FQDN)'),
        ),
    )

    def execute(self, hostname, **options):
        try:
            host_groups = api.Command.host_show(hostname)['result'].get('memberof_hostgroup', [])
            policy_names = self._get_matching_policies(host_groups, 'computergroup')
            policies_list = self._build_policies_list(policy_names)

            return {'result': policies_list}

        except Exception:
            return {'result': []}

@register()
class chain_add_gpo(LDAPAddMember):
    """Add Group Policy Objects to a chain."""

    member_attributes = ['gplink']
    member_count_out = ('%i GPO added.', '%i GPOs added.')

    def pre_callback(self, ldap, dn, found, not_found, *keys, **options):
        """Pre-processing before adding GPOs."""
        assert isinstance(dn, DN)

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
                        gpo_dn = self.obj.find_gp_by_displayname(gpo_displayname)
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
        if isinstance(value, str):
            if value.startswith('displayname='):
                displayname_part = value.split(',')[0]
                return displayname_part.replace('displayname=', '')
            else:
                return value
        else:
            return self._extract_displayname_from_value(str(value))

    def post_callback(self, ldap, completed, dn, entry_attrs, *keys, **options):
        """Post-processing after adding GPOs."""
        if not options.get('raw', False):
            self.obj.convert_attribute_members(entry_attrs, *keys, **options)

        return (completed, dn)

@register()
class chain_remove_gpo(LDAPRemoveMember):
    """Remove Group Policy Objects from a chain."""

    member_attributes = ['gplink']
    member_count_out = ('%i GPO removed.', '%i GPOs removed.')

    def pre_callback(self, ldap, dn, found, not_found, *keys, **options):
        """Pre-processing before removing GPOs."""
        assert isinstance(dn, DN)

        try:
            entry_attrs = ldap.get_entry(dn, self.obj.default_attributes)
            dn = entry_attrs.dn
        except errors.NotFound:
            raise self.obj.handle_not_found(*keys)

        current_gplinks = entry_attrs.get('gplink', [])
        if not current_gplinks:
            raise errors.ValidationError(
                name='gplink',
                error=_("No Group Policies assigned to this chain")
            )

        for attr_name in self.member_attributes:
            if attr_name in found and 'gpo' in found[attr_name]:
                gpo_names = found[attr_name]['gpo'][:]
                found[attr_name]['gpo'] = []

                for gpo_value in gpo_names:
                    gpo_dn = None
                    gpo_displayname = self._extract_displayname_from_value(gpo_value)

                    try:
                        gpo_dn = self.obj.find_gp_by_displayname(gpo_displayname)
                    except errors.NotFound:
                        for existing_dn in current_gplinks:
                            try:
                                gp_entry = ldap.get_entry(DN(existing_dn),
                                                        attrs_list=GP_LOOKUP_ATTRIBUTES)
                                existing_name = (
                                    gp_entry.get('displayName', [None])[0] or
                                    gp_entry.get('cn', [None])[0]
                                )
                                if existing_name == gpo_displayname:
                                    gpo_dn = existing_dn
                                    break
                            except Exception:
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
        if isinstance(value, str):
            if value.startswith('displayname='):
                displayname_part = value.split(',')[0]
                return displayname_part.replace('displayname=', '')
            else:
                return value
        else:
            return self._extract_displayname_from_value(str(value))

    def post_callback(self, ldap, completed, dn, entry_attrs, *keys, **options):
        """Post-processing after removing GPOs."""
        if not options.get('raw', False):
            self.obj.convert_attribute_members(entry_attrs, *keys, **options)

        return (completed, dn)
