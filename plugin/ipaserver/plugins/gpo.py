import base64
import binascii
import copy
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
ODDJOB_DBUS_TIMEOUT_SECONDS = 120


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
                        'The required LDAP object class "ipaGpoContainer" is missing.'
                        'Please run the ipa-gpo-install command to extend the schema.'
                    )
                )
        raise
    except Exception as e:
        logger.debug("GPO schema check error: %s", str(e))
        raise


GPO_TEMPLATE_ROOT = Path('/usr/share/PolicyDefinitions')
GPO_SECURITY_DEFINITION_ROOT = GPO_TEMPLATE_ROOT
GPO_SDMX_SCHEMA_ROOT = Path('/usr/share/xml/sdmx/1.0')
GPO_SDMX_SCHEMA = GPO_SDMX_SCHEMA_ROOT / 'sdmx-1.0.xsd'
GPO_SDML_SCHEMA = GPO_SDMX_SCHEMA_ROOT / 'sdml-1.0.xsd'
GPO_SYSVOL_ROOT = Path('/var/lib/freeipa/sysvol')
GPO_EDITOR_STATE_DIRECTORY = Path('/var/lib/freeipa/gpo-editor-state')
GPO_CATALOG_REFRESH_INTERVAL = 5.0
# Fail explicitly rather than returning a partial index if a broken catalog
# produces an unbounded inventory. Ordinary system catalogs fit well below it.
GPO_POLICY_INDEX_MAX_NODES = 100000
GPO_SCRIPT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
GPO_SCRIPT_UPLOAD_MAX_ENCODED_BYTES = (
    4 * ((GPO_SCRIPT_UPLOAD_MAX_BYTES + 2) // 3)
)

_SCRIPT_EVENTS = {
    'computer': frozenset(('startup', 'shutdown')),
    'user': frozenset(('logon', 'logoff')),
}
_SCRIPT_EXECUTABLE_GROUPS = frozenset(('classic', 'powershell'))
_SCRIPT_EXECUTION_ORDERS = frozenset((
    'unspecified', 'classic_first', 'powershell_first',
))

GPC_SNAPSHOT_ATTRIBUTES = (
    'cn',
    'displayname',
    'distinguishedname',
    'ipagpofilesyspath',
    'ipagpoversionnumber',
    'ipagpomachineextensionnames',
    'ipagpouserextensionnames',
)
GPC_PUBLICATION_ATTRIBUTES = (
    'ipagpofilesyspath',
    'ipagpoversionnumber',
    'ipagpomachineextensionnames',
    'ipagpouserextensionnames',
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
_catalog_update_lock = threading.Lock()
_catalog_lifecycle_lock = threading.Lock()
_catalog = None
_catalog_state = None
_catalog_last_refresh = 0.0
_catalog_refresh_result = None
_catalog_monitor_thread = None
_catalog_monitor_stop = None
_security_catalog_lock = threading.RLock()
_security_catalogs = {}
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
            field='ipagpofilesyspath',
        )
    server, share_domain, unc_guid = match.groups()
    try:
        unc_guid = _canonical_guid(unc_guid)
    except EditorFailure as exc:
        raise EditorFailure(
            'validation',
            'The Group Policy Object has an invalid file location.',
            field='ipagpofilesyspath',
        ) from exc
    if (
        server.casefold() != domain.casefold()
        or share_domain.casefold() != domain.casefold()
        or unc_guid != guid
    ):
        raise EditorFailure(
            'validation',
            'The Group Policy Object file location does not match its identity.',
            field='ipagpofilesyspath',
        )
    return _canonical_unc(domain, guid)


def _authorize_editor(ldap_backend, dn, write=False):
    attributes = GPC_PUBLICATION_ATTRIBUTES if write else ('ipagpoversionnumber',)
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
    version_values = _entry_values(entry, 'ipagpoversionnumber')
    machine_values = _entry_values(entry, 'ipagpomachineextensionnames')
    user_values = _entry_values(entry, 'ipagpouserextensionnames')
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
            'ipaGpoContainer',
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
        _entry_text(entry, 'ipagpofilesyspath'), domain, guid
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
        _entry_text(entry, 'ipagpofilesyspath'),
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
            str(GPO_SECURITY_DEFINITION_ROOT),
            str(GPO_SDMX_SCHEMA_ROOT),
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
        public = {'message': message}
        if isinstance(diagnostic, dict):
            for field in ('severity', 'stage', 'code', 'policy_id', 'element_id'):
                value = diagnostic.get(field)
                if isinstance(value, str) and value:
                    public[field] = value
            source = diagnostic.get('file')
            if isinstance(source, str) and source:
                public['file'] = Path(source).name
        result.append(public)
    return result


def _exception_diagnostics(exc):
    diagnostics = getattr(exc, 'diagnostics', None)
    if diagnostics is None:
        diagnostics = [{'message': str(exc)}]
    return _sanitize_diagnostics(diagnostics)


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


def _refresh_catalog(module=None, now=None, stop_event=None):
    """Prepare/publish catalog state outside the short request-facing lock.

    The native catalog serializes acquisition and atomically publishes immutable
    generations. Its Python binding releases the GIL during that work. Never
    hold _catalog_lock across native parsing, source checks or index preparation.
    """
    global _catalog, _catalog_state
    global _catalog_last_refresh, _catalog_refresh_result
    with _catalog_update_lock:
        if stop_event is not None and stop_event.is_set():
            return
        checked_at = time.monotonic() if now is None else now
        with _catalog_lock:
            catalog = _catalog
            state = _catalog_state
            last_refresh = _catalog_last_refresh
        if (catalog is not None
                and checked_at - last_refresh < GPO_CATALOG_REFRESH_INTERVAL):
            return catalog, copy.deepcopy(state)
        module = module or _load_admix()
        refresh = None
        if catalog is None:
            try:
                catalog = module.TemplateCatalog(
                    str(GPO_TEMPLATE_ROOT), all_locales=True
                )
            except Exception as exc:
                raise EditorFailure(
                    'operational', 'Administrative templates are unavailable.',
                ) from exc
        else:
            try:
                refresh = catalog.refresh_if_changed()
            except Exception:
                # Keep serving the last-good generation even if the binding
                # raises unexpectedly instead of returning a failed result.
                logger.exception('Administrative template background refresh failed')
                generation = state['generation']
                refresh = {
                    'status': 'failed',
                    'previous_generation': generation['number'],
                    'current_generation': generation['number'],
                    'parse_performed': False,
                    'content_fingerprint': generation['content_fingerprint'],
                    'inventory_fingerprint': generation['inventory_fingerprint'],
                    'diagnostics': [],
                    'failure': {
                        'code': 'internal',
                        'message': 'The latest template refresh was unusable.',
                        'diagnostics': [],
                    },
                }
        public_state = _catalog_public_state(catalog, refresh)
        completed_at = time.monotonic() if now is None else now
        with _catalog_lock:
            if stop_event is not None and stop_event.is_set():
                return
            was_empty = _catalog is None
            _catalog = catalog
            _catalog_state = public_state
            _catalog_refresh_result = refresh
            _catalog_last_refresh = completed_at
        if was_empty or (refresh and refresh.get('status') == 'changed'):
            logger.info(
                'Administrative template catalog ready: generation=%s, locales=%s',
                public_state['generation']['number'],
                len(public_state['generation']['loaded_locales']),
            )
        return catalog, copy.deepcopy(public_state)


def _catalog_monitor_loop(stop_event, module=None):
    while not stop_event.wait(GPO_CATALOG_REFRESH_INTERVAL):
        try:
            _refresh_catalog(module, stop_event=stop_event)
        except Exception:
            # A failed initial load must not prevent FreeIPA/LDAP CRUD startup.
            # Retry independently of editor traffic, including after package
            # installation makes a previously missing source/binding usable.
            logger.exception('Administrative template catalog maintenance failed')


def _start_catalog_monitor(module=None):
    """Called during server API finalization, before WSGI accepts traffic."""
    global _catalog_monitor_thread, _catalog_monitor_stop
    with _catalog_lifecycle_lock:
        with _catalog_lock:
            if (_catalog_monitor_thread is not None
                    and _catalog_monitor_thread.is_alive()):
                return _catalog_monitor_thread
        try:
            _refresh_catalog(module)
        except Exception:
            logger.exception('Administrative template catalog preloading failed')
        stop_event = threading.Event()
        thread = threading.Thread(
            target=_catalog_monitor_loop, args=(stop_event, module),
            name='gpo-template-catalog', daemon=True,
        )
        with _catalog_lock:
            _catalog_monitor_stop = stop_event
            _catalog_monitor_thread = thread
        try:
            thread.start()
        except Exception:
            stop_event.set()
            logger.exception('Administrative template catalog monitor could not start')
        return thread


def _stop_catalog_monitor():
    """Stop maintenance for deterministic tests; never join under a state lock."""
    global _catalog_monitor_thread, _catalog_monitor_stop
    with _catalog_lifecycle_lock:
        with _catalog_lock:
            thread = _catalog_monitor_thread
            stop_event = _catalog_monitor_stop
            _catalog_monitor_thread = None
            _catalog_monitor_stop = None
        if stop_event is not None:
            stop_event.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)


def _get_catalog(module=None, now=None):
    """Read prepared state only; a running WSGI worker never refreshes on RPC."""
    with _catalog_lock:
        catalog = _catalog
        state = _catalog_state
        monitored = _catalog_monitor_thread is not None
    if catalog is not None:
        return catalog, copy.deepcopy(state)
    if monitored:
        raise EditorFailure(
            'operational', 'Administrative templates are unavailable.',
        )
    # Non-WSGI consumers and unit tests keep the existing lazy public behavior.
    # Server finalization always starts maintenance, including on preload failure.
    return _refresh_catalog(module, now)


def _security_definition_locales(root=None):
    """Discover only direct SDML locale directories under the trusted root."""
    root = Path(root or GPO_SECURITY_DEFINITION_ROOT)
    try:
        children = tuple(root.iterdir())
    except OSError:
        return []
    return sorted(
        child.name for child in children
        if child.is_dir() and not child.is_symlink()
        and _LOCALE_RE.fullmatch(child.name)
        and any(child.glob('*.sdml'))
    )


def _select_security_locale(requested, available=None):
    available = list(
        _security_definition_locales() if available is None else available
    )
    if isinstance(requested, str):
        requested = [requested]
    requested = list(requested or ())
    for locale in requested:
        if not isinstance(locale, str) or not _LOCALE_RE.fullmatch(locale):
            raise EditorFailure(
                'validation', 'A requested locale is invalid.', field='locales'
            )
    by_casefold = {
        locale.replace('_', '-').casefold(): locale for locale in available
    }
    for locale in requested:
        normalized = locale.replace('_', '-').casefold()
        if normalized in by_casefold:
            return by_casefold[normalized]
        language = normalized.split('-', 1)[0]
        match = next((
            value for value in available
            if value.replace('_', '-').casefold().split('-', 1)[0] == language
        ), None)
        if match is not None:
            return match
    return by_casefold.get('en-us') or (available[0] if available else 'en-US')


def _security_catalog_public_state(catalog, refresh_result=None):
    return {
        'generation': dict(catalog.generation()),
        'diagnostics': _sanitize_diagnostics(catalog.diagnostics()),
        'refresh': refresh_result,
    }


def _get_security_catalog(requested=(), module=None, now=None):
    """Cache one healthy SDMX catalog per locale and retain it on refresh errors."""
    module = module or _load_admix()
    now = time.monotonic() if now is None else now
    locale = _select_security_locale(requested)
    with _security_catalog_lock:
        cached = _security_catalogs.get(locale)
        if cached is None:
            try:
                catalog = module.SecurityDefinitionCatalog(
                    str(GPO_SECURITY_DEFINITION_ROOT),
                    locale=locale,
                    sdmx_schema=str(GPO_SDMX_SCHEMA),
                    sdml_schema=str(GPO_SDML_SCHEMA),
                )
            except Exception as exc:
                raise EditorFailure(
                    'operational',
                    'Security policy definitions are unavailable.',
                    field='security_catalog',
                    details={'diagnostics': _exception_diagnostics(exc)},
                ) from exc
            cached = {
                'catalog': catalog,
                'last_refresh': now,
                'refresh': None,
            }
            _security_catalogs[locale] = cached
        elif now - cached['last_refresh'] >= GPO_CATALOG_REFRESH_INTERVAL:
            catalog = cached['catalog']
            try:
                refresh = dict(catalog.refresh_if_changed())
                refresh['diagnostics'] = _sanitize_diagnostics(
                    refresh.get('diagnostics', ())
                )
                if refresh.get('failure'):
                    failure = dict(refresh['failure'])
                    failure['message'] = (
                        'The latest security definition refresh was unusable.'
                    )
                    failure['diagnostics'] = _sanitize_diagnostics(
                        failure.get('diagnostics', ())
                    )
                    refresh['failure'] = failure
            except Exception as exc:
                refresh = {
                    'status': 'retained',
                    'generation': dict(catalog.generation()),
                    'failure': {
                        'code': str(getattr(exc, 'code', 'catalog_refresh_failed')),
                        'message': 'The latest security definition refresh was unusable.',
                        'diagnostics': _exception_diagnostics(exc),
                    },
                }
            cached['last_refresh'] = now
            cached['refresh'] = refresh
        catalog = cached['catalog']
        return catalog, _security_catalog_public_state(
            catalog, cached['refresh']
        ), locale


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
    comment_scope=None, with_catalog=True, with_security_catalog=False,
):
    module = _load_admix()
    kwargs = {
        'load_preferences': bool(load_preferences),
        'state_directory': str(GPO_EDITOR_STATE_DIRECTORY),
        'state_key': context.guid,
    }
    catalog_state = None
    security_catalog_state = None
    locales = []
    if with_catalog:
        catalog, catalog_state = _get_catalog(module)
        locales = _select_locales(
            requested_locales, catalog_state['generation']
        )
        kwargs['template_catalog'] = catalog
        kwargs['locales'] = locales
    if with_security_catalog:
        security_catalog, security_catalog_state, security_locale = (
            _get_security_catalog(requested_locales, module)
        )
        kwargs['security_catalog'] = security_catalog
        if not locales:
            locales = [security_locale]
    if comment_scope is not None:
        kwargs['comments'] = _comments_config(comment_scope, locales)
    workspace_class = getattr(module, 'GroupPolicyWorkspace', None)
    if workspace_class is None:
        workspace_class = module.HighLevelApi
    # The constructor pins an immutable native generation. A background
    # refresh may publish between cached-state acquisition and that pin.
    for _attempt in range(3):
        try:
            workspace = workspace_class(str(context.gpo_root), **kwargs)
        except Exception:
            if not with_catalog:
                raise
            # A removed ADML locale can make the constructor reject a locale
            # selected from the previous generation. Retry only that race;
            # unrelated workspace errors retain their original error contract.
            selected = _select_locales(requested_locales, catalog.generation())
            if selected == locales:
                raise
            locales = selected
            kwargs['locales'] = locales
            if comment_scope is not None:
                kwargs['comments'] = _comments_config(comment_scope, locales)
            continue
        generation_reader = getattr(workspace, 'template_generation', None)
        if not with_catalog or generation_reader is None:
            break
        generation = dict(generation_reader())
        if catalog_state['generation'] != generation:
            # Workspace diagnostics include the pinned catalog's diagnostics.
            # Do not attach refresh/diagnostics from a different generation.
            catalog_state = {
                **catalog_state, 'generation': generation,
                'diagnostics': [], 'refresh': None,
            }
        selected = _select_locales(requested_locales, generation)
        if selected == locales:
            break
        locales = selected
        kwargs['locales'] = locales
        if comment_scope is not None:
            kwargs['comments'] = _comments_config(comment_scope, locales)
    else:
        raise EditorFailure(
            'operational', 'Administrative templates could not be refreshed.',
        )
    return workspace, {
        'catalog': catalog_state,
        'security_catalog': security_catalog_state,
        'locales': locales,
    }


def _reset_editor_globals_for_tests():
    global _catalog, _catalog_state, _catalog_last_refresh, _catalog_refresh_result
    global _admix_module
    _stop_catalog_monitor()
    with _catalog_lock:
        _catalog = None
        _catalog_state = None
        _catalog_last_refresh = 0.0
        _catalog_refresh_result = None
        _admix_module = None
    with _security_catalog_lock:
        _security_catalogs.clear()


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
    affected_scopes = plan['affected_scopes']
    if (
        not isinstance(plan['machine_extension_names'], str)
        or not isinstance(plan['user_extension_names'], str)
        or not isinstance(plan['idempotency_token'], str)
        or not plan['idempotency_token'].strip()
        or not isinstance(affected_scopes, dict)
        or set(affected_scopes) != {'computer', 'user'}
        or not all(type(value) is bool for value in affected_scopes.values())
        or not any(affected_scopes.values())
    ):
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
    for scope, extension_key in (
        ('computer', 'machine_extension_names'),
        ('user', 'user_extension_names'),
    ):
        if (
            not affected_scopes[scope]
            and plan[extension_key] != expected_snapshot[extension_key]
        ):
            raise EditorFailure(
                'operational',
                'The publication plan changes an unaffected scope.',
            )
    if (
        type(plan['expected_version']) is not int
        or type(plan['target_version']) is not int
    ):
        raise EditorFailure(
            'operational',
            'The editor binding returned an invalid publication version.',
        )
    expected_version = plan['expected_version']
    target_version = plan['target_version']
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
    expected_computer = expected_version & 0xffff
    expected_user = (expected_version >> 16) & 0xffff
    target_computer = (
        expected_computer + int(affected_scopes['computer'])
    ) & 0xffff
    target_user = (
        expected_user + int(affected_scopes['user'])
    ) & 0xffff
    required_target = (target_user << 16) | target_computer
    if target_version != required_target:
        raise EditorFailure(
            'operational',
            'The editor binding returned an invalid target version transition.',
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
        'ipaGpoFileSysPath',
        identity['file_sys_path'],
        identity['file_sys_path'],
        True,
    )
    modifications.extend(_compare_replace_modifications(
        ldap_backend,
        'ipaGpoVersionNumber',
        expected_snapshot['version_number'],
        int(plan['target_version']),
        expected_presence.get('version_number', True),
    ))
    for attribute, snapshot_key, plan_key in (
        (
            'ipaGpoMachineExtensionNames',
            'machine_extension_names',
            'machine_extension_names',
        ),
        (
            'ipaGpoUserExtensionNames',
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
    security_catalog = runtime.get('security_catalog')
    if security_catalog:
        diagnostics = security_catalog.get('diagnostics', []) + diagnostics
    return {
        'gpo': {
            'displayname': context.displayname,
            'guid': context.guid,
            'distinguished_name': str(context.dn),
        },
        'snapshot': _public_snapshot(context.snapshot),
        'template': catalog,
        'security_catalog_status': security_catalog,
        'locales': list(runtime.get('locales') or ()),
        'diagnostics': diagnostics,
        'pending_publication': _public_pending(pending),
    }


def _script_assets_public(assets):
    result = []
    for asset in assets or ():
        item = dict(asset)
        references = []
        for reference in item.get('references') or ():
            references.append({
                'event': str(reference.get('event') or ''),
                'executable_group': str(
                    reference.get('executable_group') or ''
                ),
                'index': int(reference.get('index', 0)),
            })
        result.append({
            'name': str(item.get('name') or ''),
            'byte_size': int(item.get('byte_size', 0)),
            'revision': str(item.get('revision') or ''),
            'references': references,
        })
    return result


def _script_group_public(group, event, assets):
    asset_names = {
        item['name'].casefold(): item['name'] for item in assets
    }
    entries = []
    for entry in dict(group).get('entries') or ():
        if entry.get('event') != event:
            continue
        candidate = entry.get('managed_asset_name')
        managed_name = None
        if isinstance(candidate, str):
            managed_name = asset_names.get(candidate.casefold())
        entries.append({
            'identity': str(entry.get('identity') or ''),
            'command_line': str(entry.get('command_line') or ''),
            'parameters': str(entry.get('parameters') or ''),
            'managed_asset_name': managed_name,
            'kind': 'managed_asset' if managed_name else 'external',
        })
    source_diagnostics = list(group.get('diagnostics') or ())
    diagnostics = _sanitize_diagnostics(source_diagnostics)
    for source, public in zip(source_diagnostics, diagnostics):
        if isinstance(source, dict) and isinstance(source.get('code'), str):
            public['code'] = source['code']
    return {
        'snapshot': str(group.get('snapshot') or ''),
        'editable': bool(group.get('editable')),
        'entries': entries,
        'diagnostics': diagnostics,
    }


def _script_order_value(event, execution_order):
    field = (
        'start_execute_ps_first'
        if event in ('startup', 'logon')
        else 'end_execute_ps_first'
    )
    value = dict(execution_order or {}).get(field)
    if value is None:
        return 'unspecified'
    return 'powershell_first' if value else 'classic_first'


def _script_event_view(workspace, scope, event):
    assets = _script_assets_public(workspace.list_script_assets(scope, event))
    classic = workspace.show_script_group(scope, 'classic')
    powershell = workspace.show_script_group(scope, 'powershell')
    return {
        'scope': scope,
        'event': event,
        'classic': _script_group_public(classic, event, assets),
        'powershell': _script_group_public(powershell, event, assets),
        'execution_order': _script_order_value(
            event, powershell.get('execution_order')
        ),
        'assets': assets,
        'upload_limit_bytes': GPO_SCRIPT_UPLOAD_MAX_BYTES,
    }


def _scripts_response(
    context, runtime, workspace, scope, event, publication=None,
):
    result = _editor_envelope(context, runtime, workspace)
    result['scripts'] = _script_event_view(workspace, scope, event)
    if publication is not None:
        result['publication'] = publication
    return result


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
    _validate_publication_plan(plan, starting_snapshot)
    if (
        affected != plan['affected_scopes']
        or not isinstance(pending, dict)
        or pending.get('phase') != 'awaiting_directory_publication'
        or pending.get('plan') != plan
        or pending.get('precondition') != starting_snapshot
    ):
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
    if not isinstance(pending, dict):
        raise EditorFailure(
            'recovery_operator_action',
            'Publication recovery has no complete pending state.',
        )

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
    if kind in ('apply', 'acknowledge'):
        original_plan = pending.get('plan')
        if (
            not isinstance(original_plan, dict)
            or action.get('plan') != original_plan
        ):
            raise EditorFailure(
                'recovery_operator_action',
                'Publication recovery does not match the original plan.',
            )
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


def _structured_request(request, allowed, required=()):
    if not isinstance(request, dict):
        raise EditorFailure(
            'validation', 'A structured request is required.', field='request'
        )
    unknown = sorted(set(request) - set(allowed))
    if unknown:
        raise EditorFailure(
            'validation',
            'The request contains an unknown field.',
            field='request',
            details={'unknown_fields': unknown},
        )
    missing = [name for name in required if name not in request]
    if missing:
        raise EditorFailure(
            'validation',
            'The request is missing a required field.',
            field='request',
            details={'missing_fields': missing},
        )
    return request


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
        elif action == 'move':
            # Both paths address the pre-move tree; the library rebases the
            # destination and applies index after removing the source.
            workspace.move_preference_filter(
                scope,
                kind,
                identity,
                list(operation.get('source_path') or ()),
                list(operation.get('collection_path') or ()),
                int(operation.get('index', 0)),
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
        script_details = _public_script_error_details(code, exc)
        mapping = {
            'invalid_argument': ('validation', 'The editor request is invalid.'),
            'validation': ('validation', 'The editor request is invalid.'),
            'not_found': ('not_found', 'The requested editor object was not found.'),
            'not_loaded': ('unsupported', 'The requested editor feature is unavailable.'),
            'conflict': ('storage_conflict', 'The GPO changed while it was being edited.'),
            'asset_collision': ('asset_collision', 'The script asset name is already in use.'),
            'asset_revision_conflict': ('asset_revision_conflict', 'The script asset changed while it was being edited.'),
            'asset_still_referenced': ('asset_still_referenced', 'The script asset is still referenced.'),
            'size_limit': ('size_limit', 'The script upload exceeds the allowed size.'),
            'malformed_source': ('malformed_source', 'The script source cannot be edited safely.'),
            'recoverable': ('publication_pending', 'The GPO has recoverable pending state.'),
            'publication_pending': ('publication_pending', 'The GPO has a pending publication.'),
            'durable_state_required': ('operational', 'The editor state directory is unavailable.'),
            'recovery_operator_action': ('recovery_operator_action', 'The GPO requires operator recovery.'),
            'io': ('operational', 'The GPO payload could not be accessed.'),
            'internal': ('operational', 'The GPO editor failed internally.'),
        }
        if code in mapping:
            category, message = mapping[code]
            details = script_details
            security_diagnostics = _sanitize_diagnostics(
                getattr(exc, 'diagnostics', ())
            )
            if security_diagnostics:
                details = dict(details or {})
                details['diagnostics'] = security_diagnostics
            failure = EditorFailure(
                category,
                message,
                field=getattr(exc, 'field', None),
                path=getattr(exc, 'path', None),
                details=details,
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


def _public_script_error_details(code, exc):
    """Allowlist owned script error details from the v3 binding."""
    raw = getattr(exc, 'script_details', None)
    if not isinstance(raw, dict):
        return None

    def safe_name(value):
        if not isinstance(value, str) or not value or len(value) > 255:
            return None
        if '\x00' in value or '/' in value or '\\' in value or value in ('.', '..'):
            return None
        return value

    if code == 'asset_collision':
        existing = _script_assets_public([raw.get('existing')])
        suggested_name = safe_name(raw.get('suggested_name'))
        if not existing or suggested_name is None:
            return None
        return {'existing': existing[0], 'suggested_name': suggested_name}
    if code == 'asset_revision_conflict':
        name = safe_name(raw.get('name'))
        expected = raw.get('expected_revision')
        actual = raw.get('actual_revision')
        if (name is None or not isinstance(expected, str)
                or not isinstance(actual, str)):
            return None
        return {
            'name': name,
            'expected_revision': expected,
            'actual_revision': actual,
        }
    if code == 'asset_still_referenced':
        name = safe_name(raw.get('name'))
        if name is None:
            return None
        references = []
        for reference in raw.get('references') or ():
            if not isinstance(reference, dict):
                return None
            event = reference.get('event')
            group = reference.get('executable_group')
            index = reference.get('index')
            if (event not in ('startup', 'shutdown', 'logon', 'logoff')
                    or group not in _SCRIPT_EXECUTABLE_GROUPS
                    or not isinstance(index, int) or index < 0):
                return None
            references.append({
                'event': event,
                'executable_group': group,
                'index': index,
            })
        return {'name': name, 'references': references}
    return None

@register()
class gpo(LDAPObject):
    """
    Group Policy Object.
    """
    container_dn = None
    object_name = _('Group Policy Object')
    object_name_plural = _('Group Policy Objects')
    object_class = ['ipaGpoContainer']
    permission_filter_objectclasses = ['ipaGpoContainer']
    default_attributes = [
        'cn', 'displayName', 'distinguishedName', 'ipaGpoFlags',
        'ipaGpoVersionNumber', 'ipaGpoMachineExtensionNames', 'ipaGpoUserExtensionNames',
    ]
    search_display_attributes = [
        'cn', 'displayName', 'ipaGpoFlags', 'ipaGpoVersionNumber',
        'ipaGpoMachineExtensionNames', 'ipaGpoUserExtensionNames',
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
                'cn', 'displayName', 'distinguishedName', 'ipaGpoFlags',
                'objectclass', 'ipaGpoFileSysPath', 'ipaGpoVersionNumber',
                'ipaGpoMachineExtensionNames', 'ipaGpoUserExtensionNames',
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
                'displayName', 'ipaGpoFlags',
                'ipaGpoFileSysPath', 'ipaGpoVersionNumber',
                'ipaGpoMachineExtensionNames', 'ipaGpoUserExtensionNames',
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
            pattern_errmsg=constants.ERRMSG_GROUPUSER_NAME.format('gpo'),
        ),
        Str('cn?',
            label=_('Policy GUID'),
            doc=_('Group Policy Object GUID'),
        ),
        Str('distinguishedname?',
            label=_('Distinguished Name'),
            doc=_('Distinguished name of the group policy object'),
        ),
        Int('ipagpoflags?', cli_name='flags',
            label=_('Flags'),
            doc=_('Group Policy Object flags'),
            default=0,
        ),
        Str('ipagpofilesyspath?', cli_name='gpcfilesyspath',
            label=_('File system path'),
            doc=_('Path to policy files on the file system'),
        ),
        Int('ipagpoversionnumber?', cli_name='versionnumber',
            label=_('Version number'),
            doc=_('Version number of the policy'),
            default=0,
            minvalue=0,
        ),
        Str('ipagpomachineextensionnames?', cli_name='gpcmachineextensionnames',
            label=_('Machine extension names'),
            doc=_('Canonical machine-side Group Policy extension pairs'),
        ),
        Str('ipagpouserextensionnames?', cli_name='gpcuserextensionnames',
            label=_('User extension names'),
            doc=_('Canonical user-side Group Policy extension pairs'),
        ),
    )

    def __json__(self):
        """Handle missing schema gracefully."""
        try:
            return super(gpo, self).__json__()
        except KeyError as e:
            if 'ipaGpoContainer' in str(e):
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
        if getattr(self.env, 'context', None) == 'server':
            _start_catalog_monitor()

    def find_gpo_by_displayname(self, ldap, displayname):
        try:
            entry = ldap.find_entry_by_attr(
                'displayName',
                displayname,
                'ipaGpoContainer',
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
            response = method(
                *params,
                timeout=ODDJOB_DBUS_TIMEOUT_SECONDS,
            )
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
        except Exception as e:
            error_msg = (
                f'Unexpected failure calling D-Bus {method_name}: {str(e)}'
            )
            logger.error(error_msg)

            if fail_on_error:
                raise errors.ExecutionError(
                    message=_('Unexpected D-Bus service failure')
                )
            logger.warning(error_msg)
            return None

        try:
            ret, stdout, stderr = response
        except (TypeError, ValueError) as e:
            error_msg = (
                f'Invalid response from D-Bus {method_name}: {str(e)}'
            )
            logger.error(error_msg)

            if fail_on_error:
                raise errors.ExecutionError(
                    message=_('Invalid response from D-Bus service')
                )
            logger.warning(error_msg)
            return None

        if ret != 0:
            error_msg = f"Failed to {method_name.replace('_', ' ')}: {stderr}"
            logger.error(error_msg)

            if fail_on_error:
                raise errors.ExecutionError(
                    message=_(f'Failed to {method_name.replace("_", " ")}: %(error)s')
                            % {'error': stderr or _('Unknown error')}
                )
            logger.warning(error_msg)
            return stdout if return_stdout else None

        return stdout if return_stdout else None

@register()
class gpo_add(LDAPCreate):
    __doc__ = _('Create a new Group Policy Object.')
    msg_summary = _('Added Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, entry_attrs, attrs_list, *keys, **options):
        verify_gpo_schema(ldap, self.api)
        displayname = keys[-1]
        if ('displayname' in entry_attrs and
                entry_attrs['displayname'] != displayname):
            raise errors.ValidationError(
                name='displayname',
                error=_(
                    'displayName supplied as an attribute must match '
                    'the command argument'
                )
            )
        if not re.match(constants.PATTERN_GROUPUSER_NAME, displayname):
            raise errors.ValidationError(
                name='displayname',
                error=constants.ERRMSG_GROUPUSER_NAME.format('gpo')
            )
        try:
            self.obj.find_gpo_by_displayname(ldap, displayname)
            raise errors.InvocationError(
                message=_('A Group Policy Object with displayName' \
                ' "%s" already exists.') % displayname
            )
        except errors.NotFound:
            pass

        entry_attrs['displayname'] = displayname
        guid = '{' + str(uuid.uuid4()).upper() + '}'
        dn = DN(
            ('cn', guid),
            self.api.env.container_grouppolicy,
            self.api.env.basedn,
        )
        entry_attrs['cn'] = guid
        entry_attrs['distinguishedname'] = str(dn)
        entry_attrs['ipagpofilesyspath'] = (
            f"\\\\{self.api.env.domain}\\SysVol\\{self.api.env.domain}"
            f"\\Policies\\{guid}"
        )
        entry_attrs['ipagpoflags'] = 0
        entry_attrs['ipagpoversionnumber'] = 0

        return dn

    def post_callback(self, ldap, dn, entry_attrs, *keys, **options):
        guid = str(dn[0].value)
        domain = self.api.env.domain.lower()
        displayname = keys[-1] if keys else 'New Group Policy Object'
        try:
            self.obj._call_dbus_method(
                'create_gpo_structure',
                guid,
                domain,
                displayname,
                fail_on_error=True,
            )
        except Exception:
            try:
                self.obj._call_dbus_method(
                    'delete_gpo_structure',
                    guid,
                    domain,
                    fail_on_error=False,
                )
            except Exception:
                logger.exception(
                    "Failed to clean SYSVOL after GPO creation failure"
                )
            try:
                ldap.delete_entry(dn)
            except Exception:
                logger.exception(
                    "Failed to roll back LDAP GPO after creation failure"
                )
            raise

        return dn


@register()
class gpo_del(LDAPDelete):
    __doc__ = _("Delete a Group Policy Object.")
    msg_summary = _('Deleted Group Policy Object "%(value)s"')

    def pre_callback(self, ldap, dn, *keys, **options):
        verify_gpo_schema(ldap, self.api)
        entry = self.obj.find_gpo_by_displayname(ldap, keys[0])
        return entry.dn

    def post_callback(self, ldap, dn, *keys, **options):

        guid = str(dn[0].value)
        domain = self.api.env.domain.lower()
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
        verify_gpo_schema(self.api.Backend.ldap2, self.api)
        try:
            return super(gpo_find, self).execute(*args, **options)

        except errors.NotFound:
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

        rename_name = options.get('rename')
        attribute_name = (
            entry_attrs.get('displayname')
            if 'displayname' in entry_attrs else None
        )
        if (rename_name and attribute_name is not None and
                rename_name != attribute_name):
            raise errors.ValidationError(
                name='displayname',
                error=_(
                    'rename and displayName attribute contain conflicting '
                    'values'
                )
            )

        if rename_name or 'displayname' in entry_attrs:
            new_name = rename_name or attribute_name
            option_name = 'rename' if rename_name else 'displayname'
            if (not isinstance(new_name, str) or
                    not re.match(constants.PATTERN_GROUPUSER_NAME, new_name)):
                raise errors.ValidationError(
                    name='displayname',
                    error=constants.ERRMSG_GROUPUSER_NAME.format('gpo')
                )
            if new_name == keys[0]:
                raise errors.ValidationError(
                    name=option_name,
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


def _policy_catalog_index(workspace, scope, locales):
    """Project the complete native catalog without opening policy snapshots."""
    def children(category_id):
        nodes = workspace.list_policies(scope, category_id, locales)
        if not isinstance(nodes, (list, tuple)):
            raise EditorFailure(
                'operational',
                'The editor binding returned an invalid policy catalog.',
            )
        return iter(nodes)

    policies = []
    seen_policies = set()
    seen_categories = set()
    path = []
    # Iterators and one mutable display path avoid recursion limits and copies
    # of every ancestor path while visiting deeply nested categories.
    pending = [children(None)]
    node_count = 0
    while pending:
        try:
            node = next(pending[-1])
        except StopIteration:
            pending.pop()
            if path:
                path.pop()
            continue
        node_count += 1
        if node_count > GPO_POLICY_INDEX_MAX_NODES:
            raise EditorFailure(
                'operational',
                'The policy catalog exceeds the editor index resource limit.',
            )
        if not isinstance(node, dict):
            raise EditorFailure(
                'operational',
                'The editor binding returned an invalid policy catalog node.',
            )
        kind = node.get('kind')
        identity = node.get('id')
        label = node.get('label')
        if (
            kind not in ('category', 'policy')
            or not isinstance(identity, str)
            or not identity
            or (label is not None and not isinstance(label, str))
        ):
            raise EditorFailure(
                'operational',
                'The editor binding returned an invalid policy catalog node.',
            )
        label = label or identity
        if kind == 'policy':
            if identity not in seen_policies:
                seen_policies.add(identity)
                policies.append({
                    'id': identity, 'label': label, 'path': list(path),
                })
        elif identity not in seen_categories:
            seen_categories.add(identity)
            path.append(label)
            pending.append(children(identity))
    return policies


def _validated_script_context(scope, event):
    normalized_scope = _validated_scope(scope)
    normalized_event = str(event or '').lower()
    if normalized_event not in _SCRIPT_EVENTS[normalized_scope]:
        raise EditorFailure(
            'validation',
            'The script event is not valid for this scope.',
            field='event',
        )
    return normalized_scope, normalized_event


def _script_request(request, allowed, required=()):
    if not isinstance(request, dict):
        raise EditorFailure(
            'validation', 'A structured scripts request is required.',
            field='request',
        )
    unknown = sorted(set(request) - set(allowed))
    if unknown:
        raise EditorFailure(
            'validation', 'The scripts request contains an unknown field.',
            field='request', details={'unknown_fields': unknown},
        )
    missing = [name for name in required if name not in request]
    if missing:
        raise EditorFailure(
            'validation', 'The scripts request is missing a required field.',
            field='request', details={'missing_fields': missing},
        )
    return request


def _script_text(request, field, allow_empty=False, maximum=32768):
    value = request.get(field)
    if not isinstance(value, str) or '\x00' in value:
        raise EditorFailure(
            'validation', 'The scripts request field is invalid.', field=field
        )
    if (not allow_empty and not value) or len(value) > maximum:
        raise EditorFailure(
            'validation', 'The scripts request field is invalid.', field=field
        )
    return value


def _script_group(request):
    group = _script_text(request, 'executable_group', maximum=32).lower()
    if group not in _SCRIPT_EXECUTABLE_GROUPS:
        raise EditorFailure(
            'validation', 'The script executable group is invalid.',
            field='executable_group',
        )
    return group


def _script_asset_name(request, field='name'):
    name = _script_text(request, field, maximum=255)
    if (
        name in ('.', '..')
        or '/' in name
        or '\\' in name
        or name.strip() != name
    ):
        raise EditorFailure(
            'validation', 'The script asset name is invalid.', field=field
        )
    return name


def _script_order(request):
    value = _script_text(request, 'execution_order', maximum=32).lower()
    if value not in _SCRIPT_EXECUTION_ORDERS:
        raise EditorFailure(
            'validation', 'The script execution order is invalid.',
            field='execution_order',
        )
    return value


def _script_identity(request, field='identity'):
    return _script_text(request, field, maximum=4096)


def _decode_script_upload(request):
    value = request.get('content_base64')
    if not isinstance(value, str):
        raise EditorFailure(
            'validation', 'The script upload content is invalid.',
            field='content_base64',
        )
    if len(value) > GPO_SCRIPT_UPLOAD_MAX_ENCODED_BYTES:
        raise EditorFailure(
            'size_limit', 'The script upload exceeds the allowed size.',
            field='content_base64',
            details={'limit_bytes': GPO_SCRIPT_UPLOAD_MAX_BYTES},
        )
    try:
        payload = base64.b64decode(value.encode('ascii'), validate=True)
    except (UnicodeEncodeError, binascii.Error) as exc:
        raise EditorFailure(
            'validation', 'The script upload content is invalid.',
            field='content_base64',
        ) from exc
    if len(payload) > GPO_SCRIPT_UPLOAD_MAX_BYTES:
        raise EditorFailure(
            'size_limit', 'The script upload exceeds the allowed size.',
            field='content_base64',
            details={'limit_bytes': GPO_SCRIPT_UPLOAD_MAX_BYTES},
        )
    return payload


def _run_scripts_mutation(command, displayname, scope, event, operation):
    """Run one trusted scripts transaction and publish it once."""
    context = command._context(displayname, write=True)
    ldap_backend = command.api.Backend.ldap2
    workspace, runtime = _open_workspace(context, with_catalog=False)
    _recover_before_mutation(workspace, ldap_backend, context)
    operation(workspace)
    publication = _commit_external_once(workspace, ldap_backend, context)
    return _scripts_response(
        context, runtime, workspace, scope, event, publication=publication
    )


def _script_asset_collision(workspace, scope, event, name):
    collision = workspace.script_asset_collision(scope, event, name)
    if collision is None:
        return
    existing = _script_assets_public([collision.get('existing')])
    raise EditorFailure(
        'asset_collision', 'The script asset name is already in use.',
        field='name', details={
            'existing': existing[0] if existing else {},
            'suggested_name': str(collision.get('suggested_name') or ''),
        },
    )


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


def _security_invalid(message, field='request'):
    raise EditorFailure('validation', message, field=field)


def _restore_rpc_arrays(value):
    """Undo FreeIPA's JSON object-hook conversion of arrays to tuples.

    ``ipalib.ipajson._ipa_obj_hook`` changes every JSON array stored in an
    object to a tuple, including nested policy actions and typed values.
    The editor DTOs require lists.  Keep already-correct Python inputs intact
    and only copy containers along paths containing converted arrays.
    """
    if isinstance(value, tuple):
        return [_restore_rpc_arrays(item) for item in value]
    if isinstance(value, list):
        restored = [_restore_rpc_arrays(item) for item in value]
        return (value if all(a is b for a, b in zip(value, restored))
                else restored)
    if isinstance(value, dict):
        restored = {key: _restore_rpc_arrays(item) for key, item in value.items()}
        return (value if all(restored[key] is item for key, item in value.items())
                else restored)
    return value


def _security_nonempty(value, field):
    if not isinstance(value, str) or not value:
        _security_invalid('A non-empty identifier is required.', field)


def _security_reject_unknown(value, allowed, field):
    if set(value) - set(allowed):
        _security_invalid(
            'The security definition update contains unknown fields.', field
        )


def _security_validate_value(value, field):
    if not isinstance(value, dict):
        _security_invalid('A typed security definition value is required.', field)
    _security_reject_unknown(value, ('kind', 'value'), field)
    _security_nonempty(value.get('kind'), '{}.kind'.format(field))
    if 'value' not in value:
        _security_invalid('A typed security definition value is required.', field)


def _security_validate_element_state(value, field):
    if not isinstance(value, dict):
        _security_invalid('A keyed-row field state is required.', field)
    state = value.get('state')
    if state == 'unset':
        _security_reject_unknown(value, ('state',), field)
    elif state == 'set':
        _security_reject_unknown(value, ('state', 'value'), field)
        _security_validate_value(value.get('value'), '{}.value'.format(field))
    else:
        _security_invalid('A keyed-row field state must be set or unset.', field)


def _security_validate_row(value, field):
    if not isinstance(value, dict):
        _security_invalid('A keyed-row action is required.', field)
    action = value.get('action')
    if action == 'delete':
        _security_reject_unknown(value, ('action', 'key'), field)
    elif action == 'upsert':
        _security_reject_unknown(value, ('action', 'key', 'fields'), field)
        fields = value.get('fields', {})
        if not isinstance(fields, dict):
            _security_invalid('Keyed-row fields must be an object.', '{}.fields'.format(field))
        for name, state in fields.items():
            _security_nonempty(name, '{}.fields'.format(field))
            _security_validate_element_state(
                state, '{}.fields.{}'.format(field, name)
            )
    else:
        _security_invalid('A keyed-row action must be upsert or delete.', field)
    _security_validate_value(value.get('key'), '{}.key'.format(field))


def _security_validate_element(value, field):
    if not isinstance(value, dict):
        _security_invalid('A security element action is required.', field)
    _security_nonempty(value.get('element_id'), '{}.element_id'.format(field))
    action = value.get('action')
    if action == 'unset':
        _security_reject_unknown(value, ('element_id', 'action'), field)
    elif action == 'set':
        _security_reject_unknown(value, ('element_id', 'action', 'value'), field)
        _security_validate_value(value.get('value'), '{}.value'.format(field))
    elif action == 'rows':
        _security_reject_unknown(value, ('element_id', 'action', 'rows'), field)
        rows = value.get('rows')
        if not isinstance(rows, list):
            _security_invalid('Keyed-row actions must be a list.', '{}.rows'.format(field))
        for index, row in enumerate(rows):
            _security_validate_row(row, '{}.rows[{}]'.format(field, index))
    else:
        _security_invalid('An element action must be set, unset, or rows.', field)


def _validate_security_update(request):
    if not isinstance(request, dict):
        _security_invalid('A structured security definition update is required.')
    request = _restore_rpc_arrays(request)
    _security_reject_unknown(
        request, ('expected_semantic_revision', 'policies'), 'request'
    )
    _security_nonempty(
        request.get('expected_semantic_revision'),
        'request.expected_semantic_revision',
    )
    policies = request.get('policies')
    if not isinstance(policies, list):
        _security_invalid('Security policy actions must be a list.', 'request.policies')
    seen = set()
    for policy_index, policy in enumerate(policies):
        field = 'request.policies[{}]'.format(policy_index)
        if not isinstance(policy, dict):
            _security_invalid('A security policy action is required.', field)
        _security_reject_unknown(
            policy, ('namespace', 'policy_id', 'transition', 'elements'), field
        )
        _security_nonempty(policy.get('namespace'), '{}.namespace'.format(field))
        _security_nonempty(policy.get('policy_id'), '{}.policy_id'.format(field))
        identity = (policy['namespace'], policy['policy_id'])
        if identity in seen:
            _security_invalid('A security policy may be updated only once.', field)
        seen.add(identity)
        transition = policy.get('transition')
        if 'transition' in policy and transition not in ('define', 'undefine'):
            _security_invalid(
                'A policy transition must be define or undefine.',
                '{}.transition'.format(field),
            )
        elements = policy.get('elements', [])
        if not isinstance(elements, list):
            _security_invalid(
                'Security element actions must be a list.', '{}.elements'.format(field)
            )
        element_ids = set()
        for element_index, element in enumerate(elements):
            element_field = '{}.elements[{}]'.format(field, element_index)
            _security_validate_element(element, element_field)
            if element['element_id'] in element_ids:
                _security_invalid(
                    'A security element may be updated only once.', element_field
                )
            element_ids.add(element['element_id'])
        if transition == 'undefine' and elements:
            _security_invalid(
                'Undefine cannot include element actions.', '{}.elements'.format(field)
            )
    return request


def _assert_safe_security_projection(value, path='result'):
    """Reject library DTOs containing secret fields before exposing them by RPC."""
    prohibited = {
        'cpassword', 'plaintext', 'plaintext_password',
        'ciphertext', 'encrypted_password', 'secret_value',
    }
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace('-', '_').casefold()
            if normalized in prohibited:
                raise EditorFailure(
                    'operational', 'The editor library returned a prohibited secret field.',
                    details={'path': path},
                )
            _assert_safe_security_projection(child, '{}.{}'.format(path, key))
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _assert_safe_security_projection(
                child, '{}[{}]'.format(path, index)
            )


def _security_definition_result(context, runtime, workspace):
    result = _editor_envelope(context, runtime, workspace)
    result['security_catalog'] = workspace.security_definition_catalog()
    snapshot = dict(workspace.security_definition_snapshot())
    snapshot['diagnostics'] = _sanitize_diagnostics(
        snapshot.get('diagnostics', ())
    )
    result['security_snapshot'] = snapshot
    # The target service inventory is intentionally supplied by the operator;
    # the FreeIPA host cannot infer a Windows fleet's installed services.
    result['security_service_catalog'] = []
    _assert_safe_security_projection(result)
    return result


def _security_definition_show(command, displayname, locales):
    context = command._context(displayname)
    workspace, runtime = _open_workspace(
        context, locales or (), load_preferences=False,
        with_catalog=False, with_security_catalog=True,
    )
    return _security_definition_result(context, runtime, workspace)


def _security_definition_update(command, displayname, request, locales):
    request = _validate_security_update(request)
    context = command._context(displayname, write=True)
    ldap_backend = command.api.Backend.ldap2
    workspace, runtime = _open_workspace(
        context, locales or (), load_preferences=False,
        with_catalog=False, with_security_catalog=True,
    )
    _recover_before_mutation(workspace, ldap_backend, context)
    workspace.update_security_definitions(request)
    publication = _commit_external_once(workspace, ldap_backend, context)
    result = _security_definition_result(context, runtime, workspace)
    result['publication'] = publication
    return result


@register()
class gpo_editor_security_definitions_show(_GpoEditorCommand):
    __doc__ = _('Display Security Settings from external SDMX/SDML definitions.')

    takes_args = (Str('displayname', label=_('Policy name')),)
    takes_options = (Str('locales*', label=_('Preferred locales')),)

    def execute(self, displayname, locales=None, **options):
        return self._run(
            lambda: _security_definition_show(self, displayname, locales)
        )


@register()
class gpo_editor_security_definitions_update(_GpoEditorCommand):
    __doc__ = _('Atomically update externally defined Security Settings.')

    takes_args = (Str('displayname', label=_('Policy name')),)
    takes_options = (
        Dict('request', label=_('Structured security definition update')),
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(self, displayname, request, locales=None, **options):
        return self._run(
            lambda: _security_definition_update(self, displayname, request, locales)
        )


@register()
class gpo_editor_security_show(gpo_editor_security_definitions_show):
    __doc__ = _('Display externally defined Security Settings (compatibility alias).')


@register()
class gpo_editor_security_update(gpo_editor_security_definitions_update):
    __doc__ = _('Update externally defined Security Settings (compatibility alias).')


def _validate_advanced_audit_update(request):
    if not isinstance(request, dict):
        raise EditorFailure(
            'validation', 'A structured Advanced Audit update is required.',
            field='request',
        )
    request = _restore_rpc_arrays(request)
    fields = (
        'set_subcategories', 'clear_subcategories',
        'set_options', 'clear_options',
        'set_global_sacls', 'clear_global_sacls',
    )
    if set(request) - set(fields):
        raise EditorFailure(
            'validation', 'The Advanced Audit update contains unknown fields.',
            field='request',
        )
    normalized = {}
    for field in fields:
        operations = request.get(field, [])
        if not isinstance(operations, list):
            raise EditorFailure(
                'validation', 'Advanced Audit operations must be lists.',
                field='request.{}'.format(field),
            )
        objects = field.startswith('set_') or field == 'clear_subcategories'
        if objects and not all(isinstance(item, dict) for item in operations):
            raise EditorFailure(
                'validation', 'Advanced Audit operations must be objects.',
                field='request.{}'.format(field),
            )
        if not objects and not all(isinstance(item, str) for item in operations):
            raise EditorFailure(
                'validation', 'Advanced Audit clear operations must be strings.',
                field='request.{}'.format(field),
            )
        normalized[field] = operations
    return normalized


@register()
class gpo_editor_advanced_audit_show(_GpoEditorCommand):
    __doc__ = _('Display Advanced Audit Policy Configuration.')

    takes_args = (Str('displayname', label=_('Policy name')),)

    def execute(self, displayname, **options):
        def operation():
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, load_preferences=False, with_catalog=False
            )
            advanced_audit = workspace.get_advanced_audit()
            _assert_safe_security_projection(advanced_audit)
            result = _editor_envelope(context, runtime, workspace)
            result['advanced_audit'] = advanced_audit
            return result
        return self._run(operation)


@register()
class gpo_editor_advanced_audit_update(_GpoEditorCommand):
    __doc__ = _('Atomically update Advanced Audit Policy Configuration.')

    takes_args = (Str('displayname', label=_('Policy name')),)
    takes_options = (Dict('request', label=_('Structured Advanced Audit update')),)

    def execute(self, displayname, request, **options):
        def operation():
            normalized = _validate_advanced_audit_update(request)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=False, with_catalog=False
            )
            _recover_before_mutation(workspace, ldap_backend, context)
            advanced_audit = workspace.update_advanced_audit(normalized)
            _assert_safe_security_projection(advanced_audit)
            publication = _commit_external_once(
                workspace, ldap_backend, context
            )
            result = _editor_envelope(context, runtime, workspace)
            result['advanced_audit'] = advanced_audit
            result['publication'] = publication
            return result
        return self._run(operation)


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
class gpo_editor_policy_index(_GpoEditorCommand):
    __doc__ = _('List the complete Administrative Template policy index.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Policy scope')),
    )
    takes_options = (
        Str('locales*', label=_('Preferred locales')),
    )

    def execute(self, displayname, scope, locales=None, **options):
        def operation():
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, locales or (), load_preferences=False
            )
            policies = _policy_catalog_index(
                workspace, normalized_scope, runtime['locales']
            )
            result = _editor_envelope(context, runtime, workspace)
            result['policies'] = policies
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
            policy_request = _restore_rpc_arrays(request)
            _structured_request(
                policy_request,
                ('state', 'set_parameters', 'clear_parameters', 'comment'),
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
                if request_key in policy_request:
                    update_kwargs[binding_key] = policy_request[request_key]
                    has_policy_update = True
            if has_policy_update:
                policy = workspace.update_policy(
                    normalized_scope, policy_id, **update_kwargs
                )
            else:
                policy = workspace.get_policy(
                    normalized_scope, policy_id, runtime['locales']
                )

            comment = policy_request.get('comment')
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
                context, load_preferences=True, with_catalog=False
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
                context, load_preferences=True, with_catalog=False
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
            _structured_request(request, ('identity',))
            context = self._context(displayname)
            workspace, runtime = _open_workspace(
                context, load_preferences=True, with_catalog=False
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
            _structured_request(
                request,
                ('fields', 'filters', 'parent'),
                required=('fields',),
            )
            normalized_scope = _validated_scope(scope)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True, with_catalog=False
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
            _structured_request(
                request,
                ('identity', 'fields', 'name', 'filters'),
                required=('identity',),
            )
            identity = _identity(request)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True, with_catalog=False
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
            _structured_request(
                request,
                ('identity',),
                required=('identity',),
            )
            identity = _identity(request)
            context = self._context(displayname, write=True)
            ldap_backend = self.api.Backend.ldap2
            workspace, runtime = _open_workspace(
                context, load_preferences=True, with_catalog=False
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


@register()
class gpo_editor_scripts_show(_GpoEditorCommand):
    __doc__ = _('Display one high-level Group Policy Scripts event.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )

    def execute(self, displayname, scope, event, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            context = self._context(displayname)
            workspace, runtime = _open_workspace(context, with_catalog=False)
            return _scripts_response(
                context, runtime, workspace, normalized_scope, normalized_event
            )
        return self._run(operation)


@register()
class gpo_editor_script_files(_GpoEditorCommand):
    __doc__ = _('List managed files for one Group Policy Scripts event.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )

    def execute(self, displayname, scope, event, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            context = self._context(displayname)
            workspace, runtime = _open_workspace(context, with_catalog=False)
            return _scripts_response(
                context, runtime, workspace, normalized_scope, normalized_event
            )
        return self._run(operation)


@register()
class gpo_editor_script_asset_download(_GpoEditorCommand):
    __doc__ = _('Download a revision-checked managed Group Policy script file.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script download request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('name', 'revision'), ('name', 'revision')
            )
            name = _script_asset_name(request_data)
            revision = _script_identity(request_data, 'revision')
            context = self._context(displayname)
            workspace, runtime = _open_workspace(context, with_catalog=False)
            asset = workspace.read_script_asset(
                normalized_scope, normalized_event, name, revision
            )
            if (
                not isinstance(asset, dict)
                or asset.get('name') != name
                or asset.get('revision') != revision
            ):
                raise EditorFailure(
                    'operational',
                    'The editor binding returned an invalid script asset.',
                )
            content = asset.get('content')
            if not isinstance(content, bytes):
                raise EditorFailure(
                    'operational',
                    'The editor binding returned invalid script content.',
                )
            if len(content) > GPO_SCRIPT_UPLOAD_MAX_BYTES:
                raise EditorFailure(
                    'size_limit', 'The script download exceeds the allowed size.',
                    field='name',
                    details={'limit_bytes': GPO_SCRIPT_UPLOAD_MAX_BYTES},
                )
            result = _editor_envelope(context, runtime, workspace)
            result['asset'] = {
                'name': name,
                'byte_size': len(content),
                'revision': revision,
                'content_base64': base64.b64encode(content).decode('ascii'),
            }
            return result
        return self._run(operation)


@register()
class gpo_editor_script_entry_add(_GpoEditorCommand):
    __doc__ = _('Atomically add a Group Policy Scripts entry.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script entry request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request,
                ('mode', 'executable_group', 'snapshot', 'name',
                 'command_line', 'parameters'),
                ('mode', 'executable_group', 'snapshot', 'parameters'),
            )
            group = _script_group(request_data)
            snapshot = _script_identity(request_data, 'snapshot')
            parameters = _script_text(
                request_data, 'parameters', allow_empty=True
            )
            mode = _script_text(request_data, 'mode', maximum=32)
            if mode == 'existing_asset':
                name = _script_asset_name(request_data)
                command_line = name
            elif mode == 'external_command':
                command_line = _script_text(request_data, 'command_line')
            else:
                raise EditorFailure(
                    'validation', 'The script entry mode is invalid.',
                    field='mode',
                )

            def mutate(workspace):
                if mode == 'existing_asset':
                    assets = _script_assets_public(
                        workspace.list_script_assets(
                            normalized_scope, normalized_event
                        )
                    )
                    matches = [
                        asset['name'] for asset in assets
                        if asset['name'].casefold() == name.casefold()
                    ]
                    if not matches:
                        raise EditorFailure(
                            'not_found', 'The managed script asset was not found.',
                            field='name',
                        )
                    command = matches[0]
                else:
                    command = command_line
                workspace.add_script_entry(
                    normalized_scope, group, normalized_event, snapshot,
                    command, parameters,
                )

            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event, mutate
            )
        return self._run(operation)


@register()
class gpo_editor_script_entry_update(_GpoEditorCommand):
    __doc__ = _('Atomically update a Group Policy Scripts entry.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script entry update')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request,
                ('executable_group', 'identity', 'command_line', 'parameters'),
                ('executable_group', 'identity', 'command_line', 'parameters'),
            )
            group = _script_group(request_data)
            identity = _script_identity(request_data)
            command_line = _script_text(request_data, 'command_line')
            parameters = _script_text(
                request_data, 'parameters', allow_empty=True
            )
            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event,
                lambda workspace: workspace.update_script_entry(
                    normalized_scope, group, normalized_event, identity,
                    command_line, parameters,
                ),
            )
        return self._run(operation)


@register()
class gpo_editor_script_entry_remove(_GpoEditorCommand):
    __doc__ = _('Atomically remove a Group Policy Scripts entry.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script entry removal')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request,
                ('executable_group', 'identity', 'delete_asset',
                 'asset_revision'),
                ('executable_group', 'identity'),
            )
            group = _script_group(request_data)
            identity = _script_identity(request_data)
            delete_asset = request_data.get('delete_asset', False)
            if not isinstance(delete_asset, bool):
                raise EditorFailure(
                    'validation', 'The script asset deletion mode is invalid.',
                    field='delete_asset',
                )
            revision = None
            if delete_asset:
                revision = _script_identity(request_data, 'asset_revision')

            def mutate(workspace):
                asset_name = None
                if delete_asset:
                    document = workspace.show_script_group(normalized_scope, group)
                    selected = next(
                        (
                            entry for entry in document.get('entries') or ()
                            if entry.get('event') == normalized_event
                            and entry.get('identity') == identity
                        ),
                        None,
                    )
                    candidate = selected and selected.get('managed_asset_name')
                    if not isinstance(candidate, str):
                        raise EditorFailure(
                            'validation',
                            'Only a managed script entry can delete an asset.',
                            field='delete_asset',
                        )
                    assets = _script_assets_public(
                        workspace.list_script_assets(
                            normalized_scope, normalized_event
                        )
                    )
                    asset_name = next(
                        (
                            asset['name'] for asset in assets
                            if asset['name'].casefold() == candidate.casefold()
                        ),
                        None,
                    )
                    if asset_name is None:
                        raise EditorFailure(
                            'not_found', 'The managed script asset was not found.',
                            field='identity',
                        )
                workspace.remove_script_entry(
                    normalized_scope, group, normalized_event, identity
                )
                if asset_name is not None:
                    workspace.delete_script_asset(
                        normalized_scope, normalized_event, asset_name, revision
                    )

            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event, mutate
            )
        return self._run(operation)


@register()
class gpo_editor_script_entries_reorder(_GpoEditorCommand):
    __doc__ = _('Atomically reorder a Group Policy Scripts event list.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script reorder request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('executable_group', 'snapshot', 'identities'),
                ('executable_group', 'snapshot', 'identities'),
            )
            group = _script_group(request_data)
            snapshot = _script_identity(request_data, 'snapshot')
            identities = request_data.get('identities')
            if isinstance(identities, tuple):
                # FreeIPA's JSON object hook turns nested JSON arrays into tuples.
                identities = list(identities)
            if not isinstance(identities, list) or not all(
                isinstance(identity, str) and identity and '\x00' not in identity
                for identity in identities
            ):
                raise EditorFailure(
                    'validation', 'The script entry order is invalid.',
                    field='identities',
                )
            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event,
                lambda workspace: workspace.reorder_script_entries(
                    normalized_scope, group, normalized_event, snapshot,
                    identities,
                ),
            )
        return self._run(operation)


@register()
class gpo_editor_script_order_update(_GpoEditorCommand):
    __doc__ = _('Atomically set Group Policy Scripts execution order.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script order request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('snapshot', 'execution_order'),
                ('snapshot', 'execution_order'),
            )
            snapshot = _script_identity(request_data, 'snapshot')
            order = _script_order(request_data)

            def mutate(workspace):
                powershell = workspace.show_script_group(
                    normalized_scope, 'powershell'
                )
                current = dict(powershell.get('execution_order') or {})
                value = {
                    'unspecified': None,
                    'classic_first': False,
                    'powershell_first': True,
                }[order]
                start = current.get('start_execute_ps_first')
                end = current.get('end_execute_ps_first')
                if normalized_event in ('startup', 'logon'):
                    start = value
                else:
                    end = value
                workspace.set_script_execution_order(
                    normalized_scope, snapshot, start, end
                )

            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event, mutate
            )
        return self._run(operation)


@register()
class gpo_editor_script_asset_upload(_GpoEditorCommand):
    __doc__ = _('Atomically upload an unreferenced Group Policy script asset.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script upload request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('name', 'content_base64'),
                ('name', 'content_base64'),
            )
            name = _script_asset_name(request_data)
            payload = _decode_script_upload(request_data)

            def mutate(workspace):
                _script_asset_collision(
                    workspace, normalized_scope, normalized_event, name
                )
                workspace.upload_script_asset(
                    normalized_scope, normalized_event, name, payload
                )

            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event, mutate
            )
        return self._run(operation)


@register()
class gpo_editor_script_upload_and_add(_GpoEditorCommand):
    __doc__ = _('Atomically upload and attach a Group Policy script asset.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script upload-and-add request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request,
                ('executable_group', 'snapshot', 'name', 'content_base64',
                 'parameters'),
                ('executable_group', 'snapshot', 'name', 'content_base64',
                 'parameters'),
            )
            group = _script_group(request_data)
            snapshot = _script_identity(request_data, 'snapshot')
            name = _script_asset_name(request_data)
            payload = _decode_script_upload(request_data)
            parameters = _script_text(
                request_data, 'parameters', allow_empty=True
            )

            def mutate(workspace):
                _script_asset_collision(
                    workspace, normalized_scope, normalized_event, name
                )
                workspace.upload_and_add_script_entry(
                    normalized_scope, group, normalized_event, snapshot,
                    name, payload, parameters,
                )

            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event, mutate
            )
        return self._run(operation)


@register()
class gpo_editor_script_asset_replace(_GpoEditorCommand):
    __doc__ = _('Atomically replace a managed Group Policy script asset.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script replacement request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('name', 'revision', 'content_base64'),
                ('name', 'revision', 'content_base64'),
            )
            name = _script_asset_name(request_data)
            revision = _script_identity(request_data, 'revision')
            payload = _decode_script_upload(request_data)
            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event,
                lambda workspace: workspace.replace_script_asset(
                    normalized_scope, normalized_event, name, revision, payload
                ),
            )
        return self._run(operation)


@register()
class gpo_editor_script_asset_delete(_GpoEditorCommand):
    __doc__ = _('Atomically delete an unreferenced Group Policy script asset.')

    takes_args = (
        Str('displayname', label=_('Policy name')),
        Str('scope', label=_('Script scope')),
        Str('event', label=_('Script event')),
    )
    takes_options = (
        Dict('request', label=_('Structured script asset deletion request')),
    )

    def execute(self, displayname, scope, event, request, **options):
        def operation():
            normalized_scope, normalized_event = _validated_script_context(
                scope, event
            )
            request_data = _script_request(
                request, ('name', 'revision'), ('name', 'revision')
            )
            name = _script_asset_name(request_data)
            revision = _script_identity(request_data, 'revision')
            return _run_scripts_mutation(
                self, displayname, normalized_scope, normalized_event,
                lambda workspace: workspace.delete_script_asset(
                    normalized_scope, normalized_event, name, revision
                ),
            )
        return self._run(operation)
