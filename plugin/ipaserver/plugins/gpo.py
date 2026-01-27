import json
import logging
import uuid

import dbus
import dbus.mainloop.glib
from ipalib import api, errors, _, ngettext, Command, output
from ipalib import Str, Int
from ipalib.plugable import Registry
from ipapython.dn import DN

from ipaserver.plugins.baseldap import (
    LDAPObject, LDAPCreate, LDAPDelete, LDAPUpdate,
    LDAPSearch, LDAPRetrieve,
)

logger = logging.getLogger(__name__)
logger.debug('gpo plugin loaded')


def escape_backslashes(text):
    """
    Escape backslashes in strings for display.
    """
    if not isinstance(text, str):
        return text
    return text.replace('\\', '\\\\')

register = Registry()

PLUGIN_CONFIG = (
    ('container_system', DN(('cn', 'System'))),
    ('container_grouppolicy', DN(('cn', 'Policies'), ('cn', 'System'))),
)


@register()
class gpo(LDAPObject):
    """
    Group Policy Object.
    """
    container_dn = None
    object_name = _('Group Policy Object')
    object_name_plural = _('Group Policy Objects')
    object_class = ['groupPolicyContainer']
    permission_filter_objectclasses = ['groupPolicyContainer']
    default_attributes = [
        'cn', 'displayName', 'distinguishedName', 'flags',
        'gPCFileSysPath', 'versionNumber',
    ]
    search_display_attributes = [
        'cn', 'displayName', 'flags', 'versionNumber',
    ]
    uuid_attribute = 'cn'
    allow_rename = True
    label = _('Group Policy Objects')
    label_singular = _('Group Policy Object')

    managed_permissions = {
        'System: Read Group Policy Objects': {
            'ipapermbindruletype': 'all',
            'ipapermright': {'read', 'search', 'compare'},
            'ipapermdefaultattr': {
                'cn', 'displayName', 'distinguishedName', 'flags',
                'objectclass', 'gPCFileSysPath', 'versionNumber',
            },
        },
        'System: Read Group Policy Objects Content': {
            'ipapermbindruletype': 'permission',
            'ipapermright': {'read'},
            'default_privileges': {'Group Policy Administrators'},
        },
        'System: Add Group Policy Objects': {
            'ipapermbindruletype': 'permission',
            'ipapermright': {'add'},
            'default_privileges': {'Group Policy Administrators'},
        },
        'System: Modify Group Policy Objects': {
            'ipapermbindruletype': 'permission',
            'ipapermright': {'write'},
            'ipapermdefaultattr': {
                'displayName', 'flags',
                'gPCFileSysPath', 'versionNumber',
            },
            'default_privileges': {'Group Policy Administrators'},
        },
        'System: Remove Group Policy Objects': {
            'ipapermbindruletype': 'permission',
            'ipapermright': {'delete'},
            'default_privileges': {'Group Policy Administrators'},
        },
    }

    takes_params = (
        Str('displayname',
            label=_('Policy name'),
            doc=_('Group Policy Object display name'),
            primary_key=True,
        ),
        Str('cn?',
            label=_('Policy GUID'),
            doc=_('Group Policy Object GUID'),
        ),
        Str('distinguishedname?',
            label=_('Distinguished Name'),
            doc=_('Distinguished name of the group policy object'),
        ),
        Int('flags?',
            label=_('Flags'),
            doc=_('Group Policy Object flags'),
            default=0,
        ),
        Str('gpcfilesyspath?',
            label=_('File system path'),
            doc=_('Path to policy files on the file system'),
        ),
        Int('versionnumber?',
            label=_('Version number'),
            doc=_('Version number of the policy'),
            default=0,
            minvalue=0,
        ),
    )

    def _on_finalize(self):
        self.env._merge(**dict(PLUGIN_CONFIG))
        self.container_dn = self.env.container_grouppolicy
        super(gpo, self)._on_finalize()

    def find_gpo_by_displayname(self, ldap, displayname):
        try:
            entry = ldap.find_entry_by_attr(
                'displayName',
                displayname,
                'groupPolicyContainer',
                base_dn=DN(self.env.container_grouppolicy, self.env.basedn)
            )
            return entry
        except errors.NotFound:
            raise errors.NotFound(
                reason=_('%(pkey)s: Group Policy Object not found') % {'pkey': displayname}
            )

    def _call_dbus_method(self, method_name, guid, domain, fail_on_error=True):
        """Universal D-Bus method caller for GPO operations."""
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        params = [guid, domain]

        try:
            bus = dbus.SystemBus()
            obj = bus.get_object('org.freeipa.server', '/',
                               follow_name_owner_changes=True)
            server = dbus.Interface(obj, 'org.freeipa.server')

            method = getattr(server, method_name)
            ret, stdout, stderr = method(*params)

            if ret != 0:
                error_msg = f"Failed to {method_name.replace('_', ' ')}: {stderr}"
                logger.error(error_msg)

                if fail_on_error:
                    raise errors.ExecutionError(
                        message=_(f'Failed to {method_name.replace("_", " ")}: %(error)s')
                                % {'error': stderr or _('Unknown error')}
                    )
                else:
                    logger.warning(error_msg)


        except dbus.DBusException as e:
            error_msg = f'Failed to call D-Bus {method_name}: {str(e)}'
            logger.error(error_msg)

            if fail_on_error:
                raise errors.ExecutionError(
                    message=_('Failed to communicate with D-Bus service')
                )
            else:
                logger.warning(error_msg)

    def _call_dbus_method_with_output(self, method_name, *params, fail_on_error=True):
        """D-Bus method caller that returns stdout."""
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

        try:
            bus = dbus.SystemBus()
            obj = bus.get_object('org.freeipa.server', '/',
                               follow_name_owner_changes=True)
            server = dbus.Interface(obj, 'org.freeipa.server')

            method = getattr(server, method_name)
            ret, stdout, stderr = method(*params)

            if ret != 0:
                error_msg = f"Failed to {method_name.replace('_', ' ')}: {stderr}"
                logger.error(error_msg)

                if fail_on_error:
                    raise errors.ExecutionError(
                        message=_(f'Failed to {method_name.replace("_", " ")}: %(error)s')
                                % {'error': stderr or _('Unknown error')}
                    )
                else:
                    logger.warning(error_msg)
                    return None

            return stdout

        except dbus.DBusException as e:
            error_msg = f'Failed to call D-Bus {method_name}: {str(e)}'
            logger.error(error_msg)

            if fail_on_error:
                raise errors.ExecutionError(
                    message=_('Failed to communicate with D-Bus service')
                )
            else:
                logger.warning(error_msg)
                return None

    def _call_gpuiservice_method(self, method_name, *params):
        """Call GPUIService DBus method."""
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

        try:
            bus = dbus.SystemBus()
            obj = bus.get_object('org.altlinux.gpuiservice', '/org/altlinux/gpuiservice',
                               follow_name_owner_changes=True)
            gpuiservice = dbus.Interface(obj, 'org.altlinux.GPUIService')

            method = getattr(gpuiservice, method_name)
            result = method(*params)

            return result

        except dbus.DBusException as e:
            error_msg = f'Failed to call GPUIService DBus method {method_name}: {str(e)}'
            logger.error(error_msg)
            raise errors.ExecutionError(
                message=_('Failed to communicate with GPUIService: %(error)s') %
                        {'error': str(e)}
            )

    def parse_admx_policies(self, policy_definitions_path=None, language='en-US'):
        """
        Parse ADMX/ADML policy definitions.

        If policy_definitions_path is not provided, defaults to
        /usr/share/PolicyDefinitions/
        """
        if policy_definitions_path is None:
            policy_definitions_path = '/usr/share/PolicyDefinitions/'

        logger.debug(f"parse_admx_policies called with path={policy_definitions_path}, language={language}")

        # Call GPUIService DBus method
        try:
            # Call reload method to ensure fresh data
            self._call_gpuiservice_method('reload')

            # Get the root data structure
            result_json = self._call_gpuiservice_method('get', "/")
            if not result_json:
                raise errors.ExecutionError(
                    message=_('Failed to get ADMX policies from GPUIService')
                )

            # Parse JSON result
            result = json.loads(result_json)
            logger.debug(f"Successfully loaded ADMX policies from GPUIService")
            return result

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON from GPUIService: {e}")
            raise errors.ExecutionError(
                message=_('Failed to parse ADMX policies from GPUIService')
            )


@register()
class gpo_add(LDAPCreate):
    __doc__ = _('Create a new Group Policy Object.')
    msg_summary = _('Added Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        displayname = keys[-1]
        try:
            self.obj.find_gpo_by_displayname(ldap, displayname)
            raise errors.InvocationError(
                message=_('A Group Policy Object with displayName' \
                ' "%s" already exists.') % displayname
            )
        except errors.NotFound:
            pass

        guid = '{' + str(uuid.uuid4()).upper() + '}'
        dn = DN(('cn', guid), api.env.container_grouppolicy, api.env.basedn)
        entry_attrs['cn'] = guid
        entry_attrs['distinguishedname'] = str(dn)
        entry_attrs['gpcfilesyspath'] = (
            f"\\\\{api.env.domain}\\SysVol\\{api.env.domain}"
            f"\\Policies\\{guid}"
        )
        entry_attrs['flags'] = 0
        entry_attrs['versionnumber'] = 0

        return dn

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        guid = str(dn[0].value)
        domain = api.env.domain.lower()
        self.obj._call_dbus_method('create_gpo_structure', guid, domain, fail_on_error=True)

        return dn


@register()
class gpo_del(LDAPDelete):
    __doc__ = _("Delete a Group Policy Object.")
    msg_summary = _('Deleted Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, *keys, **options):
        entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        return entry.dn

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):

        guid = str(dn[0].value)
        domain = api.env.domain.lower()
        self.obj._call_dbus_method('delete_gpo_structure', guid, domain, fail_on_error=False)

        return dn


@register()
class gpo_show(LDAPRetrieve):
    __doc__ = _("Display information about a Group Policy Object.")
    msg_summary = _('Found Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, attrs_list, *keys, **options):
        entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        return entry.dn


@register()
class gpo_find(LDAPSearch):
    __doc__ = _("Search for Group Policy Objects.")
    msg_summary = ngettext(
        '%(count)d Group Policy Object matched',
        '%(count)d Group Policy Objects matched', 0
    )


@register()
class gpo_mod(LDAPUpdate):
    __doc__ = _("Modify a Group Policy Object.")
    msg_summary = _('Modified Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        assert isinstance(dn, DN)

        old_entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        old_dn = old_entry.dn

        if 'rename' in options and options['rename']:
            new_name = options['rename']
            if new_name == keys[0]:
                raise errors.ValidationError(
                    name='rename',
                    error=_("New name must be different from the old one")
                )
            try:
                self.obj.find_gpo_by_displayname(ldap, new_name)
                raise errors.DuplicateEntry(
                    message=_('A Group Policy Object with displayName' \
                    ' "%s" already exists.') % new_name
                )
            except errors.NotFound:
                pass

        return old_dn

@register()
class gpo_get_policy(Command):
    __doc__ = _("Get policy value from GPO.")

    takes_args = (
        Str('path',
            cli_name='path',
            label=_('Policy path'),
            doc=_('Path to the policy in GPO structure'),
        ),
    )

    has_output = (
        output.summary,
        output.Output('result', type=dict, doc=_('Policy value')),
    )

    @classmethod
    def _escape_backslashes(cls, text):
        """
        Escape backslashes in strings for display.
        """
        return escape_backslashes(text)

    @classmethod
    def _format_dict_as_kv(cls, data, indent=0):
        """
        Format dictionary as key:value pairs with indentation for nested structures.
        """
        spaces = ' ' * indent
        lines = []
        
        if isinstance(data, dict):
            for key, value in data.items():
                escaped_key = cls._escape_backslashes(key)
                if isinstance(value, (dict, list)):
                    lines.append(f'{spaces}{escaped_key}:')
                    lines.append(cls._format_dict_as_kv(value, indent + 2))
                else:
                    escaped_value = cls._escape_backslashes(value) if isinstance(value, str) else value
                    lines.append(f'{spaces}{escaped_key}: {escaped_value}')
        elif isinstance(data, list):
            for i, item in enumerate(data):
                if isinstance(item, (dict, list)):
                    lines.append(f'{spaces}-')
                    lines.append(cls._format_dict_as_kv(item, indent + 2))
                else:
                    escaped_item = cls._escape_backslashes(item) if isinstance(item, str) else item
                    lines.append(f'{spaces}- {escaped_item}')
        else:
            escaped_data = cls._escape_backslashes(data) if isinstance(data, str) else data
            lines.append(f'{spaces}{escaped_data}')
        
        return '\n'.join(lines)

    def execute(self, path, **options):
        """
        Get policy value from GPO.
        """
        try:
            logger.debug(f'gpo_get_policy called with path: {path}')

            # Call GPUIService get method
            result_json = self.api.Object.gpo._call_gpuiservice_method('get', path)

            if result_json:
                raw_result = json.loads(result_json)
            else:
                raw_result = {}

            logger.debug(f'gpo_get_policy returning result: {raw_result}')

            # Format summary based on content
            if path == '/':
                # Root path - show meta information
                meta_info = raw_result.get('meta', {})
                categories = meta_info.get('Total categories', 0)
                policies = meta_info.get('Total policies', 0)
                base_dir = meta_info.get('baseDir', '')
                locale = meta_info.get('localeUsed', '')
                summary = 'GPO structure at root: {} categories, {} policies, base dir: {}, locale: {}'.format(
                    categories, policies, base_dir, locale
                )
            elif 'meta' in raw_result and len(raw_result) == 1:
                # Only meta information
                meta_info = raw_result.get('meta', {})
                categories = meta_info.get('Total categories', 0)
                policies = meta_info.get('Total policies', 0)
                summary = 'Meta information: {} categories, {} policies'.format(categories, policies)
            elif 'displayName' in raw_result:
                # Policy with display name and header - output full nested structure
                summary = self._format_dict_as_kv(raw_result)
            elif 'category' in raw_result:
                # Category information
                category_name = raw_result.get('category', '')
                policies_dict = raw_result.get('policies', {})
                inherited_list = raw_result.get('inherited', [])

                policy_count = len(policies_dict) if isinstance(policies_dict, dict) else 0
                inherited_count = len(inherited_list) if isinstance(inherited_list, list) else 0

                summary_lines = []
                summary_lines.append('Category: {}'.format(category_name))
                if policy_count > 0:
                    summary_lines.append('Direct policies: {}'.format(policy_count))
                if inherited_count > 0:
                    summary_lines.append('Inherited subcategories: {}'.format(inherited_count))

                summary = '\n'.join(summary_lines)
            else:
                # Generic summary
                summary = 'Policy value retrieved for path: {}'.format(path)

            return {
                'summary': summary,
                'result': raw_result
            }

        except Exception as e:
            logger.exception("Unexpected error in gpo_get_policy")
            raise


@register()
class gpo_list_children(Command):
    __doc__ = _("List child policies under a parent path.")

    takes_args = (
        Str('parent_path',
            cli_name='parent_path',
            label=_('Parent path'),
            doc=_('Parent path in GPO structure'),
        ),
    )

    has_output_params = (
        Str('name', label=_('Name')),
    )

    has_output = (
        output.summary,
        output.ListOfEntries('result', doc=_('Child policies')),
    )

    def execute(self, parent_path, **options):
        """
        List child policies under a parent path.
        """
        try:
            logger.debug(f'gpo_list_children called with parent_path: {parent_path}')

            # Call GPUIService list_children method
            result_json = self.api.Object.gpo._call_gpuiservice_method('list_children', parent_path)

            if result_json:
                # GPUIService returns JSON string, parse it
                raw_result = json.loads(result_json)
                # Convert to list of dicts for CLI output
                if isinstance(raw_result, (tuple, list)):
                    result = [{'name': str(item)} for item in raw_result]
                    count = len(result)
                    formatted = "\n".join([f"- {item['name']}" for item in result])
                    summary = f"{count} child policies found:\n{formatted}"
                elif isinstance(raw_result, dict):
                    result = [{'key': k, 'value': v} for k, v in raw_result.items()]
                    summary = f"{len(result)} child policies found"
                else:
                    result = [{'value': str(raw_result)}]
                    summary = "1 child policy found"
            else:
                result = []
                summary = "No child policies found"

            logger.debug(f'gpo_list_children returning summary: {summary}, result: {result}')
            return {
                'summary': summary,
                'result': result
            }

        except Exception as e:
            logger.exception("Unexpected error in gpo_list_children")
            raise


@register()
class gpo_set_policy(Command):
    __doc__ = _("Set policy value in GPO.")

    takes_args = (
        Str('name_gpt',
            cli_name='name_gpt',
            label=_('GPO name'),
            doc=_('GPO path (relative to sysvol)'),
        ),
        Str('target',
            cli_name='target',
            label=_('Target'),
            doc=_('Policy type (Machine or User)'),
        ),
        Str('path',
            cli_name='path',
            label=_('Policy path'),
            doc=_('Path to the policy in GPO structure'),
        ),
        Str('value',
            cli_name='value',
            label=_('Value'),
            doc=_('Value to set'),
        ),
        Str('metadata?',
            label=_('Metadata'),
            doc=_('ADMX metadata path'),
        ),
    )

    has_output = (
        output.summary,
        output.Output('success', type=bool, doc=_('Operation success')),
    )

    def execute(self, name_gpt, target, path, value, metadata=None, **options):
        """
        Set policy value in GPO.
        """
        try:
            logger.debug(f'gpo_set_policy called with name_gpt: {name_gpt}, target: {target}, path: {path}, value: {value}, metadata: {metadata}')

            # Call GPUIService set method
            if metadata is None:
                metadata = ""

            success = self.api.Object.gpo._call_gpuiservice_method('set', name_gpt, target, path, value, metadata)

            logger.debug(f'gpo_set_policy returning success: {success}')
            if success:
                summary = 'Policy set successfully: {} = "{}"'.format(escape_backslashes(path), escape_backslashes(value))
            else:
                summary = 'Failed to set policy: {} = "{}"'.format(escape_backslashes(path), escape_backslashes(value))
            return {
                'summary': summary,
                'success': bool(success)
            }

        except Exception as e:
            logger.exception("Unexpected error in gpo_set_policy")
            raise


@register()
class gpo_get_current_value(Command):
    __doc__ = _("Get current value from GPO policy file.")

    takes_args = (
        Str('name_gpt',
            cli_name='name_gpt',
            label=_('GPO name'),
            doc=_('GPO path (relative to sysvol)'),
        ),
        Str('target',
            cli_name='target',
            label=_('Target'),
            doc=_('Policy type (Machine or User)'),
        ),
        Str('path',
            cli_name='path',
            label=_('Policy path'),
            doc=_('Registry key path'),
        ),
    )

    has_output = (
        output.summary,
        output.Output('result', type=dict, doc=_('Current value')),
    )

    def execute(self, name_gpt, target, path, **options):
        """
        Get current value from GPO policy file.
        """
        try:
            logger.debug(f'gpo_get_current_value called with name_gpt: {name_gpt}, target: {target}, path: {path}')

            # Call GPUIService get_current_value method
            result_json = self.api.Object.gpo._call_gpuiservice_method('get_current_value', name_gpt, target, path)

            if result_json:
                raw_result = json.loads(result_json)
            else:
                raw_result = {}

            logger.debug(f'gpo_get_current_value returning result: {raw_result}')
            
            if raw_result and 'value_data' in raw_result:
                value_data = raw_result.get('value_data', '')
                value_type = raw_result.get('value_type', '')
                summary = 'Current value: "{}" (type: {}) for GPO {}, target {}, path: {}'.format(
                    escape_backslashes(str(value_data)), value_type, name_gpt, target, escape_backslashes(path)
                )
            else:
                summary = 'Current value retrieved for GPO {}, target {}, path: {}'.format(name_gpt, target, escape_backslashes(path))
            
            return {
                'summary': summary,
                'result': raw_result
            }

        except Exception as e:
            logger.exception("Unexpected error in gpo_get_current_value")
            raise
