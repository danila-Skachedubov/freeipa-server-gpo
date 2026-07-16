import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

import dbus
import dbus.mainloop.glib
import ldap as _ldap
from ipalib import Command, Int, Str, _, api, constants, errors, ngettext, output
from ipalib.parameters import Dict
from ipalib.plugable import Registry
from ipapython.dn import DN

from ipaserver.plugins.baseldap import (
    LDAPObject, LDAPCreate, LDAPDelete, LDAPUpdate,
    LDAPSearch, LDAPRetrieve,
)

logger = logging.getLogger(__name__)
logger.debug('gpo plugin loaded')

register = Registry()

_bus = None
_bus_initialized = False


def _get_bus():
    global _bus, _bus_initialized
    if not _bus_initialized:
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        _bus = dbus.SystemBus()
        _bus_initialized = True
    return _bus


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


# The editor is an independently versioned binding contract.  Keep the entire
# compatibility boundary in one place instead of using the RPM version as a
# proxy for API compatibility.
ADMIX_BINDING_API_VERSION = 3
ADMIX_REQUIRED_CAPABILITIES = frozenset({
    'typed-policy-values',
    'atomic-policy-updates',
    'policy-capabilities',
    'element-policy-state-actions',
    'raw-policy-diagnostics',
    'preference-item-lifecycle',
    'preference-filter-lifecycle',
    'preference-field-controls',
    'preference-parent-candidates',
    'policy-comments',
    'external-publication-recovery',
    'snapshot-verified-publication',
    'reusable-template-catalog',
    'external-file-publication-resume',
    'external-no-publication-required',
    'planner-owned-extension-values',
})

GPO_TEMPLATE_ROOT = Path('/usr/share/PolicyDefinitions')
GPO_SYSVOL_ROOT = Path('/var/lib/freeipa/sysvol')
GPO_EDITOR_STATE_DIRECTORY = Path('/var/lib/freeipa/gpo-editor-state')
GPO_CATALOG_REFRESH_INTERVAL = 5.0

GPC_SNAPSHOT_ATTRIBUTES = (
    'cn',
    'displayname',
    'distinguishedname',
    'gpcfilesyspath',
    'versionnumber',
    'gpcmachineextensionnames',
    'gpcuserextensionnames',
)
GPC_PUBLICATION_ATTRIBUTES = (
    'gpcfilesyspath',
    'versionnumber',
    'gpcmachineextensionnames',
    'gpcuserextensionnames',
)

# 389-DS does not implement RFC 4528 Assertion Control.  A schema-valid
# temporary value lets one ordered atomic LDAP Modify assert that a
# SINGLE-VALUE extension attribute is absent while leaving it absent.
GPC_ABSENT_EXTENSION_PROBE = (
    '[{00000000-0000-0000-0000-000000000000}'
    '{00000000-0000-0000-0000-000000000000}]'
)

_GUID_RE = re.compile(
    r'^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-'
    r'[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$'
)
_UNC_RE = re.compile(
    r'^\\\\([^\\]+)\\sysvol\\([^\\]+)\\policies\\(\{[^\\]+\})$',
    re.IGNORECASE,
)
_LOCALE_RE = re.compile(r'^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$')

_catalog_lock = threading.RLock()
_catalog = None
_catalog_last_refresh = 0.0
_catalog_refresh_result = None
_admix_module = None


class EditorFailure(Exception):
    """An internal, structured editor error safe to translate at the RPC edge."""

    def __init__(self, category, message, field=None, path=None, details=None):
        super().__init__(message)
        self.category = category
        self.message = message
        self.field = field
        self.path = path
        self.details = details


class EditorContext:
    """Trusted request context.  Filesystem fields never leave the plugin."""

    __slots__ = (
        'displayname', 'guid', 'dn', 'file_sys_path', 'gpo_root',
        'snapshot', 'presence',
    )

    def __init__(
        self, displayname, guid, dn, file_sys_path, gpo_root, snapshot,
        presence,
    ):
        self.displayname = displayname
        self.guid = guid
        self.dn = dn
        self.file_sys_path = file_sys_path
        self.gpo_root = gpo_root
        self.snapshot = snapshot
        self.presence = presence


def _load_admix():
    """Import the binding lazily so ordinary LDAP GPO CRUD remains usable."""
    global _admix_module
    if _admix_module is None:
        try:
            import admix
        except Exception as exc:
            raise EditorFailure(
                'operational',
                'The Group Policy editor binding is not available.',
            ) from exc
        _admix_module = admix
    return _admix_module


def _binding_info(module=None):
    module = module or _load_admix()
    try:
        version = int(module.HighLevelApi.binding_api_version())
        capabilities = frozenset(module.HighLevelApi.binding_capabilities())
    except Exception as exc:
        raise EditorFailure(
            'operational',
            'The Group Policy editor binding cannot report its compatibility.',
        ) from exc

    missing = sorted(ADMIX_REQUIRED_CAPABILITIES - capabilities)
    if version != ADMIX_BINDING_API_VERSION or missing:
        details = {
            'required_api_version': ADMIX_BINDING_API_VERSION,
            'installed_api_version': version,
            'missing_capabilities': missing,
        }
        raise EditorFailure(
            'operational',
            'The installed Group Policy editor binding is incompatible.',
            details=details,
        )
    return {
        'api_version': version,
        'capabilities': sorted(capabilities),
    }


def _entry_values(entry, attribute):
    """Return decoded LDAP values from LDAPEntry or a lightweight test double."""
    names = (attribute, attribute.lower(), attribute.upper())
    value = None
    for name in names:
        try:
            if name in entry:
                value = entry[name]
                break
        except (KeyError, TypeError):
            continue
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        value = [value]
    result = []
    for item in value:
        if isinstance(item, bytes):
            item = item.decode('utf-8')
        result.append(item)
    return result


def _entry_text(entry, attribute, default=''):
    values = _entry_values(entry, attribute)
    if not values:
        return default
    return str(values[0])


def _canonical_guid(value):
    value = str(value or '')
    if not _GUID_RE.fullmatch(value):
        raise EditorFailure(
            'validation',
            'The Group Policy Object has an invalid GUID.',
            field='cn',
        )
    try:
        return '{' + str(uuid.UUID(value[1:-1])).upper() + '}'
    except (ValueError, AttributeError) as exc:
        raise EditorFailure(
            'validation',
            'The Group Policy Object has an invalid GUID.',
            field='cn',
        ) from exc


def _canonical_unc(domain, guid):
    return '\\\\{0}\\SysVol\\{0}\\Policies\\{1}'.format(domain, guid)


def _validate_unc(value, domain, guid):
    value = str(value or '').rstrip('\\')
    match = _UNC_RE.fullmatch(value)
    if not match:
        raise EditorFailure(
            'validation',
            'The Group Policy Object has an invalid file location.',
            field='gpcfilesyspath',
        )
    server, share_domain, unc_guid = match.groups()
    try:
        unc_guid = _canonical_guid(unc_guid)
    except EditorFailure as exc:
        raise EditorFailure(
            'validation',
            'The Group Policy Object has an invalid file location.',
            field='gpcfilesyspath',
        ) from exc
    if (
        server.casefold() != domain.casefold()
        or share_domain.casefold() != domain.casefold()
        or unc_guid != guid
    ):
        raise EditorFailure(
            'validation',
            'The Group Policy Object file location does not match its identity.',
            field='gpcfilesyspath',
        )
    return _canonical_unc(domain, guid)


def _authorize_editor(ldap_backend, dn, write=False):
    attributes = GPC_PUBLICATION_ATTRIBUTES if write else ('versionnumber',)
    try:
        authorized = all(
            ldap_backend.can_write(dn, attribute) for attribute in attributes
        )
    except errors.PublicError:
        raise
    except Exception as exc:
        raise EditorFailure(
            'operational',
            'Group Policy editor authorization could not be checked.',
        ) from exc
    if not authorized:
        raise errors.ACIError(
            info=_('Group Policy Object editor permission is required')
        )


def _trusted_gpo_root(domain, guid):
    policies_root = GPO_SYSVOL_ROOT / domain / 'Policies'
    candidate = policies_root / guid

    # Refuse symlinks at every deployment-controlled component.  resolve()
    # below provides a second containment check against races and aliases.
    for path in (
        GPO_SYSVOL_ROOT,
        GPO_SYSVOL_ROOT / domain,
        policies_root,
        candidate,
    ):
        if path.is_symlink():
            raise EditorFailure(
                'validation',
                'The Group Policy Object file location is unsafe.',
            )
    try:
        resolved_policies = policies_root.resolve(strict=True)
        resolved_candidate = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise EditorFailure(
            'operational',
            'The Group Policy Object payload is unavailable.',
        ) from exc
    if not resolved_candidate.is_dir():
        raise EditorFailure(
            'operational',
            'The Group Policy Object payload is unavailable.',
        )
    try:
        contained = os.path.commonpath((resolved_policies, resolved_candidate))
    except ValueError as exc:
        raise EditorFailure(
            'validation',
            'The Group Policy Object file location is unsafe.',
        ) from exc
    if Path(contained) != resolved_policies or resolved_candidate == resolved_policies:
        raise EditorFailure(
            'validation',
            'The Group Policy Object file location is unsafe.',
        )
    return resolved_candidate


def _snapshot_from_entry(entry, guid, file_sys_path):
    version_values = _entry_values(entry, 'versionnumber')
    machine_values = _entry_values(entry, 'gpcmachineextensionnames')
    user_values = _entry_values(entry, 'gpcuserextensionnames')
    try:
        version = int(version_values[0]) if version_values else 0
    except (TypeError, ValueError) as exc:
        raise EditorFailure(
            'operational',
            'The Group Policy Object version is invalid.',
        ) from exc
    if version < 0 or version > 0xffffffff:
        raise EditorFailure(
            'operational',
            'The Group Policy Object version is invalid.',
        )
    dn = getattr(entry, 'dn', None)
    if dn is None:
        dn = _entry_text(entry, 'distinguishedname')
    snapshot = {
        'identity': {
            'guid': guid,
            'distinguished_name': str(dn),
            'file_sys_path': file_sys_path,
        },
        'version_number': version,
        'machine_extension_names': (
            str(machine_values[0]) if machine_values else ''
        ),
        'user_extension_names': str(user_values[0]) if user_values else '',
    }
    presence = {
        'version_number': bool(version_values),
        'machine_extension_names': bool(machine_values),
        'user_extension_names': bool(user_values),
    }
    return snapshot, presence


def _resolve_editor_context(ldap_backend, api_instance, displayname, write=False):
    """Resolve, authorize, and validate a GPO before touching SYSVOL."""
    verify_gpo_schema(ldap_backend, api_instance)
    base_dn = DN(
        api_instance.env.container_grouppolicy,
        api_instance.env.basedn,
    )
    try:
        entry = ldap_backend.find_entry_by_attr(
            'displayName',
            displayname,
            'groupPolicyContainer',
            attrs_list=list(GPC_SNAPSHOT_ATTRIBUTES),
            base_dn=base_dn,
        )
    except errors.NotFound:
        raise errors.NotFound(
            reason=_('%(pkey)s: Group Policy Object not found')
            % {'pkey': displayname}
        )

    guid = _canonical_guid(_entry_text(entry, 'cn'))
    domain = str(api_instance.env.domain).lower()
    file_sys_path = _validate_unc(
        _entry_text(entry, 'gpcfilesyspath'), domain, guid
    )
    dn = getattr(entry, 'dn', None)
    if dn is None:
        dn = DN(('cn', guid), base_dn)

    # This must stay before every filesystem check or binding/catalog open.
    _authorize_editor(ldap_backend, dn, write=write)
    gpo_root = _trusted_gpo_root(domain, guid)
    snapshot, presence = _snapshot_from_entry(entry, guid, file_sys_path)
    return EditorContext(
        str(displayname), guid, dn, file_sys_path, gpo_root, snapshot, presence
    )


def _read_gpc_snapshot(ldap_backend, context):
    entry = ldap_backend.get_entry(
        context.dn, attrs_list=list(GPC_SNAPSHOT_ATTRIBUTES)
    )
    observed_guid = _canonical_guid(_entry_text(entry, 'cn'))
    if observed_guid != context.guid:
        raise EditorFailure(
            'publication_conflict',
            'The Group Policy Object identity changed during publication.',
            details={'conflict_fields': ['identity']},
        )
    observed_path = _validate_unc(
        _entry_text(entry, 'gpcfilesyspath'),
        context.file_sys_path.split('\\')[2].lower(),
        context.guid,
    )
    snapshot, presence = _snapshot_from_entry(entry, context.guid, observed_path)
    return snapshot, presence


def _sanitize_diagnostics(diagnostics):
    result = []
    for diagnostic in diagnostics or ():
        if isinstance(diagnostic, dict):
            message = str(diagnostic.get('message', 'Template diagnostic'))
        else:
            message = str(diagnostic)
        for internal in (
            str(GPO_TEMPLATE_ROOT),
            str(GPO_SYSVOL_ROOT),
            str(GPO_EDITOR_STATE_DIRECTORY),
        ):
            message = message.replace(internal, '<server-path>')
        message = re.sub(
            r'\\\\[^\s\\]+\\(?:[^\s\\]+\\)+[^\s]+',
            '<server-path>',
            message,
        )
        message = re.sub(
            r'\b(?:Machine|User)[/\\][^\s,;:]+',
            '<gpo-path>',
            message,
            flags=re.IGNORECASE,
        )
        message = re.sub(
            r'\b(?:GPT\.INI|Registry\.pol|comment\.cmt[xl])\b',
            '<gpo-path>',
            message,
            flags=re.IGNORECASE,
        )
        result.append({'message': message})
    return result


def _catalog_public_state(catalog, refresh_result=None):
    generation = dict(catalog.generation())
    result = {
        'generation': generation,
        'diagnostics': _sanitize_diagnostics(catalog.diagnostics()),
    }
    if refresh_result is not None:
        refresh = dict(refresh_result)
        refresh['diagnostics'] = _sanitize_diagnostics(
            refresh.get('diagnostics', [])
        )
        failure = refresh.get('failure')
        if failure:
            failure = dict(failure)
            failure['message'] = 'The latest template refresh was unusable.'
            failure['diagnostics'] = _sanitize_diagnostics(
                failure.get('diagnostics', [])
            )
            refresh['failure'] = failure
        result['refresh'] = refresh
    else:
        result['refresh'] = None
    return result


def _get_catalog(module=None, now=None):
    """Return the worker-local healthy catalog, refreshing it at most once per interval."""
    global _catalog, _catalog_last_refresh, _catalog_refresh_result
    module = module or _load_admix()
    _binding_info(module)
    now = time.monotonic() if now is None else now
    with _catalog_lock:
        if _catalog is None:
            try:
                _catalog = module.TemplateCatalog(
                    str(GPO_TEMPLATE_ROOT), all_locales=True
                )
            except Exception as exc:
                raise EditorFailure(
                    'operational',
                    'Administrative templates are unavailable.',
                ) from exc
            _catalog_last_refresh = now
            _catalog_refresh_result = None
        elif now - _catalog_last_refresh >= GPO_CATALOG_REFRESH_INTERVAL:
            try:
                _catalog_refresh_result = _catalog.refresh_if_changed()
            except Exception as exc:
                # Unexpected binding failures are operational.  A normal
                # failed refresh is returned as a result and retains the last
                # healthy generation inside TemplateCatalog.
                raise EditorFailure(
                    'operational',
                    'Administrative templates could not be refreshed.',
                ) from exc
            _catalog_last_refresh = now
        return _catalog, _catalog_public_state(
            _catalog, _catalog_refresh_result
        )


def _select_locales(requested, generation):
    loaded = list(generation.get('loaded_locales') or ())
    if isinstance(requested, str):
        requested = [requested]
    requested = list(requested or ())
    for locale in requested:
        if not isinstance(locale, str) or not _LOCALE_RE.fullmatch(locale):
            raise EditorFailure(
                'validation',
                'A requested locale is invalid.',
                field='locales',
            )

    by_casefold = {locale.casefold(): locale for locale in loaded}
    selected = []
    for requested_locale in requested:
        normalized = requested_locale.replace('_', '-').casefold()
        match = by_casefold.get(normalized)
        if match is None:
            language = normalized.split('-', 1)[0]
            match = next(
                (
                    candidate for candidate in loaded
                    if candidate.casefold().split('-', 1)[0] == language
                ),
                None,
            )
        if match is not None and match not in selected:
            selected.append(match)
    if not selected and loaded:
        selected.append(by_casefold.get('en-us', loaded[0]))
    return selected


def _comments_config(scope, locales):
    if scope not in ('computer', 'user'):
        raise EditorFailure(
            'validation',
            'Policy scope must be computer or user.',
            field='scope',
        )
    directory = 'Machine' if scope == 'computer' else 'User'
    return {
        'cmtx_path': '{}/comment.cmtx'.format(directory),
        'locale_paths': {
            locale: '{}/{}/comment.cmtl'.format(directory, locale)
            for locale in locales
        },
    }


def _open_workspace(
    context, requested_locales=(), load_preferences=False,
    comment_scope=None, with_catalog=True,
):
    module = _load_admix()
    binding = _binding_info(module)
    kwargs = {
        'load_preferences': bool(load_preferences),
        'state_directory': str(GPO_EDITOR_STATE_DIRECTORY),
        'state_key': context.guid,
    }
    catalog_state = None
    locales = []
    if with_catalog:
        catalog, catalog_state = _get_catalog(module)
        locales = _select_locales(
            requested_locales, catalog_state['generation']
        )
        kwargs['template_catalog'] = catalog
        kwargs['locales'] = locales
    if comment_scope is not None:
        kwargs['comments'] = _comments_config(comment_scope, locales)
    try:
        workspace = module.HighLevelApi(str(context.gpo_root), **kwargs)
    except Exception:
        raise
    return workspace, {
        'binding': binding,
        'catalog': catalog_state,
        'locales': locales,
    }


def _reset_editor_globals_for_tests():
    global _catalog, _catalog_last_refresh, _catalog_refresh_result
    global _admix_module
    with _catalog_lock:
        _catalog = None
        _catalog_last_refresh = 0.0
        _catalog_refresh_result = None
        _admix_module = None


def _validate_publication_plan(plan, expected_snapshot):
    required = {
        'identity', 'expected_version', 'target_version',
        'machine_extension_names', 'user_extension_names',
        'idempotency_token', 'affected_scopes',
    }
    if not isinstance(plan, dict) or not required.issubset(plan):
        raise EditorFailure(
            'operational',
            'The editor binding returned an invalid publication plan.',
        )
    if plan['identity'] != expected_snapshot['identity']:
        raise EditorFailure(
            'publication_conflict',
            'The publication plan identity does not match the GPO.',
            details={'conflict_fields': ['identity']},
        )
    try:
        expected_version = int(plan['expected_version'])
        target_version = int(plan['target_version'])
    except (TypeError, ValueError) as exc:
        raise EditorFailure(
            'operational',
            'The editor binding returned an invalid publication version.',
        ) from exc
    if expected_version != int(expected_snapshot['version_number']):
        raise EditorFailure(
            'publication_conflict',
            'The publication plan is based on a stale directory version.',
            details={'conflict_fields': ['version']},
        )
    if target_version < 0 or target_version > 0xffffffff:
        raise EditorFailure(
            'operational',
            'The editor binding returned an invalid target version.',
        )


def _ldap_value(ldap_backend, value):
    encoded = ldap_backend.encode(str(value))
    return [encoded]


def _compare_replace_modifications(
    ldap_backend, attribute, expected, target, present, absent_probe=None,
):
    """Build an atomic SINGLE-VALUE compare-and-replace sequence.

    RFC 4511 requires all changes in one Modify request to be applied in the
    listed order and atomically.  Deleting the exact observed value therefore
    acts as the comparison for a present attribute.  Adding to a SINGLE-VALUE
    attribute compares absence.  When both the expected and target states are
    absent, a schema-valid add/delete probe performs that comparison with no
    final value.
    """
    modifications = []
    if present:
        modifications.append((
            _ldap.MOD_DELETE,
            attribute,
            _ldap_value(ldap_backend, expected),
        ))
    elif target is None:
        if absent_probe is None:
            raise EditorFailure(
                'operational',
                'The directory publication precondition is invalid.',
            )
        probe = _ldap_value(ldap_backend, absent_probe)
        modifications.extend((
            (_ldap.MOD_ADD, attribute, probe),
            (_ldap.MOD_DELETE, attribute, probe),
        ))
        return modifications

    if target is not None:
        modifications.append((
            _ldap.MOD_ADD,
            attribute,
            _ldap_value(ldap_backend, target),
        ))
    return modifications


def _apply_publication_plan(
    ldap_backend, context, plan, expected_snapshot, expected_presence=None,
):
    """Apply one libadmix plan with an atomic ordered compare-and-modify."""
    _validate_publication_plan(plan, expected_snapshot)
    expected_presence = expected_presence or {}
    identity = expected_snapshot['identity']
    modifications = _compare_replace_modifications(
        ldap_backend,
        'gPCFileSysPath',
        identity['file_sys_path'],
        identity['file_sys_path'],
        True,
    )
    modifications.extend(_compare_replace_modifications(
        ldap_backend,
        'versionNumber',
        expected_snapshot['version_number'],
        int(plan['target_version']),
        expected_presence.get('version_number', True),
    ))
    for attribute, snapshot_key, plan_key in (
        (
            'gPCMachineExtensionNames',
            'machine_extension_names',
            'machine_extension_names',
        ),
        (
            'gPCUserExtensionNames',
            'user_extension_names',
            'user_extension_names',
        ),
    ):
        target = plan[plan_key] or None
        modifications.extend(_compare_replace_modifications(
            ldap_backend,
            attribute,
            expected_snapshot[snapshot_key],
            target,
            expected_presence.get(
                snapshot_key, expected_snapshot[snapshot_key] != ''
            ),
            absent_probe=GPC_ABSENT_EXTENSION_PROBE,
        ))

    cache_dropped = False
    try:
        ldap_backend.conn.modify_ext_s(str(context.dn), modifications)
    except (
        _ldap.NO_SUCH_ATTRIBUTE,
        _ldap.TYPE_OR_VALUE_EXISTS,
        _ldap.CONSTRAINT_VIOLATION,
        _ldap.NO_SUCH_OBJECT,
    ) as exc:
        remove_cache_entry = getattr(
            ldap_backend, 'remove_cache_entry', None
        )
        if remove_cache_entry is not None:
            remove_cache_entry(context.dn)
            cache_dropped = True
        try:
            observed, _ = _read_gpc_snapshot(ldap_backend, context)
        except Exception as read_exc:
            raise EditorFailure(
                'publication_conflict',
                'The Group Policy Object changed during directory publication.',
                details={
                    'conflict_fields': ['stale_read'],
                    'safe_next_actions': ['retry_read', 'reconcile'],
                },
            ) from read_exc
        raise EditorFailure(
            'publication_conflict',
            'The Group Policy Object changed during directory publication.',
            details={
                'conflict_fields': _snapshot_conflict_fields(
                    expected_snapshot, observed
                ),
                'observed': _public_snapshot(observed),
                'safe_next_actions': ['refresh', 'reconcile'],
            },
        ) from exc
    except _ldap.LDAPError:
        # Preserve FreeIPA's established LDAP error translation for every
        # failure except an atomic comparison mismatch, which is a domain
        # conflict handled above.
        with ldap_backend.error_handler():
            raise
    finally:
        # The direct controlled modify bypasses LDAPCache.update_entry().
        remove_cache_entry = getattr(ldap_backend, 'remove_cache_entry', None)
        if remove_cache_entry is not None and not cache_dropped:
            remove_cache_entry(context.dn)


def _snapshot_conflict_fields(expected, observed):
    fields = []
    if expected.get('identity') != observed.get('identity'):
        fields.append('identity')
    if expected.get('version_number') != observed.get('version_number'):
        fields.append('version')
    if (
        expected.get('machine_extension_names')
        != observed.get('machine_extension_names')
    ):
        fields.append('machine_extension_names')
    if (
        expected.get('user_extension_names')
        != observed.get('user_extension_names')
    ):
        fields.append('user_extension_names')
    return fields or ['stale_read']


def _public_snapshot(snapshot):
    identity = snapshot.get('identity') or {}
    return {
        'identity': {
            'guid': identity.get('guid'),
            'distinguished_name': identity.get('distinguished_name'),
        },
        'version_number': snapshot.get('version_number'),
        'machine_extension_names': snapshot.get(
            'machine_extension_names', ''
        ),
        'user_extension_names': snapshot.get('user_extension_names', ''),
    }


def _public_plan(plan):
    if not plan:
        return None
    return {
        'expected_version': plan.get('expected_version'),
        'target_version': plan.get('target_version'),
        'affected_scopes': dict(plan.get('affected_scopes') or {}),
        'machine_extension_names': plan.get('machine_extension_names', ''),
        'user_extension_names': plan.get('user_extension_names', ''),
    }


def _public_pending(pending):
    if not pending:
        return None
    return {
        'phase': pending.get('phase'),
        'plan': _public_plan(pending.get('plan')),
    }


def _public_recovery(action):
    if not action:
        return {'kind': 'clean'}
    result = {
        'kind': action.get('kind'),
        'plan': _public_plan(action.get('plan')),
        'conflict': None,
    }
    conflict = action.get('conflict')
    if conflict:
        result['conflict'] = {
            'code': conflict.get('code'),
            'phase': conflict.get('phase'),
            'conflict_fields': list(conflict.get('conflict_fields') or ()),
            'expected': _public_snapshot(conflict.get('expected') or {}),
            'observed': _public_snapshot(conflict.get('observed') or {}),
            'safe_next_actions': list(
                conflict.get('safe_next_actions') or ()
            ),
        }
    return result


def _public_documents(documents):
    result = []
    for document in documents or ():
        item = dict(document)
        item.pop('path', None)
        result.append(item)
    return result


def _editor_envelope(context, runtime, workspace=None):
    pending = None
    diagnostics = []
    if workspace is not None:
        pending = workspace.pending_external_publication()
        diagnostics = _sanitize_diagnostics(workspace.diagnostics())
    catalog = runtime.get('catalog')
    if catalog:
        diagnostics = catalog.get('diagnostics', []) + diagnostics
    return {
        'binding': runtime['binding'],
        'gpo': {
            'displayname': context.displayname,
            'guid': context.guid,
            'distinguished_name': str(context.dn),
        },
        'snapshot': _public_snapshot(context.snapshot),
        'template': catalog,
        'locales': list(runtime.get('locales') or ()),
        'diagnostics': diagnostics,
        'pending_publication': _public_pending(pending),
    }


def _acknowledge_publication(workspace, plan, resulting_snapshot):
    try:
        workspace.acknowledge_external(
            plan['idempotency_token'], resulting_snapshot
        )
    except Exception as exc:
        if getattr(exc, 'code', None) == 'conflict':
            raise EditorFailure(
                'publication_conflict',
                'The resulting directory state could not be acknowledged.',
                details={
                    'safe_next_actions': ['reconcile', 'operator_intervention']
                },
            ) from exc
        raise


def _commit_external_once(workspace, ldap_backend, context):
    """Finalize one in-memory mutation and coordinate one LDAP publication."""
    starting_snapshot, starting_presence = _read_gpc_snapshot(
        ldap_backend, context
    )
    result = workspace.commit_external(starting_snapshot)
    files = result.get('files') or {}
    paths = list(files.get('paths') or ())
    affected = dict(files.get('affected_scopes') or {})
    plan = result.get('publication_plan')
    directory = result.get('directory')
    pending = workspace.pending_external_publication()

    if directory == 'no_publication_required':
        if paths or any(affected.values()) or plan is not None or pending is not None:
            raise EditorFailure(
                'operational',
                'The editor binding returned an inconsistent no-op result.',
            )
        context.snapshot = starting_snapshot
        return {
            'changed': False,
            'snapshot': _public_snapshot(starting_snapshot),
            'affected_scopes': affected,
            'pending_publication': None,
        }
    if directory != 'external_handoff':
        raise EditorFailure(
            'operational',
            'The editor binding returned an unknown directory outcome.',
        )
    if not paths or not any(affected.values()) or plan is None:
        raise EditorFailure(
            'operational',
            'The editor binding returned an inconsistent external handoff.',
        )

    _apply_publication_plan(
        ldap_backend,
        context,
        plan,
        starting_snapshot,
        starting_presence,
    )
    resulting_snapshot, _ = _read_gpc_snapshot(ldap_backend, context)
    _acknowledge_publication(workspace, plan, resulting_snapshot)
    context.snapshot = resulting_snapshot
    return {
        'changed': True,
        'snapshot': _public_snapshot(resulting_snapshot),
        'affected_scopes': dict(plan.get('affected_scopes') or {}),
        'pending_publication': None,
    }


def _reconcile_workspace(workspace, ldap_backend, context, reject_conflict=False):
    pending = workspace.pending_external_publication()
    if pending is None:
        snapshot, _ = _read_gpc_snapshot(ldap_backend, context)
        context.snapshot = snapshot
        return {'kind': 'clean'}, snapshot

    if pending.get('phase') != 'awaiting_directory_publication':
        original_plan = pending.get('plan')
        if not isinstance(original_plan, dict):
            raise EditorFailure(
                'recovery_operator_action',
                'Publication recovery has no complete original plan.',
            )
        resumed = workspace.resume_external_file_publication()
        pending = workspace.pending_external_publication()
        if (
            not isinstance(resumed, dict)
            or resumed.get('publication_plan') != original_plan
            or not isinstance(pending, dict)
            or pending.get('phase') != 'awaiting_directory_publication'
            or pending.get('plan') != original_plan
        ):
            raise EditorFailure(
                'recovery_operator_action',
                'Publication file recovery did not restore the original attempt.',
            )

    observed, observed_presence = _read_gpc_snapshot(ldap_backend, context)
    action = workspace.reconcile_external(observed)
    kind = action.get('kind')
    if kind == 'apply':
        plan = action.get('plan')
        precondition = pending.get('precondition')
        if not precondition:
            raise EditorFailure(
                'recovery_operator_action',
                'Publication recovery has no verified precondition.',
            )
        _apply_publication_plan(
            ldap_backend, context, plan, precondition, observed_presence
        )
        resulting, _ = _read_gpc_snapshot(ldap_backend, context)
        _acknowledge_publication(workspace, plan, resulting)
        context.snapshot = resulting
        return action, resulting
    if kind == 'acknowledge':
        plan = action.get('plan')
        _acknowledge_publication(workspace, plan, observed)
        context.snapshot = observed
        return action, observed
    if kind == 'conflict':
        if reject_conflict:
            conflict = _public_recovery(action).get('conflict')
            raise EditorFailure(
                'publication_conflict',
                'Pending Group Policy publication conflicts with LDAP.',
                details=conflict,
            )
        return action, observed
    raise EditorFailure(
        'operational',
        'The editor binding returned an unknown recovery action.',
    )


def _recover_before_mutation(workspace, ldap_backend, context):
    return _reconcile_workspace(
        workspace, ldap_backend, context, reject_conflict=True
    )


def _identity(request):
    if not isinstance(request, dict):
        raise EditorFailure(
            'validation', 'A structured request is required.', field='request'
        )
    identity = request.get('identity')
    if not isinstance(identity, (list, tuple)) or not identity or not all(
        isinstance(part, str) and part for part in identity
    ):
        raise EditorFailure(
            'validation',
            'A preference item identity is required.',
            field='identity',
        )
    return list(identity)


def _find_preference_item(workspace, scope, kind, identity):
    for item in workspace.list_preference_items(scope, kind):
        if list(item.get('identity') or ()) == list(identity):
            return item
    raise EditorFailure(
        'not_found',
        'The requested preference item was not found.',
        field='identity',
    )


def _preference_filter_descriptors(workspace):
    result = []
    for descriptor in workspace.preference_filter_kinds():
        item = dict(descriptor)
        item['fields'] = workspace.get_new_preference_filter_fields(
            item['kind']
        )
        result.append(item)
    return result


def _preference_parent_candidates(workspace, scope, kind):
    result = []
    for candidate in workspace.list_preference_parent_candidates(scope, kind):
        identity = candidate.get('identity')
        parent_identity = candidate.get('parent_identity')
        result.append({
            'identity': None if identity is None else list(identity),
            'label': str(candidate.get('label') or ''),
            'parent_identity': (
                None if parent_identity is None else list(parent_identity)
            ),
            'depth': int(candidate.get('depth') or 0),
        })
    return result


def _preference_detail(workspace, scope, kind, identity):
    item = _find_preference_item(workspace, scope, kind, identity)
    filters = workspace.list_preference_filters(scope, kind, identity)
    filter_fields = []
    for preference_filter in filters:
        path = list(preference_filter.get('path') or ())
        try:
            fields = workspace.get_preference_filter_fields(
                scope, kind, identity, path
            )
        except Exception as exc:
            if getattr(exc, 'code', None) != 'not_loaded':
                raise
            filter_fields.append({
                'path': path,
                'fields': [],
                'available': False,
                'error_category': 'unsupported',
            })
        else:
            filter_fields.append({
                'path': path,
                'fields': fields,
                'available': True,
            })
    return {
        'item': item,
        'fields': workspace.get_preference_fields(
            scope, kind, identity
        ),
        'filters': filters,
        'filter_fields': filter_fields,
        'filter_kinds': _preference_filter_descriptors(workspace),
        'new_item_fields': workspace.get_new_preference_item_fields(
            scope, kind
        ),
        'parent_candidates': _preference_parent_candidates(
            workspace, scope, kind
        ),
    }


def _new_preference_detail(workspace, scope, kind):
    fields = workspace.get_new_preference_item_fields(scope, kind)
    return {
        'item': None,
        'fields': fields,
        'filters': [],
        'filter_fields': [],
        'filter_kinds': _preference_filter_descriptors(workspace),
        'new_item_fields': fields,
        'parent_candidates': _preference_parent_candidates(
            workspace, scope, kind
        ),
    }


def _apply_filter_operations(workspace, scope, kind, identity, operations):
    if operations is None:
        return
    if not isinstance(operations, (list, tuple)):
        raise EditorFailure(
            'validation',
            'Preference filter operations must be an ordered list.',
            field='filters',
        )
    for operation in operations:
        if not isinstance(operation, dict):
            raise EditorFailure(
                'validation',
                'A preference filter operation is invalid.',
                field='filters',
            )
        action = operation.get('op')
        if action == 'insert':
            workspace.insert_preference_filter(
                scope,
                kind,
                identity,
                list(operation.get('collection_path') or ()),
                int(operation.get('index', 0)),
                operation.get('filter_kind'),
                list(operation.get('fields') or ()),
            )
        elif action == 'replace':
            workspace.replace_preference_filter(
                scope,
                kind,
                identity,
                list(operation.get('path') or ()),
                operation.get('filter_kind'),
                list(operation.get('fields') or ()),
            )
        elif action == 'remove':
            workspace.remove_preference_filter(
                scope,
                kind,
                identity,
                list(operation.get('path') or ()),
            )
        elif action == 'edit':
            workspace.edit_preference_filter_fields(
                scope,
                kind,
                identity,
                list(operation.get('path') or ()),
                list(operation.get('fields') or ()),
            )
        else:
            raise EditorFailure(
                'validation',
                'A preference filter operation is invalid.',
                field='filters',
            )


def _translate_editor_exception(exc):
    if isinstance(exc, errors.PublicError):
        raise exc
    if isinstance(exc, EditorFailure):
        failure = exc
    elif isinstance(exc, (TypeError, ValueError)):
        failure = EditorFailure(
            'validation', 'The editor request is invalid.'
        )
    else:
        code = getattr(exc, 'code', None)
        mapping = {
            'invalid_argument': ('validation', 'The editor request is invalid.'),
            'validation': ('validation', 'The editor request is invalid.'),
            'not_found': ('not_found', 'The requested editor object was not found.'),
            'not_loaded': ('unsupported', 'The requested editor feature is unavailable.'),
            'conflict': ('storage_conflict', 'The GPO changed while it was being edited.'),
            'recoverable': ('publication_pending', 'The GPO has recoverable pending state.'),
            'publication_pending': ('publication_pending', 'The GPO has a pending publication.'),
            'durable_state_required': ('operational', 'The editor state directory is unavailable.'),
            'recovery_operator_action': ('recovery_operator_action', 'The GPO requires operator recovery.'),
            'io': ('operational', 'The GPO payload could not be accessed.'),
            'internal': ('operational', 'The GPO editor failed internally.'),
        }
        if code in mapping:
            category, message = mapping[code]
            failure = EditorFailure(
                category,
                message,
                field=getattr(exc, 'field', None),
                path=getattr(exc, 'path', None),
            )
        else:
            logger.exception('Unexpected GPO editor failure')
            failure = EditorFailure(
                'operational', 'The Group Policy editor operation failed.'
            )

    data = {'error_category': failure.category}
    if failure.field and '/' not in str(failure.field):
        data['field'] = failure.field
    # AdmixError.path is a GPO storage path, not a logical browser field path.
    # Never forward it; `field` is the only safe field-level association.
    if failure.details is not None:
        data['details'] = json.dumps(
            failure.details, ensure_ascii=False, sort_keys=True
        )
    raise errors.ExecutionError(message=_(failure.message), **data)

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
        'versionNumber', 'gPCMachineExtensionNames', 'gPCUserExtensionNames',
    ]
    search_display_attributes = [
        'cn', 'displayName', 'flags', 'versionNumber',
        'gPCMachineExtensionNames', 'gPCUserExtensionNames',
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
                'gPCMachineExtensionNames', 'gPCUserExtensionNames',
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
                'gPCMachineExtensionNames', 'gPCUserExtensionNames',
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
        Str('gpcmachineextensionnames?',
            label=_('Machine extension names'),
            doc=_('Canonical machine-side Group Policy extension pairs'),
        ),
        Str('gpcuserextensionnames?',
            label=_('User extension names'),
            doc=_('Canonical user-side Group Policy extension pairs'),
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

    def _call_dbus_method(self, method_name, *params, fail_on_error=True, return_stdout=False):
        """Universal D-Bus method caller for GPO operations.

        Args:
            method_name: D-Bus method name on org.freeipa.server interface
            *params: Arguments passed to the D-Bus method
            fail_on_error: Raise ExecutionError on failure (default True)
            return_stdout: If True, return stdout on success instead of None
        """
        try:
            bus = _get_bus()
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
                    return stdout if return_stdout else None

            return stdout if return_stdout else None

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

@register()
class gpo_add(LDAPCreate):
    __doc__ = _('Create a new Group Policy Object.')
    msg_summary = _('Added Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        verify_gpo_schema(ldap, self.api)
        displayname = keys[-1]
        if not re.match(constants.PATTERN_GROUPUSER_NAME, displayname):
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
        displayname = keys[-1] if keys else 'New Group Policy Object'
        self.obj._call_dbus_method('create_gpo_structure', guid, domain, displayname, fail_on_error=True)

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
        # Oddjob removes only the replicated SYSVOL tree.  The private editor
        # state is deliberately preserved: the binding has no safe
        # pending-inspection/cleanup API that is independent of the payload,
        # and ordinary GPO CRUD must remain usable without a compatible
        # editor binding.
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
            if not re.match(constants.PATTERN_GROUPUSER_NAME, new_name):
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


def _validated_scope(scope):
    normalized = str(scope or '').lower()
    if normalized == 'machine':
        normalized = 'computer'
    if normalized not in ('computer', 'user'):
        raise EditorFailure(
            'validation',
            'Policy scope must be computer or user.',
            field='scope',
        )
    return normalized


class _GpoEditorCommand(Command):
    has_output = (
        output.summary,
        output.Output('result', type=dict, doc=_('GPO editor result')),
    )

    def _run(self, callback):
        try:
            result = callback()
            return {
                'summary': str(
                    _('Group Policy editor operation completed')
                ),
                'result': result,
            }
        except Exception as exc:
            _translate_editor_exception(exc)

    def _context(self, displayname, write=False):
        return _resolve_editor_context(
            self.api.Backend.ldap2, self.api, displayname, write=write
        )


@register()
class gpo_editor_open(_GpoEditorCommand):
    __doc__ = _('Open a high-level Group Policy editor context.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
    )
    takes_options = (
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(self, displayname, locales=None, **options):
        def operation():
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, locales or (), load_preferences=True
            )
            result = _editor_envelope(context, runtime, workspace)
            result['preference_documents'] = _public_documents(
                workspace.list_preference_documents()
            )
            return result
        return self._run(operation)


@register()
class gpo_editor_children(_GpoEditorCommand):
    __doc__ = _('List high-level policy/category children.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Policy scope')),
    )
    takes_options = (
        Str('category_id?', label=_('Opaque category ID')),
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(
        self, displayname, scope, category_id=None, locales=None, **options
    ):
        def operation():
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, locales or (), load_preferences=False
            )
            result = _editor_envelope(context, runtime, workspace)
            result['children'] = workspace.list_policies(
                normalized_scope,
                category_id,
                runtime['locales'],
            )
            return result
        return self._run(operation)


@register()
class gpo_editor_policy_show(_GpoEditorCommand):
    __doc__ = _('Display a high-level Administrative Template policy.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Policy scope')),
        Str('policy_id', label=_('Opaque policy ID')),
    )
    takes_options = (
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(
        self, displayname, scope, policy_id, locales=None, **options
    ):
        def operation():
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context,
                locales or (),
                load_preferences=False,
                comment_scope=normalized_scope,
            )
            result = _editor_envelope(context, runtime, workspace)
            result['policy'] = workspace.get_policy(
                normalized_scope, policy_id, runtime['locales']
            )
            return result
        return self._run(operation)


@register()
class gpo_editor_policy_update(_GpoEditorCommand):
    __doc__ = _('Atomically update a high-level policy form.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Policy scope')),
        Str('policy_id', label=_('Opaque policy ID')),
    )
    takes_options = (
        Dict('request', label=_('Structured policy update')),
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(
        self, displayname, scope, policy_id, request,
        locales=None, **options
    ):
        def operation():
            if not isinstance(request, dict):
                raise EditorFailure(
                    'validation',
                    'A structured policy update is required.',
                    field='request',
                )
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context,
                locales or (),
                load_preferences=False,
                comment_scope=normalized_scope,
            )
            _recover_before_mutation(workspace, ldap_backend, context)

            update_kwargs = {'locales': runtime['locales']}
            has_policy_update = False
            for request_key, binding_key in (
                ('state', 'state'),
                ('set_parameters', 'set_parameters'),
                ('clear_parameters', 'clear_parameters'),
            ):
                if request_key in request:
                    update_kwargs[binding_key] = request[request_key]
                    has_policy_update = True
            if has_policy_update:
                policy = workspace.update_policy(
                    normalized_scope, policy_id, **update_kwargs
                )
            else:
                policy = workspace.get_policy(
                    normalized_scope, policy_id, runtime['locales']
                )

            comment = request.get('comment')
            if comment is not None:
                if not isinstance(comment, dict):
                    raise EditorFailure(
                        'validation',
                        'The policy comment operation is invalid.',
                        field='comment',
                    )
                action = comment.get('action')
                target = comment.get('target', 'embedded')
                if action == 'set':
                    text = comment.get('text')
                    if not isinstance(text, str):
                        raise EditorFailure(
                            'validation',
                            'Policy comment text is required.',
                            field='comment.text',
                        )
                    policy = workspace.set_policy_comment(
                        normalized_scope,
                        policy_id,
                        target,
                        text,
                        runtime['locales'],
                    )
                elif action == 'clear':
                    policy = workspace.clear_policy_comment(
                        normalized_scope,
                        policy_id,
                        target,
                        runtime['locales'],
                    )
                else:
                    raise EditorFailure(
                        'validation',
                        'The policy comment operation is invalid.',
                        field='comment.action',
                    )

            publication = _commit_external_once(
                workspace, ldap_backend, context
            )
            # Ask the same request-scoped workspace for the canonical DTO after
            # commit; no workspace is retained for the next RPC.
            policy = workspace.get_policy(
                normalized_scope, policy_id, runtime['locales']
            )
            result = _editor_envelope(context, runtime, workspace)
            result['policy'] = policy
            result['publication'] = publication
            return result
        return self._run(operation)


@register()
class gpo_editor_reconcile(_GpoEditorCommand):
    __doc__ = _('Explicitly reconcile pending external GPO publication.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
    )

    def execute(self, displayname, **options):
        def operation():
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=False, with_catalog=False
            )
            action, snapshot = _reconcile_workspace(
                workspace, ldap_backend, context, reject_conflict=False
            )
            result = _editor_envelope(context, runtime, workspace)
            result['recovery'] = _public_recovery(action)
            result['snapshot'] = _public_snapshot(snapshot)
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_documents(_GpoEditorCommand):
    __doc__ = _('List high-level Group Policy Preference documents.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
    )

    def execute(self, displayname, **options):
        def operation():
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            result = _editor_envelope(context, runtime, workspace)
            result['documents'] = _public_documents(
                workspace.list_preference_documents()
            )
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_items(_GpoEditorCommand):
    __doc__ = _('List opaque Group Policy Preference item identities.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Preference scope')),
        Str('kind', label=_('Preference document kind')),
    )

    def execute(self, displayname, scope, kind, **options):
        def operation():
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            result = _editor_envelope(context, runtime, workspace)
            result['items'] = workspace.list_preference_items(
                normalized_scope, kind
            )
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_show(_GpoEditorCommand):
    __doc__ = _('Display a descriptor-driven Preference item form.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Preference scope')),
        Str('kind', label=_('Preference document kind')),
    )
    takes_options = (
        Dict('request', label=_('Preference item identity request')),
    )

    def execute(self, displayname, scope, kind, request, **options):
        def operation():
            normalized_scope = _validated_scope(scope)
            if not isinstance(request, dict):
                raise EditorFailure(
                    'validation', 'A structured request is required.',
                    field='request'
                )
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            result = _editor_envelope(context, runtime, workspace)
            if request.get('identity') is None:
                result.update(_new_preference_detail(
                    workspace, normalized_scope, kind
                ))
            else:
                result.update(_preference_detail(
                    workspace,
                    normalized_scope,
                    kind,
                    _identity(request),
                ))
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_create(_GpoEditorCommand):
    __doc__ = _('Atomically create a Group Policy Preference item.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Preference scope')),
        Str('kind', label=_('Preference document kind')),
    )
    takes_options = (
        Dict('request', label=_('Structured Preference create request')),
    )

    def execute(self, displayname, scope, kind, request, **options):
        def operation():
            if not isinstance(request, dict):
                raise EditorFailure(
                    'validation', 'A structured request is required.',
                    field='request'
                )
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            _recover_before_mutation(workspace, ldap_backend, context)
            item = workspace.create_preference_item(
                normalized_scope,
                kind,
                list(request.get('fields') or ()),
                request.get('parent'),
            )
            identity = list(item['identity'])
            _apply_filter_operations(
                workspace,
                normalized_scope,
                kind,
                identity,
                request.get('filters'),
            )
            publication = _commit_external_once(
                workspace, ldap_backend, context
            )
            result = _editor_envelope(context, runtime, workspace)
            result.update(_preference_detail(
                workspace, normalized_scope, kind, identity
            ))
            result['publication'] = publication
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_update(_GpoEditorCommand):
    __doc__ = _('Atomically update a Group Policy Preference item.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Preference scope')),
        Str('kind', label=_('Preference document kind')),
    )
    takes_options = (
        Dict('request', label=_('Structured Preference update request')),
    )

    def execute(self, displayname, scope, kind, request, **options):
        def operation():
            normalized_scope = _validated_scope(scope)
            identity = _identity(request)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            _recover_before_mutation(workspace, ldap_backend, context)
            _find_preference_item(
                workspace, normalized_scope, kind, identity
            )
            if 'fields' in request:
                workspace.edit_preference_fields(
                    normalized_scope,
                    kind,
                    identity,
                    list(request.get('fields') or ()),
                )
            if request.get('name') is not None:
                workspace.rename_preference_item(
                    normalized_scope, kind, identity, request['name']
                )
            _apply_filter_operations(
                workspace,
                normalized_scope,
                kind,
                identity,
                request.get('filters'),
            )
            publication = _commit_external_once(
                workspace, ldap_backend, context
            )
            result = _editor_envelope(context, runtime, workspace)
            result.update(_preference_detail(
                workspace, normalized_scope, kind, identity
            ))
            result['publication'] = publication
            return result
        return self._run(operation)


@register()
class gpo_editor_preference_delete(_GpoEditorCommand):
    __doc__ = _('Atomically delete a Group Policy Preference item.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Preference scope')),
        Str('kind', label=_('Preference document kind')),
    )
    takes_options = (
        Dict('request', label=_('Preference item identity request')),
    )

    def execute(self, displayname, scope, kind, request, **options):
        def operation():
            normalized_scope = _validated_scope(scope)
            identity = _identity(request)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True
            )
            _recover_before_mutation(workspace, ldap_backend, context)
            _find_preference_item(
                workspace, normalized_scope, kind, identity
            )
            workspace.remove_preference_item(
                normalized_scope, kind, identity
            )
            publication = _commit_external_once(
                workspace, ldap_backend, context
            )
            result = _editor_envelope(context, runtime, workspace)
            result['deleted_identity'] = identity
            result['publication'] = publication
            return result
        return self._run(operation)
