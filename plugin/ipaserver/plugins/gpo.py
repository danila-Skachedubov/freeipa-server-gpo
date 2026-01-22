import logging
import uuid

import dbus
import dbus.mainloop.glib
from ipalib import api, errors, _, ngettext
from ipalib import Str, Int
from ipalib import constants
from ipalib.plugable import Registry
from ipapython.dn import DN

from ipaserver.plugins.baseldap import (
    LDAPObject, LDAPCreate, LDAPDelete, LDAPUpdate,
    LDAPSearch, LDAPRetrieve,
)

logger = logging.getLogger(__name__)

register = Registry()

PLUGIN_CONFIG = (
    ('container_system', DN(('cn', 'System'))),
    ('container_grouppolicy', DN(('cn', 'Policies'), ('cn', 'System'))),
)

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
            pattern=constants.PATTERN_GROUPUSER_NAME,
            pattern_errmsg=constants.ERRMSG_GROUPUSER_NAME.format('Group Policy Object'),
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

    def __json__(self):
        """Handle missing schema gracefully."""
        try:
            return super(gpo, self).__json__()
        except KeyError as e:
            if 'groupPolicyContainer' in str(e):
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
                return result
            raise

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


@register()
class gpo_add(LDAPCreate):
    __doc__ = _('Create a new Group Policy Object.')
    msg_summary = _('Added Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        verify_gpo_schema(ldap, self.api)
        displayname = keys[-1]
        if not constants.PATTERN_GROUPUSER_NAME.match(displayname):
            raise errors.ValidationError(
                name='displayname',
                error=constants.ERRMSG_GROUPUSER_NAME.format('Group Policy Object')
            )
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
        verify_gpo_schema(ldap, self.api)
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
        verify_gpo_schema(ldap, self.api)
        entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        return entry.dn


@register()
class gpo_find(LDAPSearch):
    __doc__ = _("Search for Group Policy Objects.")
    msg_summary = ngettext(
        '%(count)d Group Policy Object matched',
        '%(count)d Group Policy Objects matched', 0
    )

    def execute(self, *args, **options):
        """Search for Group Policy Objects."""
        try:
            result = super(gpo_find, self).execute(*args, **options)
            return result

        except errors.NotFound:
            return {
                'result': [],
                'count': 0,
                'truncated': False,
                'summary': self.msg_summary % {'count': 0}
            }
        except Exception as e:
            logger.error("Error in gpo_find: %s", str(e))
            return {
                'result': [],
                'count': 0,
                'truncated': False,
                'summary': self.msg_summary % {'count': 0}
            }


@register()
class gpo_mod(LDAPUpdate):
    __doc__ = _("Modify a Group Policy Object.")
    msg_summary = _('Modified Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        verify_gpo_schema(ldap, self.api)
        assert isinstance(dn, DN)

        old_entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        old_dn = old_entry.dn

        if 'rename' in options and options['rename']:
            new_name = options['rename']
            if not constants.PATTERN_GROUPUSER_NAME.match(new_name):
                raise errors.ValidationError(
                    name='displayname',
                    error=constants.ERRMSG_GROUPUSER_NAME.format('Group Policy Object')
                )
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
