from ipalib import api, errors
from ipalib import Str, Command
from ipalib.plugable import Registry
from .baseldap import (
    LDAPObject,
    LDAPUpdate,
    LDAPRetrieve,
)
from ipalib import _, ngettext
from ipapython.dn import DN
from ipalib import Int, Str, Flag
import logging

logger = logging.getLogger(__name__)

register = Registry()

PLUGIN_CONFIG = (
    ('container_system', DN(('cn', 'System'))),
    ('container_gpmaster', DN(('cn', 'etc'))),
)


@register()
class gpmaster(LDAPObject):
    """
    Group Policy Master object.
    """
    container_dn = None
    object_name = _('Group Policy Master')
    object_name_plural = _('Group Policy Masters')
    object_class = ['groupPolicyMaster']
    permission_filter_objectclasses = ['groupPolicyMaster']
    default_attributes = [
        'cn', 'chainList', 'pdcEmulator'
    ]
    allow_rename = False

    label = _('Group Policy Master')
    label_singular = _('Group Policy Master')

    managed_permissions = {
        'System: Read Group Policy Master': {
            'replaces_global_anonymous_aci': True,
            'ipapermbindruletype': 'all',
            'ipapermright': {'read', 'search', 'compare'},
            'ipapermdefaultattr': {
                'cn', 'objectclass', 'chainlist', 'pdcemulator'
            },
        },
        'System: Modify Group Policy Master': {
            'ipapermright': {'write'},
            'ipapermdefaultattr': {
                'chainlist', 'pdcemulator'
            },
            'default_privileges': {'Group Policy Administrators'},
        },
    }

    takes_params = (
        Str('cn',
            cli_name='name',
            label=_('Master name'),
            doc=_('Group Policy Master name'),
            primary_key=True,
            autofill=False,
            default='grouppolicymaster',
        ),
        Str('chainlist*',
            cli_name='chain_list',
            label=_('Chain list'),
            doc=_('Ordered list of Group Policy Chain DNs'),
        ),
        Str('pdcemulator?',
            cli_name='pdc_emulator',
            label=_('PDC Emulator'),
            doc=_('PDC Emulator server name'),
        ),
    )

    def _on_finalize(self):
        self.env._merge(**dict(PLUGIN_CONFIG))
        self.container_dn = self.env.container_gpmaster
        super(gpmaster, self)._on_finalize()

    def resolve_chain_name(self, chain_name, strict=False):
        """Convert chain name to DN."""
        if chain_name.startswith(('cn=', 'CN=')):
            return chain_name
        
        try:
            # Construct chain DN
            chain_dn = DN(('cn', chain_name), 
                         ('cn', 'System'), 
                         api.env.basedn)
            
            if strict:
                # Verify chain exists
                ldap = self.api.Backend.ldap2
                ldap.get_entry(chain_dn, attrs_list=['cn'])
                
            logger.debug("Resolved chain '%s' to DN: %s", chain_name, chain_dn)
            return str(chain_dn)
            
        except errors.NotFound:
            if strict:
                raise errors.NotFound(
                    reason=_("Chain '{}' not found").format(chain_name)
                )
            logger.warning("Chain '%s' not found", chain_name)
            return chain_name
        except Exception as e:
            if strict:
                raise errors.ValidationError(
                    name='chain',
                    error=_("Failed to resolve chain '{}': {}").format(chain_name, str(e))
                )
            logger.warning("Failed to resolve chain '%s': %s", chain_name, e)
            return chain_name

    def convert_chain_names_to_dns(self, chain_names, strict=False):
        """Convert chain names to DNs."""
        if not chain_names:
            return []
            
        def resolve_chain(name):
            return self.resolve_chain_name(str(name), strict)
        
        if isinstance(chain_names, str):
            return [resolve_chain(chain_names)]
        elif isinstance(chain_names, tuple):
            return list(map(resolve_chain, chain_names))
        else:
            return list(map(resolve_chain, chain_names))

    def convert_chain_dns_to_names(self, ldap, chain_dns):
        """Convert chain DNs to readable names."""
        if not chain_dns:
            return []
            
        chain_names = []
        for chain_dn in chain_dns:
            try:
                dn_obj = DN(chain_dn)
                entry = ldap.get_entry(dn_obj, attrs_list=['cn'])
                chain_name = entry['cn'][0]
                chain_names.append(chain_name)
            except errors.NotFound:
                # Chain was deleted, keep DN as-is
                chain_names.append(chain_dn)
            except Exception as e:
                logger.warning("Error converting chain DN %s: %s", chain_dn, str(e))
                chain_names.append(chain_dn)
                
        return chain_names

    def get_gpmaster_dn(self):
        """Get GPMaster DN."""
        return DN(('cn', 'grouppolicymaster'), 
                 ('cn', 'etc'), 
                 api.env.basedn)


def _normalize_to_list(value):
    """Normalize value to list."""
    if isinstance(value, str):
        return [value]
    elif isinstance(value, tuple):
        return list(value)
    else:
        return list(value)


@register()
class gpmaster_mod(LDAPUpdate):
    __doc__ = _('Modify Group Policy Master.')
    msg_summary = _('Modified Group Policy Master "%(value)s"')

    takes_options = (
        Str('add_chain*',
            cli_name='add_chain',
            label=_('Add chains'),
            doc=_('Add chains to master chain list'),
        ),
        Str('remove_chain*',
            cli_name='remove_chain',
            label=_('Remove chains'),
            doc=_('Remove chains from master chain list'),
        ),
        Str('moveup_chain*',
            cli_name='moveup_chain',
            label=_('Move chain up'),
            doc=_('Move chain higher in priority'),
        ),
        Str('movedown_chain*',
            cli_name='movedown_chain',
            label=_('Move chain down'),
            doc=_('Move chain lower in priority'),
        ),
    )

    def execute(self, *keys, **options):
        """Handle move operations separately, everything else normally."""

        if ('moveup_chain' in options and options['moveup_chain']) or \
           ('movedown_chain' in options and options['movedown_chain']):

            ldap = self.api.Backend.ldap2
            dn = self.obj.get_gpmaster_dn()

            self._do_move_operation(ldap, dn, keys, options)

            entry_attrs = ldap.get_entry(dn, self.obj.default_attributes)
            if not options.get('raw', False):
                if 'chainlist' in entry_attrs:
                    chain_names = self.obj.convert_chain_dns_to_names(ldap, entry_attrs['chainlist'])
                    entry_attrs['chainlist'] = chain_names

            result_dict = {}
            for attr_name in entry_attrs:
                attr_value = entry_attrs[attr_name]
                if isinstance(attr_value, list) and len(attr_value) == 1 and attr_name not in ['chainlist']:
                    result_dict[attr_name] = attr_value[0]
                else:
                    result_dict[attr_name] = attr_value

            return {
                'result': result_dict,
                'value': keys[0] if keys else 'grouppolicymaster',
                'summary': self.msg_summary % {'value': keys[0] if keys else 'grouppolicymaster'}
            }

        return super(gpmaster_mod, self).execute(*keys, **options)

    def _do_move_operation(self, ldap, dn, keys, options):
        """Move chain operation."""

        entry = ldap.get_entry(dn, attrs_list=['chainlist'])
        current_chains = [str(chain_dn) for chain_dn in entry.get('chainlist', [])]

        if len(current_chains) < 2:
            return

        chain_names = options.get('moveup_chain') or options.get('movedown_chain')
        direction = 'up' if 'moveup_chain' in options else 'down'

        if isinstance(chain_names, str):
            chain_names = [chain_names]
        elif isinstance(chain_names, tuple):
            chain_names = list(chain_names)

        for chain_name in chain_names:
            # Find chain DN by name
            chain_dn = None
            for existing_dn in current_chains:
                try:
                    chain_entry = ldap.get_entry(DN(existing_dn), attrs_list=['cn'])
                    existing_name = chain_entry.get('cn', [None])[0]
                    if existing_name == chain_name:
                        chain_dn = existing_dn
                        break
                except:
                    continue
                    
            if not chain_dn:
                continue

            current_index = current_chains.index(chain_dn)
            if direction == 'up' and current_index > 0:
                new_index = current_index - 1
            elif direction == 'down' and current_index < len(current_chains) - 1:
                new_index = current_index + 1
            else:
                continue
                
            chain_to_move = current_chains.pop(current_index)
            current_chains.insert(new_index, chain_to_move)

        # Update entry
        entry['chainlist'] = []
        ldap.update_entry(entry)

        entry = ldap.get_entry(dn)
        entry['chainlist'] = current_chains
        ldap.update_entry(entry)

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        """Handle add/remove operations."""

        current_entry = ldap.get_entry(dn, attrs_list=['chainlist'])

        self._handle_add_operations(entry_attrs, options)
        self._handle_remove_operations(ldap, current_entry, entry_attrs, options)
        self._handle_standard_modifications(entry_attrs, options)

        return dn

    def _handle_add_operations(self, entry_attrs, options):
        """Handle add chain operations."""

        if 'add_chain' in options and options['add_chain']:
            ldap = self.api.Backend.ldap2
            gpmaster_dn = self.obj.get_gpmaster_dn()
            current_entry = ldap.get_entry(gpmaster_dn, attrs_list=['chainlist'])
            current_chains = [str(dn) for dn in current_entry.get('chainlist', [])]

            chain_names = _normalize_to_list(options['add_chain'])

            for chain_name in chain_names:
                try:
                    chain_dn = self.obj.resolve_chain_name(chain_name, strict=True)
                    if chain_dn not in current_chains:
                        current_chains.append(chain_dn)
                        logger.debug("Added chain '%s' to GPMaster", chain_name)
                    else:
                        logger.warning("Chain '%s' already exists in GPMaster", chain_name)

                except errors.NotFound:
                    raise errors.NotFound(
                        reason=_("Chain '{}' not found").format(chain_name)
                    )

            if current_chains:
                entry_attrs['chainlist'] = current_chains

    def _handle_remove_operations(self, ldap, current_entry, entry_attrs, options):
        """Handle remove chain operations."""

        if 'remove_chain' in options and options['remove_chain']:
            chain_names = _normalize_to_list(options['remove_chain'])
            current_chains = [str(dn) for dn in current_entry.get('chainlist', [])]

            if not current_chains:
                raise errors.ValidationError(
                    name='remove_chain',
                    error=_("No chains assigned to GPMaster")
                )

            for chain_name in chain_names:
                removed = False
                
                # Try to find by resolved DN
                try:
                    chain_dn = self.obj.resolve_chain_name(chain_name, strict=False)
                    if chain_dn in current_chains:
                        current_chains.remove(chain_dn)
                        removed = True
                        logger.debug("Removed chain '%s' from GPMaster", chain_name)
                except:
                    pass

                # If not found by DN, try to find by name lookup
                if not removed:
                    for existing_dn in current_chains[:]:
                        try:
                            chain_entry = ldap.get_entry(DN(existing_dn), attrs_list=['cn'])
                            existing_name = chain_entry.get('cn', [None])[0]
                            if existing_name == chain_name:
                                current_chains.remove(existing_dn)
                                removed = True
                                logger.debug("Removed chain '%s' from GPMaster by name", chain_name)
                                break
                        except errors.NotFound:
                            continue

                if not removed:
                    raise errors.NotFound(
                        reason=_("Chain '{}' not found in GPMaster").format(chain_name)
                    )

            entry_attrs['chainlist'] = current_chains if current_chains else []

    def _handle_standard_modifications(self, entry_attrs, options):
        """Handle standard modification operations."""
        
        if 'pdcemulator' in options and options['pdcemulator']:
            entry_attrs['pdcemulator'] = options['pdcemulator']

        if 'chainlist' in options and options['chainlist']:
            converted_chains = self.obj.convert_chain_names_to_dns(options['chainlist'], strict=True)
            entry_attrs['chainlist'] = converted_chains


@register()
class gpmaster_show(LDAPRetrieve):
    __doc__ = _('Display information about Group Policy Master.')

    def get_args(self):
        # Override to make cn optional with default value
        return ()

    def execute(self, *keys, **options):
        # Use default GPMaster DN
        gpmaster_dn = self.obj.get_gpmaster_dn()

        try:
            ldap = self.api.Backend.ldap2
            entry_attrs = ldap.get_entry(gpmaster_dn, self.obj.default_attributes)

            if not options.get('raw', False):
                if 'chainlist' in entry_attrs:
                    chain_names = self.obj.convert_chain_dns_to_names(ldap, entry_attrs['chainlist'])
                    entry_attrs['chainlist'] = chain_names

            result_dict = {}
            for attr_name in entry_attrs:
                attr_value = entry_attrs[attr_name]
                if isinstance(attr_value, list) and len(attr_value) == 1 and attr_name not in ['chainlist']:
                    result_dict[attr_name] = attr_value[0]
                else:
                    result_dict[attr_name] = attr_value

            return {
                'result': result_dict,
                'value': 'grouppolicymaster',
                'summary': None
            }

        except errors.NotFound:
            raise errors.NotFound(
                reason=_("Group Policy Master not found")
            )