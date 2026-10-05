"""Focused unit and contract coverage for the FreeIPA libadmix editor host."""

import base64
import builtins
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import ldap
import pytest
from ipalib import errors
from ipalib.ipajson import json_decode_binary
from ipapython.dn import DN


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugin/ipaserver/plugins/gpo.py"
)
SPEC = importlib.util.spec_from_file_location("gpo_editor_under_test", MODULE_PATH)
GPO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPO)

GUID = "{E361BAA9-67B3-4828-84C1-6A74AADB9D06}"
DOMAIN = "example.test"
DN_VALUE = DN(
    ("cn", GUID),
    ("cn", "Policies"),
    ("cn", "System"),
    ("dc", "example"),
    ("dc", "test"),
)
UNC = f"\\\\{DOMAIN}\\SysVol\\{DOMAIN}\\Policies\\{GUID}"


class FakeEntry(dict):
    def __init__(self, dn=DN_VALUE, **attributes):
        super().__init__({key.lower(): value for key, value in attributes.items()})
        self.dn = dn

    def __contains__(self, key):
        return super().__contains__(str(key).lower())

    def __getitem__(self, key):
        return super().__getitem__(str(key).lower())


def entry(**overrides):
    attributes = {
        "cn": [GUID],
        "displayname": ["Test GPO"],
        "distinguishedname": [str(DN_VALUE)],
        "ipagpofilesyspath": [UNC],
        "ipagpoversionnumber": [0],
    }
    attributes.update(overrides)
    return FakeEntry(**attributes)


class FakeLdap:
    def __init__(self, ldap_entry=None, rights=True):
        self.ldap_entry = ldap_entry or entry()
        self.rights = rights
        self.calls = []

    def get_entry(self, dn, attrs_list=None, **kwargs):
        self.calls.append(("get_entry", dn, attrs_list))
        # verify_gpo_schema reads the container before resolving the GPO.
        if str(dn).startswith("cn=Policies,cn=System,"):
            return FakeEntry(dn=dn, cn=["Policies"])
        return self.ldap_entry

    def find_entry_by_attr(self, *args, **kwargs):
        self.calls.append(("find", args, kwargs))
        return self.ldap_entry

    def can_write(self, dn, attribute):
        self.calls.append(("can_write", dn, attribute))
        if isinstance(self.rights, dict):
            return self.rights.get(attribute, False)
        return self.rights


def fake_api():
    return SimpleNamespace(env=SimpleNamespace(
        container_grouppolicy=DN(("cn", "Policies"), ("cn", "System")),
        basedn=DN(("dc", "example"), ("dc", "test")),
        domain=DOMAIN,
    ))


@pytest.fixture(autouse=True)
def reset_editor_globals():
    GPO._reset_editor_globals_for_tests()
    yield
    GPO._reset_editor_globals_for_tests()


def make_gpo_tree(tmp_path, monkeypatch):
    monkeypatch.setattr(GPO, "GPO_SYSVOL_ROOT", tmp_path / "sysvol")
    root = GPO.GPO_SYSVOL_ROOT / DOMAIN / "Policies" / GUID
    root.mkdir(parents=True)
    return root


def resolve_context(tmp_path, monkeypatch, ldap_backend=None, write=False):
    root = make_gpo_tree(tmp_path, monkeypatch)
    backend = ldap_backend or FakeLdap()
    context = GPO._resolve_editor_context(
        backend, fake_api(), "Test GPO", write=write
    )
    assert context.gpo_root == root.resolve()
    return context, backend


def test_admix_binding_is_loaded_lazily_and_cached(monkeypatch):
    binding = SimpleNamespace(name="fake-admix")
    imports = []
    real_import = builtins.__import__

    def import_module(name, *args, **kwargs):
        if name == "admix":
            imports.append(name)
            return binding
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_module)

    assert GPO._load_admix() is binding
    assert GPO._load_admix() is binding
    assert imports == ["admix"]


def test_admix_binding_failure_is_structured_and_keeps_cache_empty(monkeypatch):
    real_import = builtins.__import__

    def import_module(name, *args, **kwargs):
        if name == "admix":
            raise ImportError("binding is not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_module)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._load_admix()

    assert failure.value.category == "operational"
    assert "binding is not available" in failure.value.message
    assert isinstance(failure.value.__cause__, ImportError)
    assert GPO._admix_module is None


def test_maintenance_refresh_is_throttled_and_retains_healthy_generation():
    class Catalog:
        constructions = 0

        def __init__(self, root, all_locales=False):
            Catalog.constructions += 1
            self.refreshes = 0

        def generation(self):
            return {
                "number": 7,
                "content_fingerprint": "healthy",
                "inventory_fingerprint": "healthy-files",
                "loaded_locales": ["en-US", "ru-RU"],
            }

        def diagnostics(self):
            return []

        def refresh_if_changed(self):
            self.refreshes += 1
            return {
                "status": "failed",
                "previous_generation": 7,
                "current_generation": 7,
                "parse_performed": True,
                "content_fingerprint": "healthy",
                "inventory_fingerprint": "broken-files",
                "diagnostics": [{"message": "bad /usr/share/PolicyDefinitions/x.admx"}],
                "failure": {
                    "code": "unusable_snapshot",
                    "message": "internal path",
                    "diagnostics": [],
                },
            }

    module = SimpleNamespace(TemplateCatalog=Catalog)
    first, first_state = GPO._get_catalog(module, now=10.0)
    GPO._refresh_catalog(module, now=12.0)
    second, _ = GPO._get_catalog(module, now=12.0)
    GPO._refresh_catalog(module, now=20.0)
    third, third_state = GPO._get_catalog(module, now=20.0)

    assert first is second is third
    assert Catalog.constructions == 1
    assert first.refreshes == 1
    assert first_state["generation"]["number"] == 7
    assert third_state["refresh"]["status"] == "failed"
    assert third_state["generation"]["content_fingerprint"] == "healthy"
    assert "/usr/share/PolicyDefinitions" not in str(third_state)


def test_context_resolves_canonical_identity_and_complete_absent_snapshot(
    tmp_path, monkeypatch
):
    context, backend = resolve_context(tmp_path, monkeypatch)

    assert context.guid == GUID
    assert context.file_sys_path == UNC
    assert context.snapshot == {
        "identity": {
            "guid": GUID,
            "distinguished_name": str(DN_VALUE),
            "file_sys_path": UNC,
        },
        "version_number": 0,
        "machine_extension_names": "",
        "user_extension_names": "",
    }
    assert context.presence == {
        "version_number": True,
        "machine_extension_names": False,
        "user_extension_names": False,
    }
    assert [call[2] for call in backend.calls if call[0] == "can_write"] == [
        "ipagpoversionnumber"
    ]


def test_write_context_requires_every_publication_attribute(
    tmp_path, monkeypatch
):
    rights = {
        "ipagpofilesyspath": True,
        "ipagpoversionnumber": True,
        "ipagpomachineextensionnames": True,
        "ipagpouserextensionnames": False,
    }
    backend = FakeLdap(rights=rights)
    make_gpo_tree(tmp_path, monkeypatch)

    with pytest.raises(errors.ACIError):
        GPO._resolve_editor_context(
            backend, fake_api(), "Test GPO", write=True
        )
    assert [call[2] for call in backend.calls if call[0] == "can_write"] == [
        "ipagpofilesyspath",
        "ipagpoversionnumber",
        "ipagpomachineextensionnames",
        "ipagpouserextensionnames",
    ]


def test_unauthorized_request_fails_before_filesystem_or_binding_reads(
    monkeypatch,
):
    backend = FakeLdap(rights=False)
    monkeypatch.setattr(
        GPO,
        "_trusted_gpo_root",
        lambda *args: pytest.fail("filesystem was inspected before authorization"),
    )
    monkeypatch.setattr(
        GPO,
        "_get_catalog",
        lambda *args: pytest.fail("catalog was read before authorization"),
    )

    with pytest.raises(errors.ACIError):
        GPO._resolve_editor_context(
            backend, fake_api(), "Test GPO", write=False
        )


@pytest.mark.parametrize("unsafe_path", [
    f"\\\\other.test\\SysVol\\{DOMAIN}\\Policies\\{GUID}",
    f"\\\\{DOMAIN}\\SysVol\\{DOMAIN}\\Policies\\{{BAD}}",
    f"\\\\{DOMAIN}\\SysVol\\{DOMAIN}\\Policies\\{GUID}\\Machine",
])
def test_context_rejects_unsafe_or_mismatched_unc_before_sysvol(
    monkeypatch, unsafe_path
):
    backend = FakeLdap(entry(ipagpofilesyspath=[unsafe_path]))
    monkeypatch.setattr(
        GPO,
        "_trusted_gpo_root",
        lambda *args: pytest.fail("unsafe path reached SYSVOL"),
    )
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._resolve_editor_context(
            backend, fake_api(), "Test GPO", write=False
        )
    assert failure.value.category == "validation"


def test_context_rejects_symlinked_gpo_root(tmp_path, monkeypatch):
    monkeypatch.setattr(GPO, "GPO_SYSVOL_ROOT", tmp_path / "sysvol")
    policies = GPO.GPO_SYSVOL_ROOT / DOMAIN / "Policies"
    target = tmp_path / "payload"
    policies.mkdir(parents=True)
    target.mkdir()
    (policies / GUID).symlink_to(target, target_is_directory=True)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._resolve_editor_context(
            FakeLdap(), fake_api(), "Test GPO", write=False
        )
    assert failure.value.category == "validation"


def test_separate_workspace_opens_never_reuse_mutable_high_level_api(
    tmp_path, monkeypatch
):
    context, _ = resolve_context(tmp_path, monkeypatch)

    class Catalog:
        def __init__(self, *args, **kwargs):
            pass

        def generation(self):
            return {
                "number": 1,
                "content_fingerprint": "x",
                "inventory_fingerprint": "y",
                "loaded_locales": ["en-US", "ru-RU"],
            }

        def diagnostics(self):
            return []

    class Api:
        instances = []

        def __init__(self, root, **kwargs):
            self.root = root
            self.kwargs = kwargs
            Api.instances.append(self)

    GPO._admix_module = SimpleNamespace(HighLevelApi=Api, TemplateCatalog=Catalog)
    first, first_runtime = GPO._open_workspace(context, ["ru", "en-US"])
    second, second_runtime = GPO._open_workspace(context, ["en-US"])

    assert first is not second
    assert len(Api.instances) == 2
    assert first.kwargs["state_key"] == second.kwargs["state_key"] == GUID
    assert first.kwargs["state_directory"] == str(
        GPO.GPO_EDITOR_STATE_DIRECTORY
    )
    assert first_runtime["locales"] == ["ru-RU", "en-US"]
    assert second_runtime["locales"] == ["en-US"]


def test_scope_specific_comments_and_preference_loading_are_explicit(
    tmp_path, monkeypatch
):
    context, _ = resolve_context(tmp_path, monkeypatch)

    class Catalog:
        def __init__(self, *args, **kwargs):
            pass

        def generation(self):
            return {
                "number": 1,
                "content_fingerprint": "x",
                "inventory_fingerprint": "y",
                "loaded_locales": ["en-US", "ru-RU"],
            }

        def diagnostics(self):
            return []

    class Api:
        opened = []

        def __init__(self, root, **kwargs):
            Api.opened.append(kwargs)

    GPO._admix_module = SimpleNamespace(HighLevelApi=Api, TemplateCatalog=Catalog)
    GPO._open_workspace(
        context,
        ["ru-RU", "en-US"],
        load_preferences=True,
        comment_scope="user",
    )

    options = Api.opened[0]
    assert options["load_preferences"] is True
    assert options["comments"] == {
        "cmtx_path": "User/comment.cmtx",
        "locale_paths": {
            "ru-RU": "User/ru-RU/comment.cmtl",
            "en-US": "User/en-US/comment.cmtl",
        },
    }


def snapshot(version=0, machine="", user="", identity=None):
    return {
        "identity": identity or {
            "guid": GUID,
            "distinguished_name": str(DN_VALUE),
            "file_sys_path": UNC,
        },
        "version_number": version,
        "machine_extension_names": machine,
        "user_extension_names": user,
    }


def plan(expected=0, target=1, machine="M", user=""):
    return {
        "identity": snapshot()["identity"],
        "expected_version": expected,
        "target_version": target,
        "affected_scopes": {"computer": True, "user": False},
        "machine_extension_names": machine,
        "user_extension_names": user,
        "idempotency_token": "token",
    }


def test_compare_replace_distinguishes_present_empty_and_absent():
    assert GPO._canonical_guid(GUID.lower()) == GUID
    backend = PublicationBackend()

    present_empty = GPO._compare_replace_modifications(
        backend,
        "ipaGpoMachineExtensionNames",
        "",
        None,
        True,
        absent_probe=GPO.GPC_ABSENT_EXTENSION_PROBE,
    )
    absent_empty = GPO._compare_replace_modifications(
        backend,
        "ipaGpoUserExtensionNames",
        "",
        None,
        False,
        absent_probe=GPO.GPC_ABSENT_EXTENSION_PROBE,
    )

    assert present_empty == [
        (ldap.MOD_DELETE, "ipaGpoMachineExtensionNames", [b""])
    ]
    probe = GPO.GPC_ABSENT_EXTENSION_PROBE.encode()
    assert absent_empty == [
        (ldap.MOD_ADD, "ipaGpoUserExtensionNames", [probe]),
        (ldap.MOD_DELETE, "ipaGpoUserExtensionNames", [probe]),
    ]


class PublicationBackend:
    def __init__(self):
        self.modifies = []
        self.removed = []
        self.conn = SimpleNamespace(modify_ext_s=self.modify_ext_s)

    def modify_ext_s(self, dn, modifications, serverctrls=None):
        self.modifies.append((dn, modifications, serverctrls))

    def encode(self, value):
        return str(value).encode()

    def remove_cache_entry(self, dn):
        self.removed.append(dn)


def editor_context(current=None):
    current = current or snapshot()
    return GPO.EditorContext(
        "Test GPO", GUID, DN_VALUE, UNC, Path("/trusted/gpo"), current,
        {
            "version_number": True,
            "machine_extension_names": bool(current["machine_extension_names"]),
            "user_extension_names": bool(current["user_extension_names"]),
        },
    )


def test_read_gpc_snapshot_reads_exact_attributes_and_presence():
    ldap_entry = entry(
        ipagpoversionnumber=[5],
        ipagpomachineextensionnames=[""],
        ipagpouserextensionnames=["[(USER)]"],
    )
    backend = FakeLdap(ldap_entry)
    context = editor_context()

    observed, presence = GPO._read_gpc_snapshot(backend, context)

    assert observed == snapshot(
        version=5,
        machine="",
        user="[(USER)]",
    )
    assert presence == {
        "version_number": True,
        "machine_extension_names": True,
        "user_extension_names": True,
    }
    assert backend.calls == [
        ("get_entry", DN_VALUE, list(GPO.GPC_SNAPSHOT_ATTRIBUTES))
    ]


def test_read_gpc_snapshot_rejects_changed_identity():
    changed_guid = "{11111111-2222-3333-4444-555555555555}"
    backend = FakeLdap(entry(cn=[changed_guid]))

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._read_gpc_snapshot(backend, editor_context())

    assert failure.value.category == "publication_conflict"
    assert failure.value.details == {"conflict_fields": ["identity"]}


@pytest.mark.parametrize(
    "invalid_path",
    [
        "not-a-UNC",
        f"\\\\other.test\\SysVol\\other.test\\Policies\\{GUID}",
    ],
)
def test_read_gpc_snapshot_rejects_invalid_or_changed_unc(invalid_path):
    backend = FakeLdap(entry(ipagpofilesyspath=[invalid_path]))

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._read_gpc_snapshot(backend, editor_context())

    assert failure.value.category == "validation"
    assert failure.value.field == "ipagpofilesyspath"


@pytest.mark.parametrize("invalid_version", ["not-an-int", -1, 0x100000000])
def test_read_gpc_snapshot_rejects_invalid_version(invalid_version):
    backend = FakeLdap(entry(ipagpoversionnumber=[invalid_version]))

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._read_gpc_snapshot(backend, editor_context())

    assert failure.value.category == "operational"
    assert "version is invalid" in failure.value.message


def test_publication_helper_uses_one_atomic_compare_modify_with_exact_values():
    backend = PublicationBackend()
    context = editor_context()
    exact_plan = plan(machine="[(EXACT-MACHINE)]", user="")

    GPO._apply_publication_plan(
        backend, context, exact_plan, context.snapshot, context.presence
    )

    assert len(backend.modifies) == 1
    dn, modifications, controls = backend.modifies[0]
    assert dn == str(DN_VALUE)
    assert controls is None
    probe = GPO.GPC_ABSENT_EXTENSION_PROBE.encode()
    assert modifications == [
        (ldap.MOD_DELETE, "ipaGpoFileSysPath", [UNC.encode()]),
        (ldap.MOD_ADD, "ipaGpoFileSysPath", [UNC.encode()]),
        (ldap.MOD_DELETE, "ipaGpoVersionNumber", [b"0"]),
        (ldap.MOD_ADD, "ipaGpoVersionNumber", [b"1"]),
        (
            ldap.MOD_ADD,
            "ipaGpoMachineExtensionNames",
            [b"[(EXACT-MACHINE)]"],
        ),
        (ldap.MOD_ADD, "ipaGpoUserExtensionNames", [probe]),
        (ldap.MOD_DELETE, "ipaGpoUserExtensionNames", [probe]),
    ]
    assert backend.removed == [DN_VALUE]


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("machine_extension_names", {"not": "text"}),
        ("user_extension_names", ["not", "text"]),
        ("idempotency_token", ""),
        ("idempotency_token", 7),
        ("expected_version", "0"),
        ("expected_version", False),
        ("expected_version", 0.9),
        ("target_version", "1"),
        ("target_version", True),
        ("target_version", -0.1),
        ("affected_scopes", {"computer": True}),
        (
            "affected_scopes",
            {"computer": True, "user": False, "other": False},
        ),
        ("affected_scopes", {"computer": 1, "user": False}),
        ("affected_scopes", {"computer": False, "user": False}),
    ],
)
def test_publication_helper_rejects_malformed_plan_before_ldap(
    field,
    invalid_value,
):
    backend = PublicationBackend()
    context = editor_context()
    malformed_plan = {**plan(), field: invalid_value}

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._apply_publication_plan(
            backend,
            context,
            malformed_plan,
            context.snapshot,
            context.presence,
        )

    assert failure.value.category == "operational"
    assert backend.modifies == []
    assert backend.removed == []


@pytest.mark.parametrize(
    ("expected", "affected_scopes", "target"),
    [
        ((4 << 16) | 7, {"computer": True, "user": False}, (4 << 16) | 8),
        ((4 << 16) | 7, {"computer": False, "user": True}, (5 << 16) | 7),
        ((4 << 16) | 7, {"computer": True, "user": True}, (5 << 16) | 8),
        ((4 << 16) | 0xffff, {"computer": True, "user": False}, 4 << 16),
        ((0xffff << 16) | 7, {"computer": False, "user": True}, 7),
    ],
)
def test_publication_plan_accepts_exact_packed_version_transition(
    expected,
    affected_scopes,
    target,
):
    before = snapshot(version=expected, machine="OLD-M", user="OLD-U")
    publication_plan = {
        **plan(
            expected=expected,
            target=target,
            machine=("NEW-M" if affected_scopes["computer"] else "OLD-M"),
            user=("NEW-U" if affected_scopes["user"] else "OLD-U"),
        ),
        "affected_scopes": affected_scopes,
    }

    GPO._validate_publication_plan(publication_plan, before)


@pytest.mark.parametrize(
    ("affected_scopes", "target", "machine", "user"),
    [
        ({"computer": False, "user": True}, 1 << 16, "NEW-M", "OLD-U"),
        ({"computer": True, "user": False}, 1, "OLD-M", "NEW-U"),
    ],
)
def test_publication_plan_rejects_extension_change_for_unaffected_scope(
    affected_scopes,
    target,
    machine,
    user,
):
    before = snapshot(machine="OLD-M", user="OLD-U")
    publication_plan = {
        **plan(target=target, machine=machine, user=user),
        "affected_scopes": affected_scopes,
    }

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validate_publication_plan(publication_plan, before)

    assert failure.value.category == "operational"
    assert "unaffected scope" in failure.value.message


@pytest.mark.parametrize(
    ("affected_scopes", "target"),
    [
        ({"computer": True, "user": False}, 0),
        ({"computer": True, "user": False}, 2),
        ({"computer": True, "user": False}, 1 << 16),
        ({"computer": False, "user": True}, 1),
        ({"computer": False, "user": True}, 2 << 16),
        ({"computer": True, "user": True}, 1),
    ],
)
def test_publication_helper_rejects_wrong_packed_version_transition_before_ldap(
    affected_scopes,
    target,
):
    backend = PublicationBackend()
    context = editor_context()
    before = snapshot(machine="OLD-M", user="OLD-U")
    invalid_plan = {
        **plan(
            target=target,
            machine=("NEW-M" if affected_scopes["computer"] else "OLD-M"),
            user=("NEW-U" if affected_scopes["user"] else "OLD-U"),
        ),
        "affected_scopes": affected_scopes,
    }

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._apply_publication_plan(
            backend,
            context,
            invalid_plan,
            before,
            context.presence,
        )

    assert failure.value.category == "operational"
    assert "transition" in failure.value.message
    assert backend.modifies == []
    assert backend.removed == []


def test_atomic_compare_failure_is_a_structured_publication_conflict(monkeypatch):
    class FailingBackend(PublicationBackend):
        def modify_ext_s(self, dn, modifications, serverctrls=None):
            raise ldap.NO_SUCH_ATTRIBUTE({"desc": "No Such Attribute"})

    backend = FailingBackend()
    context = editor_context()
    observed = snapshot(version=9, machine="other")
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (observed, {})
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._apply_publication_plan(
            backend, context, plan(), context.snapshot, context.presence
        )
    assert failure.value.category == "publication_conflict"
    assert set(failure.value.details["conflict_fields"]) == {
        "version", "machine_extension_names"
    }
    assert "file_sys_path" not in str(failure.value.details)


def test_non_comparison_ldap_failure_uses_freeipa_error_handler():
    events = []

    class ErrorHandler:
        def __enter__(self):
            events.append("enter")

        def __exit__(self, exc_type, exc, traceback):
            events.append(("exit", exc_type, exc))
            return False

    class FailingBackend(PublicationBackend):
        def modify_ext_s(self, dn, modifications, serverctrls=None):
            raise ldap.SERVER_DOWN({"desc": "Can't contact LDAP server"})

        def error_handler(self):
            return ErrorHandler()

    backend = FailingBackend()
    context = editor_context()

    with pytest.raises(ldap.SERVER_DOWN) as failure:
        GPO._apply_publication_plan(
            backend, context, plan(), context.snapshot, context.presence
        )

    assert events == [
        "enter",
        ("exit", ldap.SERVER_DOWN, failure.value),
    ]
    assert backend.removed == [DN_VALUE]


class CommitWorkspace:
    def __init__(self, commit_result, pending=None):
        self.commit_result = commit_result
        self.pending = pending
        self.commits = []
        self.acks = []

    def commit_external(self, current):
        self.commits.append(current)
        return self.commit_result

    def pending_external_publication(self):
        return self.pending

    def acknowledge_external(self, token, resulting):
        self.acks.append((token, resulting))
        self.pending = None


def test_no_dirty_commit_calls_binding_once_and_never_modifies_ldap(monkeypatch):
    current = snapshot()
    stale_context = editor_context(snapshot(version=99))
    workspace = CommitWorkspace({
        "directory": "no_publication_required",
        "files": {
            "paths": [],
            "affected_scopes": {"computer": False, "user": False},
        },
        "publication_plan": None,
    })
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (current, {})
    )
    applied = []
    monkeypatch.setattr(
        GPO, "_apply_publication_plan", lambda *args: applied.append(args)
    )

    result = GPO._commit_external_once(
        workspace, object(), stale_context
    )

    assert len(workspace.commits) == 1
    assert applied == []
    assert workspace.acks == []
    assert result["changed"] is False
    assert stale_context.snapshot == current
    assert result["pending_publication"] is None


def test_legacy_empty_external_handoff_is_rejected_without_ldap_modify(
    monkeypatch,
):
    current = snapshot()
    workspace = CommitWorkspace({
        "directory": "external_handoff",
        "files": {
            "paths": [],
            "affected_scopes": {"computer": False, "user": False},
        },
        "publication_plan": plan(),
    })
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (current, {})
    )
    monkeypatch.setattr(
        GPO,
        "_apply_publication_plan",
        lambda *args: pytest.fail("legacy handoff modified LDAP"),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._commit_external_once(
            workspace, object(), editor_context(current)
        )

    assert failure.value.category == "operational"
    assert workspace.acks == []


def test_dirty_commit_applies_one_plan_rereads_and_acknowledges(monkeypatch):
    before = snapshot()
    after = snapshot(version=1, machine="M", user="U")
    exact_plan = plan()
    workspace = CommitWorkspace({
        "directory": "external_handoff",
        "files": {
            "paths": [{"path": "Machine/Registry.pol", "revision": "r"}],
            "affected_scopes": {"computer": True, "user": False},
        },
        "publication_plan": exact_plan,
    }, pending={
        "phase": "awaiting_directory_publication",
        "plan": exact_plan,
        "precondition": before,
    })
    reads = iter(((before, {}), (after, {})))
    monkeypatch.setattr(GPO, "_read_gpc_snapshot", lambda *args: next(reads))
    applied = []
    monkeypatch.setattr(
        GPO, "_apply_publication_plan", lambda *args: applied.append(args)
    )

    result = GPO._commit_external_once(
        workspace, object(), editor_context(before)
    )

    assert len(workspace.commits) == 1
    assert len(applied) == 1
    assert workspace.acks == [("token", after)]
    assert result["changed"] is True
    assert result["snapshot"]["version_number"] == 1


def test_dirty_commit_acknowledgement_conflict_keeps_pending_state(monkeypatch):
    before = snapshot()
    after = snapshot(version=1, machine="M")
    exact_plan = plan()

    class ConflictingWorkspace(CommitWorkspace):
        def acknowledge_external(self, token, resulting):
            self.acks.append((token, resulting))
            error = RuntimeError("stale acknowledgement")
            error.code = "conflict"
            raise error

    pending = {
        "phase": "awaiting_directory_publication",
        "plan": exact_plan,
        "precondition": before,
    }
    workspace = ConflictingWorkspace({
        "directory": "external_handoff",
        "files": {
            "paths": [{"path": "Machine/Registry.pol", "revision": "r"}],
            "affected_scopes": {"computer": True, "user": False},
        },
        "publication_plan": exact_plan,
    }, pending=pending)
    reads = iter(((before, {}), (after, {})))
    monkeypatch.setattr(GPO, "_read_gpc_snapshot", lambda *args: next(reads))
    applied = []
    monkeypatch.setattr(
        GPO, "_apply_publication_plan", lambda *args: applied.append(args)
    )
    context = editor_context(before)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._commit_external_once(workspace, object(), context)

    assert failure.value.category == "publication_conflict"
    assert failure.value.details == {
        "safe_next_actions": ["reconcile", "operator_intervention"]
    }
    assert len(applied) == 1
    assert workspace.acks == [("token", after)]
    assert workspace.pending is pending
    assert context.snapshot == before


@pytest.mark.parametrize(
    "pending_factory",
    [
        lambda before, exact_plan: None,
        lambda before, exact_plan: {
            "phase": "payload_committed",
            "plan": exact_plan,
            "precondition": before,
        },
        lambda before, exact_plan: {
            "phase": "awaiting_directory_publication",
            "plan": {**exact_plan, "target_version": 2},
            "precondition": before,
        },
        lambda before, exact_plan: {
            "phase": "awaiting_directory_publication",
            "plan": exact_plan,
            "precondition": snapshot(version=99),
        },
    ],
)
def test_dirty_commit_rejects_inconsistent_recovery_state_before_ldap(
    monkeypatch,
    pending_factory,
):
    before = snapshot()
    exact_plan = plan()
    workspace = CommitWorkspace({
        "directory": "external_handoff",
        "files": {
            "paths": [{"path": "Machine/Registry.pol", "revision": "r"}],
            "affected_scopes": {"computer": True, "user": False},
        },
        "publication_plan": exact_plan,
    }, pending=pending_factory(before, exact_plan))
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (before, {})
    )
    applied = []
    monkeypatch.setattr(
        GPO,
        "_apply_publication_plan",
        lambda *args: applied.append(args),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._commit_external_once(
            workspace,
            object(),
            editor_context(before),
        )

    assert failure.value.category == "operational"
    assert "inconsistent external handoff" in failure.value.message
    assert applied == []
    assert workspace.acks == []


def test_dirty_commit_rejects_mismatched_file_and_directory_scopes(
    monkeypatch,
):
    before = snapshot()
    exact_plan = plan()
    workspace = CommitWorkspace({
        "directory": "external_handoff",
        "files": {
            "paths": [{"path": "User/Registry.pol", "revision": "r"}],
            "affected_scopes": {"computer": False, "user": True},
        },
        "publication_plan": exact_plan,
    }, pending={
        "phase": "awaiting_directory_publication",
        "plan": exact_plan,
        "precondition": before,
    })
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (before, {})
    )
    applied = []
    monkeypatch.setattr(
        GPO,
        "_apply_publication_plan",
        lambda *args: applied.append(args),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._commit_external_once(
            workspace,
            object(),
            editor_context(before),
        )

    assert failure.value.category == "operational"
    assert applied == []
    assert workspace.acks == []


class RecoveryWorkspace:
    def __init__(self, pending, action, resumed_pending=None):
        self.pending = pending
        self.action = action
        self.resumed_pending = resumed_pending
        self.reconciles = []
        self.resumes = []
        self.acks = []
        self.events = []

    def pending_external_publication(self):
        return self.pending

    def reconcile_external(self, current):
        self.events.append("reconcile")
        self.reconciles.append(current)
        return self.action

    def resume_external_file_publication(self):
        self.events.append("resume")
        self.resumes.append(self.pending)
        if self.resumed_pending is None:
            pytest.fail("directory-ready recovery unexpectedly resumed files")
        self.pending = self.resumed_pending
        return {"publication_plan": self.pending["plan"]}

    def acknowledge_external(self, token, current):
        self.events.append("acknowledge")
        self.acks.append((token, current))
        self.pending = None


@pytest.mark.parametrize("phase", ["payload_prepared", "payload_committed"])
def test_recovery_resumes_incomplete_files_before_ldap_read_and_reconcile(
    monkeypatch, phase
):
    before = snapshot()
    after = snapshot(version=1, machine="M", user="U")
    exact_plan = plan()
    early_pending = {
        "phase": phase,
        "plan": exact_plan,
        "precondition": before,
        "staged_paths": ["Machine/Registry.pol", "GPT.INI"],
    }
    ready_pending = {
        **early_pending,
        "phase": "awaiting_directory_publication",
    }
    workspace = RecoveryWorkspace(
        early_pending,
        {"kind": "apply", "plan": exact_plan, "conflict": None},
        resumed_pending=ready_pending,
    )
    reads = iter(((before, {}), (after, {})))

    def read_snapshot(*args):
        workspace.events.append("read")
        return next(reads)

    def apply_plan(*args):
        workspace.events.append("apply")

    monkeypatch.setattr(GPO, "_read_gpc_snapshot", read_snapshot)
    monkeypatch.setattr(GPO, "_apply_publication_plan", apply_plan)

    action, resulting = GPO._reconcile_workspace(
        workspace, object(), editor_context(before)
    )

    assert action["kind"] == "apply"
    assert resulting == after
    assert workspace.resumes == [early_pending]
    assert workspace.events == [
        "resume",
        "read",
        "reconcile",
        "apply",
        "read",
        "acknowledge",
    ]
    assert workspace.acks == [("token", after)]


def test_recovery_apply_uses_original_precondition_then_acknowledges(monkeypatch):
    before = snapshot()
    after = snapshot(version=1, machine="M", user="U")
    exact_plan = plan()
    pending = {
        "phase": "awaiting_directory_publication",
        "plan": exact_plan,
        "precondition": before,
    }
    workspace = RecoveryWorkspace(
        pending, {"kind": "apply", "plan": exact_plan, "conflict": None}
    )
    exact_presence = {
        "version_number": True,
        "machine_extension_names": False,
        "user_extension_names": False,
    }
    reads = iter(((before, exact_presence), (after, {})))
    monkeypatch.setattr(GPO, "_read_gpc_snapshot", lambda *args: next(reads))
    applied = []
    monkeypatch.setattr(
        GPO, "_apply_publication_plan", lambda *args: applied.append(args)
    )

    action, resulting = GPO._reconcile_workspace(
        workspace, object(), editor_context(before)
    )

    assert action["kind"] == "apply"
    assert resulting == after
    assert applied[0][3] == before
    assert applied[0][4] == exact_presence
    assert workspace.acks == [("token", after)]


def test_recovery_acknowledge_is_idempotent_and_does_not_apply(monkeypatch):
    after = snapshot(version=1, machine="M", user="U")
    exact_plan = plan()
    workspace = RecoveryWorkspace(
        {"phase": "awaiting_directory_publication", "plan": exact_plan},
        {"kind": "acknowledge", "plan": exact_plan, "conflict": None},
    )
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (after, {})
    )
    monkeypatch.setattr(
        GPO,
        "_apply_publication_plan",
        lambda *args: pytest.fail("acknowledge recovery reapplied LDAP"),
    )

    action, _ = GPO._reconcile_workspace(
        workspace, object(), editor_context(after)
    )

    assert action["kind"] == "acknowledge"
    assert workspace.acks == [("token", after)]


@pytest.mark.parametrize("kind", ["apply", "acknowledge"])
def test_recovery_rejects_action_for_different_publication_plan(
    monkeypatch,
    kind,
):
    before = snapshot()
    original_plan = plan()
    replacement_plan = {**original_plan, "target_version": 2}
    pending = {
        "phase": "awaiting_directory_publication",
        "plan": original_plan,
        "precondition": before,
    }
    workspace = RecoveryWorkspace(
        pending,
        {"kind": kind, "plan": replacement_plan, "conflict": None},
    )
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (before, {})
    )
    applied = []
    monkeypatch.setattr(
        GPO,
        "_apply_publication_plan",
        lambda *args: applied.append(args),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._reconcile_workspace(
            workspace,
            object(),
            editor_context(before),
        )

    assert failure.value.category == "recovery_operator_action"
    assert "original plan" in failure.value.message
    assert applied == []
    assert workspace.acks == []


def test_recovery_rejects_malformed_pending_state_before_ldap(monkeypatch):
    workspace = RecoveryWorkspace(
        ["not", "a", "mapping"],
        {"kind": "apply", "plan": plan(), "conflict": None},
    )
    reads = []
    monkeypatch.setattr(
        GPO,
        "_read_gpc_snapshot",
        lambda *args: reads.append(args),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._reconcile_workspace(
            workspace,
            object(),
            editor_context(),
        )

    assert failure.value.category == "recovery_operator_action"
    assert reads == []


def test_recovery_third_state_is_retained_and_rejects_new_mutation(monkeypatch):
    observed = snapshot(version=8)
    conflict = {
        "code": "directory_third_state",
        "phase": "awaiting_directory_publication",
        "conflict_fields": ["version"],
        "expected": snapshot(),
        "observed": observed,
        "safe_next_actions": ["refresh", "operator_intervention"],
    }
    pending = {"phase": "awaiting_directory_publication", "plan": plan()}
    workspace = RecoveryWorkspace(
        pending, {"kind": "conflict", "plan": None, "conflict": conflict}
    )
    monkeypatch.setattr(
        GPO, "_read_gpc_snapshot", lambda *args: (observed, {})
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._recover_before_mutation(
            workspace, object(), editor_context(observed)
        )
    assert failure.value.category == "publication_conflict"
    assert workspace.pending is pending
    assert workspace.acks == []


def test_public_envelopes_redact_sysvol_state_and_preference_paths():
    public = GPO._public_snapshot(snapshot())
    documents = GPO._public_documents([{
        "scope": "computer",
        "kind": "files",
        "path": "Machine/Preferences/Files/Files.xml",
        "editable": True,
    }])
    pending = GPO._public_pending({
        "phase": "awaiting_directory_publication",
        "plan": plan(),
        "payload_paths": ["/var/lib/freeipa/sysvol/secret"],
    })

    serialized = str((public, documents, pending))
    assert "file_sys_path" not in serialized
    assert "Machine/Preferences" not in serialized
    assert "idempotency_token" not in serialized
    assert "/var/lib/freeipa" not in serialized

    diagnostics = GPO._sanitize_diagnostics([
        {"message": "failed Machine/Registry.pol and User/comment.cmtx"},
        {"message": "could not parse GPT.INI"},
    ])
    serialized = str(diagnostics)
    assert "Machine/Registry.pol" not in serialized
    assert "User/comment.cmtx" not in serialized
    assert "GPT.INI" not in serialized
    assert "<gpo-path>" in serialized


def test_error_translation_uses_stable_category_without_internal_path():
    error = RuntimeError("/var/lib/freeipa/sysvol/secret")
    error.code = "io"
    error.path = "/var/lib/freeipa/sysvol/secret"
    error.field = None

    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(error)
    assert translated.value.kw["error_category"] == "operational"
    assert "path" not in translated.value.kw
    assert "/var/lib/freeipa" not in str(translated.value)

    relative = RuntimeError("storage conflict")
    relative.code = "conflict"
    relative.path = "Machine\\Registry.pol"
    relative.field = None
    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(relative)
    assert "path" not in translated.value.kw

    gpt = RuntimeError("storage conflict")
    gpt.code = "conflict"
    gpt.path = "GPT.INI"
    gpt.field = None
    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(gpt)
    assert "path" not in translated.value.kw


@pytest.mark.parametrize(("code", "category"), [
    ("validation", "validation"),
    ("not_found", "not_found"),
    ("not_loaded", "unsupported"),
    ("conflict", "storage_conflict"),
    ("asset_revision_conflict", "asset_revision_conflict"),
    ("publication_pending", "publication_pending"),
    ("internal", "operational"),
])
def test_binding_error_codes_translate_to_stable_web_categories(code, category):
    binding_error = RuntimeError("binding detail must not be forwarded")
    binding_error.code = code
    binding_error.field = "field-id"
    binding_error.path = None

    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(binding_error)

    assert translated.value.kw["error_category"] == category
    assert translated.value.kw["field"] == "field-id"
    assert "binding detail" not in str(translated.value)


@pytest.mark.parametrize(("code", "raw_details", "expected"), [
    (
        "asset_collision",
        {
            "existing": {
                "name": "startup.cmd",
                "byte_size": 4,
                "revision": "r1",
                "references": [],
            },
            "suggested_name": "startup (1).cmd",
        },
        {
            "existing": {
                "name": "startup.cmd",
                "byte_size": 4,
                "revision": "r1",
                "references": [],
            },
            "suggested_name": "startup (1).cmd",
        },
    ),
    (
        "asset_revision_conflict",
        {
            "name": "startup.cmd",
            "expected_revision": "old",
            "actual_revision": "new",
        },
        {
            "name": "startup.cmd",
            "expected_revision": "old",
            "actual_revision": "new",
        },
    ),
    (
        "asset_still_referenced",
        {
            "name": "startup.cmd",
            "references": [{
                "event": "startup",
                "executable_group": "classic",
                "index": 0,
            }],
        },
        {
            "name": "startup.cmd",
            "references": [{
                "event": "startup",
                "executable_group": "classic",
                "index": 0,
            }],
        },
    ),
])
def test_script_binding_error_details_are_allowlisted(code, raw_details, expected):
    binding_error = RuntimeError("internal binding text /var/lib/freeipa")
    binding_error.code = code
    binding_error.field = "name"
    binding_error.path = "Machine/Scripts/Startup/startup.cmd"
    binding_error.script_details = raw_details

    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(binding_error)

    assert translated.value.kw["error_category"] == code
    assert json.loads(translated.value.kw["details"]) == expected
    assert "path" not in translated.value.kw
    assert "/var/lib/freeipa" not in str(translated.value)


def test_invalid_script_binding_error_details_are_dropped():
    binding_error = RuntimeError("internal binding text")
    binding_error.code = "asset_collision"
    binding_error.field = "name"
    binding_error.path = None
    binding_error.script_details = {
        "existing": {"name": "/etc/shadow"},
        "suggested_name": "/etc/shadow",
    }

    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(binding_error)

    assert "details" not in translated.value.kw


class CommandHarness:
    def __init__(self, context, ldap_backend=None):
        self.context = context
        self.api = SimpleNamespace(
            Backend=SimpleNamespace(ldap2=ldap_backend or object())
        )

    def _context(self, displayname, write=False):
        return self.context

    def _run(self, callback):
        return callback()


class PolicyWorkspace:
    def __init__(self, fail_update=False):
        self.fail_update = fail_update
        self.updates = []
        self.comments = []
        self.cleared_comments = []
        self.policy_reads = []

    def pending_external_publication(self):
        return None

    def diagnostics(self):
        return []

    def update_policy(self, scope, policy_id, **request):
        self.updates.append((scope, policy_id, request))
        if self.fail_update:
            raise GPO.EditorFailure("validation", "invalid field")
        return {"policy_id": policy_id, "dirty": True}

    def get_policy(self, scope, policy_id, locales):
        self.policy_reads.append((scope, policy_id, locales))
        return {"policy_id": policy_id, "dirty": False, "parameters": []}

    def set_policy_comment(self, scope, policy_id, target, text, locales):
        self.comments.append((scope, policy_id, target, text, locales))
        return {"policy_id": policy_id, "dirty": True}

    def clear_policy_comment(self, scope, policy_id, target, locales):
        self.cleared_comments.append((scope, policy_id, target, locales))
        return {"policy_id": policy_id, "dirty": True}


class PolicyReadWorkspace(PolicyWorkspace):
    def __init__(self):
        super().__init__()
        self.categories = []
        self.policy = {
            "scope": "computer",
            "policy_id": "opaque:policy/id",
            "label": "Stored policy",
            "state": "unknown_raw_values",
            "representability": {"enabled": False},
            "capabilities": {"edit_parameters": False},
            "parameters": [{
                "id": "opaque-parameter",
                "kind": "enum",
                "value": {
                    "kind": "unsupported",
                    "value": {"kind": "preserved_unknown", "reg_type": 99},
                },
                "choices": [],
            }],
            "unknown_raw_values": True,
        }

    def list_policies(self, scope, category_id, locales):
        self.categories.append((scope, category_id, locales))
        return [{"kind": "policy", "id": "opaque:policy/id", "label": "P"}]

    def get_policy(self, scope, policy_id, locales):
        return self.policy


class PolicyIndexWorkspace(PolicyWorkspace):
    def __init__(self, catalog):
        super().__init__()
        self.catalog = catalog
        self.categories = []

    def list_policies(self, scope, category_id, locales):
        self.categories.append((scope, category_id, locales))
        return self.catalog[(scope, category_id)]


def runtime():
    return {
        "binding": {"api_version": 1, "capabilities": []},
        "catalog": None,
        "locales": ["en-US"],
    }


def script_runtime():
    return {
        "binding": {"api_version": 3, "capabilities": ["group-policy-scripts"]},
        "catalog": None,
        "locales": [],
    }


class ScriptWorkspace:
    def __init__(self, shared_reference=False):
        references = [{
            "event": "startup", "executable_group": "classic", "index": 0,
        }]
        if shared_reference:
            references.append({
                "event": "startup", "executable_group": "powershell", "index": 0,
            })
        self.groups = {
            "classic": {
                "snapshot": "classic-snapshot",
                "editable": True,
                "entries": [{
                    "event": "startup", "identity": "classic-startup-0",
                    "command_line": "startup.cmd", "parameters": "/quiet",
                    "managed_asset_name": "startup.cmd",
                }, {
                    "event": "shutdown", "identity": "classic-shutdown-0",
                    "command_line": "shutdown.cmd", "parameters": "",
                    "managed_asset_name": None,
                }],
                "execution_order": {},
                "diagnostics": [{
                    "code": "invalid_line",
                    "message": "Machine/Scripts/scripts.ini /var/lib/freeipa/sysvol/x",
                }],
            },
            "powershell": {
                "snapshot": "powershell-snapshot",
                "editable": True,
                "entries": ([{
                    "event": "startup", "identity": "powershell-startup-0",
                    "command_line": "startup.cmd", "parameters": "",
                    "managed_asset_name": "startup.cmd",
                }] if shared_reference else [{
                    "event": "startup", "identity": "powershell-startup-0",
                    "command_line": r"\\server\share\external.ps1", "parameters": "",
                    "managed_asset_name": None,
                }]),
                "execution_order": {
                    "start_execute_ps_first": None,
                    "end_execute_ps_first": False,
                },
                "diagnostics": [],
            },
        }
        self.assets = [{
            "name": "startup.cmd", "byte_size": 3, "revision": "asset-r1",
            "references": references,
        }]
        self.operations = []
        self.pending = None

    def _copy(self, value):
        return json.loads(json.dumps(value))

    def pending_external_publication(self):
        return self.pending

    def diagnostics(self):
        return []

    def show_script_group(self, scope, group):
        self.operations.append(("show", scope, group))
        return self._copy(self.groups[group])

    def list_script_assets(self, scope, event):
        self.operations.append(("assets", scope, event))
        return self._copy(self.assets)

    def read_script_asset(self, scope, event, name, revision):
        self.operations.append(("download", scope, event, name, revision))
        asset = next((item for item in self.assets if item["name"] == name), None)
        if asset is None:
            error = RuntimeError("missing asset")
            error.code = "not_found"
            raise error
        if asset["revision"] != revision:
            error = RuntimeError("stale asset")
            error.code = "asset_revision_conflict"
            raise error
        return {
            "name": name, "byte_size": 3, "revision": revision,
            "content": b"ABC",
        }

    def script_asset_collision(self, scope, event, name):
        for asset in self.assets:
            if asset["name"].casefold() == name.casefold():
                return {
                    "existing": self._copy(asset),
                    "suggested_name": "startup-1.cmd",
                }
        return None

    def add_script_entry(self, scope, group, event, snapshot, command, parameters):
        self.operations.append(("add", scope, group, event, snapshot, command, parameters))
        if snapshot != self.groups[group]["snapshot"]:
            error = RuntimeError("stale")
            error.code = "conflict"
            raise error
        self.groups[group]["entries"].append({
            "event": event, "identity": group + "-new",
            "command_line": command, "parameters": parameters,
            "managed_asset_name": command if any(
                asset["name"].casefold() == command.casefold()
                for asset in self.assets
            ) else None,
        })

    def update_script_entry(self, scope, group, event, identity, command, parameters):
        self.operations.append(("update", identity, command, parameters))
        for entry in self.groups[group]["entries"]:
            if entry["event"] == event and entry["identity"] == identity:
                entry["command_line"] = command
                entry["parameters"] = parameters
                return
        raise RuntimeError("missing")

    def remove_script_entry(self, scope, group, event, identity):
        self.operations.append(("remove", identity))
        entries = self.groups[group]["entries"]
        self.groups[group]["entries"] = [
            entry for entry in entries if not (
                entry["event"] == event and entry["identity"] == identity
            )
        ]
        for asset in self.assets:
            asset["references"] = [
                reference for reference in asset["references"]
                if not (reference["event"] == event
                        and reference["executable_group"] == group)
            ]

    def reorder_script_entries(self, scope, group, event, snapshot, identities):
        self.operations.append(("reorder", group, snapshot, identities))
        if snapshot != self.groups[group]["snapshot"]:
            error = RuntimeError("stale")
            error.code = "conflict"
            raise error

    def set_script_execution_order(self, scope, snapshot, start, end):
        self.operations.append(("order", snapshot, start, end))
        if snapshot != self.groups["powershell"]["snapshot"]:
            error = RuntimeError("stale")
            error.code = "conflict"
            raise error
        self.groups["powershell"]["execution_order"] = {
            "start_execute_ps_first": start,
            "end_execute_ps_first": end,
        }

    def upload_script_asset(self, scope, event, name, payload):
        self.operations.append(("upload", name, payload))
        self.assets.append({
            "name": name, "byte_size": len(payload), "revision": "new-r1",
            "references": [],
        })

    def upload_and_add_script_entry(self, scope, group, event, snapshot, name, payload, parameters):
        self.operations.append(("upload_and_add", name, payload))
        self.upload_script_asset(scope, event, name, payload)
        self.add_script_entry(scope, group, event, snapshot, name, parameters)

    def replace_script_asset(self, scope, event, name, revision, payload):
        self.operations.append(("replace", name, revision, payload))

    def delete_script_asset(self, scope, event, name, revision):
        self.operations.append(("delete", name, revision))
        asset = next(asset for asset in self.assets if asset["name"] == name)
        if asset["references"]:
            error = RuntimeError("still referenced")
            error.code = "asset_still_referenced"
            raise error
        self.assets.remove(asset)


def test_editor_command_success_envelope_uses_eager_string_summary():
    envelope = GPO._GpoEditorCommand._run(None, lambda: {"ok": True})

    assert isinstance(envelope["summary"], str)
    assert envelope["result"] == {"ok": True}


def test_editor_command_run_translates_callback_failure(monkeypatch):
    original = RuntimeError("binding internals")
    translated = errors.ExecutionError(message="translated")
    translator_calls = []

    def translate(exc):
        translator_calls.append(exc)
        raise translated

    monkeypatch.setattr(GPO, "_translate_editor_exception", translate)

    with pytest.raises(errors.ExecutionError) as failure:
        GPO._GpoEditorCommand._run(
            None,
            lambda: (_ for _ in ()).throw(original),
        )

    assert failure.value is translated
    assert translator_calls == [original]


def test_editor_command_context_uses_command_api_backend(monkeypatch):
    ldap_backend = object()
    plugin_api = SimpleNamespace(Backend=SimpleNamespace(ldap2=ldap_backend))
    subject = SimpleNamespace(api=plugin_api)
    expected = object()
    calls = []

    def resolve(ldap, api_instance, displayname, write=False):
        calls.append((ldap, api_instance, displayname, write))
        return expected

    monkeypatch.setattr(GPO, "_resolve_editor_context", resolve)

    result = GPO._GpoEditorCommand._context(
        subject,
        "Policy-One",
        write=True,
    )

    assert result is expected
    assert calls == [(ldap_backend, plugin_api, "Policy-One", True)]


def test_editor_open_returns_documents_from_one_preference_workspace(
    monkeypatch,
):
    workspace = PreferenceWorkspace()
    workspace.list_preference_documents = lambda: [{
        "scope": "computer",
        "kind": "files",
        "label": "Files",
        "path": "Machine/Preferences/Files/Files.xml",
        "editable": True,
        "item_count": 1,
    }]
    context = editor_context()
    opened = []

    def open_workspace(*args, **kwargs):
        opened.append((args, kwargs))
        return workspace, runtime()

    monkeypatch.setattr(GPO, "_open_workspace", open_workspace)

    result = GPO.gpo_editor_open.execute(
        CommandHarness(context),
        "Test GPO",
        locales=["ru-RU"],
    )

    assert opened == [
        ((context, ["ru-RU"]), {"load_preferences": True})
    ]
    assert result["preference_documents"] == [{
        "scope": "computer",
        "kind": "files",
        "label": "Files",
        "editable": True,
        "item_count": 1,
    }]


@pytest.mark.parametrize(("command", "args"), [
    (GPO.gpo_editor_preference_documents, ("Test GPO",)),
    (GPO.gpo_editor_preference_items, ("Test GPO", "computer", "files")),
    (GPO.gpo_editor_preference_show, ("Test GPO", "computer", "files", {})),
    (GPO.gpo_editor_preference_create, ("Test GPO", "computer", "files", {"fields": []})),
    (GPO.gpo_editor_preference_update, ("Test GPO", "computer", "files", {"identity": ["opaque"]})),
    (GPO.gpo_editor_preference_delete, ("Test GPO", "computer", "files", {"identity": ["opaque"]})),
])
def test_preference_requests_do_not_initialize_unrelated_template_catalog(
    monkeypatch, command, args,
):
    context = editor_context()
    opened = []

    class OpenedWorkspace(Exception):
        pass

    def open_workspace(*positional, **kwargs):
        opened.append((positional, kwargs))
        raise OpenedWorkspace()

    monkeypatch.setattr(GPO, "_open_workspace", open_workspace)
    with pytest.raises(OpenedWorkspace):
        command.execute(CommandHarness(context), *args)

    assert opened == [((context,), {"load_preferences": True, "with_catalog": False})]


@pytest.mark.parametrize(("requested_scope", "scope"), [
    ("computer", "computer"),
    ("user", "user"),
    ("machine", "computer"),
])
def test_policy_index_traverses_one_workspace_with_opaque_ids_and_display_paths(
    monkeypatch, requested_scope, scope,
):
    catalog = {
        (scope, None): [
            {"kind": "policy", "id": "opaque:root/orphan", "label": "Root"},
            {"kind": "category", "id": "opaque:category/A", "label": "Система"},
            {"kind": "policy", "id": "opaque:root/orphan", "label": "Duplicate"},
            {"kind": "category", "id": "opaque:category/B", "label": "Другие"},
        ],
        (scope, "opaque:category/A"): [
            {"kind": "policy", "id": "unconfigured:id", "label": "Не задана"},
            {"kind": "category", "id": "opaque:deep/category", "label": "Вложено"},
            {"kind": "category", "id": "opaque:category/A", "label": "Cycle"},
            {"kind": "policy", "id": "opaque:deep/policy", "label": "Duplicate"},
        ],
        (scope, "opaque:deep/category"): [
            {"kind": "policy", "id": "opaque:deep/policy", "label": ""},
        ],
        (scope, "opaque:category/B"): [
            {"kind": "category", "id": "opaque:deep/category", "label": "Repeated"},
            {"kind": "policy", "id": "opaque:last policy", "label": None},
        ],
    }
    workspace = PolicyIndexWorkspace(catalog)
    workspace.get_policy = MagicMock(side_effect=AssertionError("no snapshots"))
    context = editor_context()
    command = CommandHarness(context)
    contexts = []
    command._context = lambda displayname, write=False: (
        contexts.append((displayname, write)) or context
    )
    opened = []
    selected_runtime = runtime()
    selected_runtime["locales"] = ["ru-RU"]
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        opened.append((args, kwargs)) or (workspace, selected_runtime)
    ))
    mutation = MagicMock(side_effect=AssertionError("read-only index"))
    monkeypatch.setattr(GPO, "_recover_before_mutation", mutation)
    monkeypatch.setattr(GPO, "_commit_external_once", mutation)
    requested_locales = ("ru", "en-US")

    result = GPO.gpo_editor_policy_index.execute(
        command, "Test GPO", requested_scope, locales=requested_locales,
    )

    assert contexts == [("Test GPO", False)]
    assert opened == [(
        (context, requested_locales), {"load_preferences": False},
    )]
    assert workspace.categories == [
        (scope, None, ["ru-RU"]),
        (scope, "opaque:category/A", ["ru-RU"]),
        (scope, "opaque:deep/category", ["ru-RU"]),
        (scope, "opaque:category/B", ["ru-RU"]),
    ]
    assert result["policies"] == [
        {"id": "opaque:root/orphan", "label": "Root", "path": []},
        {"id": "unconfigured:id", "label": "Не задана", "path": ["Система"]},
        {"id": "opaque:deep/policy", "label": "opaque:deep/policy",
         "path": ["Система", "Вложено"]},
        {"id": "opaque:last policy", "label": "opaque:last policy",
         "path": ["Другие"]},
    ]
    assert result["locales"] == ["ru-RU"]
    assert workspace.updates == workspace.comments == []
    workspace.get_policy.assert_not_called()
    mutation.assert_not_called()
    assert catalog[(scope, "opaque:deep/category")][0]["label"] == ""


def test_policy_index_handles_deep_categories_without_recursion(monkeypatch):
    depth = 1500
    catalog = {
        ("user", None): [{"kind": "category", "id": "c0", "label": "0"}],
    }
    for index in range(depth):
        catalog[("user", f"c{index}")] = (
            [{"kind": "category", "id": f"c{index + 1}",
              "label": str(index + 1)}]
            if index + 1 < depth
            else [{"kind": "policy", "id": "last", "label": "Last"}]
        )
    workspace = PolicyIndexWorkspace(catalog)
    opened = []
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        opened.append((args, kwargs)) or (workspace, runtime())
    ))

    result = GPO.gpo_editor_policy_index.execute(
        CommandHarness(editor_context()), "Test GPO", "user",
    )

    assert len(opened) == 1
    assert len(workspace.categories) == depth + 1
    assert result["policies"] == [{
        "id": "last", "label": "Last",
        "path": [str(index) for index in range(depth)],
    }]


def test_policy_index_has_registered_rpc_schema_and_public_envelope(monkeypatch):
    command_class = GPO.gpo_editor_policy_index
    assert command_class in {item["plugin"] for item in GPO.register}
    assert [argument.name for argument in command_class.takes_args] == [
        "displayname", "scope",
    ]
    assert all(argument.required for argument in command_class.takes_args)
    assert len(command_class.takes_options) == 1
    locale_option = command_class.takes_options[0]
    assert locale_option.name == "locales"
    assert locale_option.multivalue and not locale_option.required
    context = editor_context()
    workspace = PolicyIndexWorkspace({("computer", None): []})
    workspace.diagnostics = lambda: [{
        "message": f"check {GPO.GPO_TEMPLATE_ROOT}/source.admx",
    }]
    selected_runtime = runtime()
    selected_runtime["catalog"] = {"diagnostics": [{"message": "Catalog"}]}
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        workspace, selected_runtime,
    ))
    command = CommandHarness(context)
    command._run = lambda callback: GPO._GpoEditorCommand._run(command, callback)

    response = command_class.execute(command, "Test GPO", "computer")

    assert response["summary"] == "Group Policy editor operation completed"
    result = response["result"]
    assert result["policies"] == []
    assert result["gpo"] == {
        "displayname": "Test GPO", "guid": GUID,
        "distinguished_name": str(DN_VALUE),
    }
    assert result["snapshot"]["version_number"] == 0
    assert result["template"] is selected_runtime["catalog"]
    assert result["pending_publication"] is None
    assert result["locales"] == ["en-US"]
    assert result["diagnostics"] == [
        {"message": "Catalog"},
        {"message": "check <server-path>/source.admx"},
    ]
    assert str(GPO.GPO_TEMPLATE_ROOT) not in str(result)


@pytest.mark.parametrize("nodes", [
    None, {}, "invalid", [None], [{"id": "missing-kind"}],
    [{"kind": "unknown", "id": "x"}],
    [{"kind": "policy", "id": ""}],
    [{"kind": "category", "id": 12}],
    [{"kind": "policy", "id": "x", "label": {"private": "/server/path"}}],
    [{"kind": "category", "id": "x", "label": False}],
])
def test_policy_index_rejects_malformed_nodes_instead_of_partial_success(
    monkeypatch, nodes,
):
    workspace = PolicyIndexWorkspace({
        ("computer", None): [
            {"kind": "policy", "id": "valid", "label": "Valid"},
            {"kind": "category", "id": "broken", "label": "Broken"},
        ],
        ("computer", "broken"): nodes,
    })
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        workspace, runtime(),
    ))
    command = CommandHarness(editor_context())
    command._run = lambda callback: GPO._GpoEditorCommand._run(command, callback)

    with pytest.raises(errors.ExecutionError) as failure:
        GPO.gpo_editor_policy_index.execute(command, "Test GPO", "computer")

    assert failure.value.kw["error_category"] == "operational"
    assert "/server/path" not in str(failure.value)
    assert workspace.updates == workspace.comments == []


def test_policy_index_reports_child_source_failure_without_partial_result(
    monkeypatch,
):
    workspace = PolicyIndexWorkspace({
        ("computer", None): [{"kind": "category", "id": "broken"}],
    })
    binding_failure = RuntimeError("private /server/path")
    binding_failure.code = "io"
    workspace.list_policies = MagicMock(side_effect=[
        workspace.catalog[("computer", None)], binding_failure,
    ])
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        workspace, runtime(),
    ))
    command = CommandHarness(editor_context())
    command._run = lambda callback: GPO._GpoEditorCommand._run(command, callback)

    with pytest.raises(errors.ExecutionError) as failure:
        GPO.gpo_editor_policy_index.execute(command, "Test GPO", "computer")

    assert failure.value.kw["error_category"] == "operational"
    assert "/server/path" not in str(failure.value)
    assert workspace.list_policies.call_count == 2


def test_policy_index_resource_limit_fails_instead_of_truncating(monkeypatch):
    workspace = PolicyIndexWorkspace({("user", None): [
        {"kind": "policy", "id": str(index)} for index in range(4)
    ]})
    monkeypatch.setattr(GPO, "GPO_POLICY_INDEX_MAX_NODES", 3)
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: (
        workspace, runtime(),
    ))

    with pytest.raises(GPO.EditorFailure, match="resource limit") as failure:
        GPO.gpo_editor_policy_index.execute(
            CommandHarness(editor_context()), "Test GPO", "user",
        )

    assert failure.value.category == "operational"


def test_policy_index_invalid_scope_fails_before_context_or_binding(monkeypatch):
    command = CommandHarness(editor_context())
    command._context = MagicMock(side_effect=AssertionError("invalid scope"))
    command._run = lambda callback: GPO._GpoEditorCommand._run(command, callback)
    opened = MagicMock(side_effect=AssertionError("invalid scope"))
    monkeypatch.setattr(GPO, "_open_workspace", opened)

    with pytest.raises(errors.ExecutionError) as failure:
        GPO.gpo_editor_policy_index.execute(command, "Test GPO", "invalid")

    assert failure.value.kw["error_category"] == "validation"
    assert failure.value.kw["field"] == "scope"
    command._context.assert_not_called()
    opened.assert_not_called()


def test_policy_index_unauthorized_fails_before_filesystem_or_binding(monkeypatch):
    backend = FakeLdap(rights=False)
    command = CommandHarness(editor_context(), ldap_backend=backend)
    command.api.env = fake_api().env
    command._context = lambda displayname, write=False: (
        GPO._GpoEditorCommand._context(command, displayname, write=write)
    )
    command._run = lambda callback: GPO._GpoEditorCommand._run(command, callback)
    trusted_root = MagicMock(side_effect=AssertionError("unauthorized"))
    opened = MagicMock(side_effect=AssertionError("unauthorized"))
    monkeypatch.setattr(GPO, "_trusted_gpo_root", trusted_root)
    monkeypatch.setattr(GPO, "_open_workspace", opened)

    with pytest.raises(errors.ACIError):
        GPO.gpo_editor_policy_index.execute(command, "Test GPO", "user")

    assert [call[2] for call in backend.calls if call[0] == "can_write"] == [
        "ipagpoversionnumber",
    ]
    trusted_root.assert_not_called()
    opened.assert_not_called()


def test_editor_reconcile_uses_write_context_and_public_result(monkeypatch):
    workspace = SimpleNamespace(
        pending_external_publication=lambda: None,
        diagnostics=lambda: [],
    )
    context = editor_context()
    ldap_backend = object()
    harness = CommandHarness(context, ldap_backend=ldap_backend)
    context_calls = []

    def resolve_context(displayname, write=False):
        context_calls.append((displayname, write))
        return context

    harness._context = resolve_context
    opened = []
    monkeypatch.setattr(
        GPO,
        "_open_workspace",
        lambda *args, **kwargs: (
            opened.append((args, kwargs)) or (workspace, runtime())
        ),
    )
    reconciled = []
    monkeypatch.setattr(
        GPO,
        "_reconcile_workspace",
        lambda *args, **kwargs: (
            reconciled.append((args, kwargs)) or ({"kind": "clean"}, snapshot())
        ),
    )

    result = GPO.gpo_editor_reconcile.execute(harness, "Test GPO")

    assert context_calls == [("Test GPO", True)]
    assert opened == [(
        (context,),
        {"load_preferences": False, "with_catalog": False},
    )]
    assert reconciled == [(
        (workspace, ldap_backend, context),
        {"reject_conflict": False},
    )]
    assert result["recovery"] == {
        "kind": "clean",
        "plan": None,
        "conflict": None,
    }
    assert result["snapshot"]["version_number"] == 0


def test_preference_items_normalizes_machine_scope(monkeypatch):
    workspace = PreferenceWorkspace()
    item_calls = []
    workspace.list_preference_items = lambda scope, kind: (
        item_calls.append((scope, kind)) or list(workspace.items)
    )
    context = editor_context()
    monkeypatch.setattr(
        GPO,
        "_open_workspace",
        lambda *args, **kwargs: (workspace, runtime()),
    )

    result = GPO.gpo_editor_preference_items.execute(
        CommandHarness(context),
        "Test GPO",
        "machine",
        "files",
    )

    assert result["items"] == workspace.items
    assert item_calls == [("computer", "files")]


@pytest.mark.parametrize("value", [
    {"kind": "integer", "value": 4},
    {"kind": "text_list", "value": ["firefox", "chromium"]},
    {"kind": "key_value_list", "value": [
        {"key": "OpenSC", "value": "C:\\Program Files\\OpenSC\\module.dll"},
        {"key": "Provider=two:module", "value": ""},
    ]},
])
def test_policy_form_update_is_one_workspace_and_one_commit(monkeypatch, value):
    workspace = PolicyWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commits = []
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )
    request = {
        "state": "enabled",
        "set_parameters": [{
            "parameter_id": "p",
            "value": value,
        }],
        "clear_parameters": ["old"],
        "comment": {
            "action": "set",
            "target": "embedded",
            "text": "note",
        },
    }

    result = GPO.gpo_editor_policy_update.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "policy-id",
        request,
        locales=["en-US"],
    )

    assert len(workspace.updates) == 1
    assert workspace.updates[0][2]["set_parameters"] is request["set_parameters"]
    assert workspace.comments == [
        ("computer", "policy-id", "embedded", "note", ["en-US"])
    ]
    assert len(commits) == 1
    assert result["policy"]["policy_id"] == "policy-id"


def test_policy_key_value_rpc_arrays_reach_real_binding(monkeypatch, tmp_path):
    admix = pytest.importorskip("admix")
    templates = tmp_path / "PolicyDefinitions"
    locale = templates / "en-US"
    locale.mkdir(parents=True)
    (templates / "collections.admx").write_text(
        '''<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces><target prefix="collections" namespace="Test.Collections"/></policyNamespaces>
  <resources minRequiredRevision="1.0"/>
  <policies><policy name="Devices" class="Machine" displayName="$(string.Devices)"
      key="Software\\Test\\Devices" presentation="$(presentation.Devices)">
    <elements><list id="Pairs" explicitValue="true" expandable="true"/></elements>
  </policy></policies>
</policyDefinitions>''', encoding="utf-8",
    )
    (locale / "collections.adml").write_text(
        '''<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources revision="1.0" schemaVersion="1.0">
  <displayName>Collections</displayName><description>Collection RPC fixture</description>
  <resources><stringTable><string id="Devices">Devices</string></stringTable>
  <presentationTable><presentation id="Devices"><listBox refId="Pairs">Devices</listBox>
  </presentation></presentationTable></resources>
</policyDefinitionResources>''', encoding="utf-8",
    )
    gpo_root = tmp_path / "gpo"
    (gpo_root / "Machine").mkdir(parents=True)
    (gpo_root / "User").mkdir()
    (gpo_root / "GPT.INI").write_text("[General]\nVersion=0\n", encoding="utf-8")
    workspace = admix.Workspace.open(
        gpo_root, template_root=templates, locales=["en-US"],
        load_preferences=False, state_directory=tmp_path / "state",
        state_key="collection-rpc",
    ).native
    policy_id = "collections:Devices"
    initial = workspace.get_policy("computer", policy_id, ["en-US"])
    if not initial["capabilities"]["edit_parameters"]:
        pytest.skip("installed binding predates explicit key-value lists; run with the freshly built wheel")
    monkeypatch.setattr(GPO, "_open_workspace", lambda *a, **k: (workspace, runtime()))
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *a: None)
    monkeypatch.setattr(GPO, "_editor_envelope", lambda *a: {})
    commits = []
    monkeypatch.setattr(GPO, "_commit_external_once", lambda *a: commits.append(a) or {"changed": True})
    pairs = (
        {"key": "OpenSC", "value": "C:\\modules\\one=two:device.dll"},
        {"key": "Empty", "value": ""},
    )
    request = {"state": "enabled", "set_parameters": ({
        "parameter_id": "Pairs", "value": {"kind": "key_value_list", "value": pairs},
    },)}
    result = GPO.gpo_editor_policy_update.execute(
        CommandHarness(editor_context()), "Test GPO", "computer", policy_id,
        request, locales=["en-US"],
    )
    assert result["policy"]["parameters"][0]["value"] == {
        "kind": "key_value_list", "value": list(pairs),
    }
    assert len(commits) == 1
    assert isinstance(request["set_parameters"], tuple)
    assert isinstance(request["set_parameters"][0]["value"]["value"], tuple)


@pytest.mark.parametrize("action", ["set", "clear"])
def test_policy_comment_only_update_uses_comment_binding_without_policy_update(
    monkeypatch,
    action,
):
    workspace = PolicyWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commit = MagicMock(return_value={"changed": True})
    monkeypatch.setattr(GPO, "_commit_external_once", commit)
    comment = {"action": action, "target": "external"}
    if action == "set":
        comment["text"] = "comment only"

    result = GPO.gpo_editor_policy_update.execute(
        CommandHarness(context),
        "Test GPO",
        "user",
        "policy-id",
        {"comment": comment},
        locales=["ru-RU"],
    )

    assert workspace.updates == []
    if action == "set":
        assert workspace.comments == [
            ("user", "policy-id", "external", "comment only", ["en-US"])
        ]
        assert workspace.cleared_comments == []
    else:
        assert workspace.comments == []
        assert workspace.cleared_comments == [
            ("user", "policy-id", "external", ["en-US"])
        ]
    assert len(workspace.policy_reads) == 2
    commit.assert_called_once()
    assert result["policy"]["policy_id"] == "policy-id"


@pytest.mark.parametrize(
    ("comment", "field"),
    [
        ("not-an-object", "comment"),
        ({"action": "set", "text": 7}, "comment.text"),
        ({"action": "unknown"}, "comment.action"),
    ],
)
def test_policy_update_rejects_invalid_comment_before_commit(
    monkeypatch,
    comment,
    field,
):
    workspace = PolicyWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commit = MagicMock()
    monkeypatch.setattr(GPO, "_commit_external_once", commit)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_policy_update.execute(
            CommandHarness(context),
            "Test GPO",
            "computer",
            "policy-id",
            {"comment": comment},
            locales=["en-US"],
        )

    assert failure.value.category == "validation"
    assert failure.value.field == field
    commit.assert_not_called()


def test_policy_mid_form_validation_failure_never_reaches_commit(monkeypatch):
    workspace = PolicyWorkspace(fail_update=True)
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: pytest.fail("invalid form was committed"),
    )

    with pytest.raises(GPO.EditorFailure):
        GPO.gpo_editor_policy_update.execute(
            CommandHarness(context),
            "Test GPO",
            "computer",
            "policy-id",
            {"state": "enabled", "set_parameters": []},
            locales=["en-US"],
        )


@pytest.mark.parametrize(
    ("command", "args", "request_payload", "unknown_field"),
    [
        (
            GPO.gpo_editor_policy_update,
            ("Test GPO", "computer", "policy-id"),
            {"stat": "enabled"},
            "stat",
        ),
        (
            GPO.gpo_editor_preference_show,
            ("Test GPO", "computer", "files"),
            {"identity": None, "extra": True},
            "extra",
        ),
        (
            GPO.gpo_editor_preference_create,
            ("Test GPO", "computer", "files"),
            {"fields": [], "fileds": []},
            "fileds",
        ),
        (
            GPO.gpo_editor_preference_update,
            ("Test GPO", "computer", "files"),
            {"identity": ["files", "opaque-id"], "fileds": []},
            "fileds",
        ),
        (
            GPO.gpo_editor_preference_delete,
            ("Test GPO", "computer", "files"),
            {"identity": ["files", "opaque-id"], "extra": True},
            "extra",
        ),
    ],
)
def test_structured_editor_requests_reject_unknown_fields_before_context(
    command,
    args,
    request_payload,
    unknown_field,
):
    harness = CommandHarness(editor_context())
    context_calls = []
    harness._context = lambda *args, **kwargs: context_calls.append(
        (args, kwargs)
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        command.execute(harness, *args, request_payload)

    assert failure.value.category == "validation"
    assert failure.value.field == "request"
    assert failure.value.details == {"unknown_fields": [unknown_field]}
    assert context_calls == []


def test_preference_create_requires_fields_before_context():
    harness = CommandHarness(editor_context())
    context_calls = []
    harness._context = lambda *args, **kwargs: context_calls.append(
        (args, kwargs)
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_preference_create.execute(
            harness,
            "Test GPO",
            "computer",
            "files",
            {},
        )

    assert failure.value.category == "validation"
    assert failure.value.details == {"missing_fields": ["fields"]}
    assert context_calls == []


def test_policy_navigation_preserves_opaque_ids_and_unsupported_values(
    monkeypatch,
):
    workspace = PolicyReadWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )

    children = GPO.gpo_editor_children.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        category_id="opaque:category/with/slash",
        locales=["en-US"],
    )
    shown = GPO.gpo_editor_policy_show.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "opaque:policy/id",
        locales=["en-US"],
    )

    assert workspace.categories == [(
        "computer", "opaque:category/with/slash", ["en-US"]
    )]
    assert children["children"][0]["id"] == "opaque:policy/id"
    assert shown["policy"] is workspace.policy
    assert shown["policy"]["state"] == "unknown_raw_values"
    assert shown["policy"]["parameters"][0]["value"]["kind"] == (
        "unsupported"
    )
    assert "key" not in shown["policy"]
    assert "value_name" not in shown["policy"]


class PreferenceWorkspace:
    def __init__(self):
        self.items = [{
            "identity": ["files", "opaque-id"],
            "label": "item",
            "has_filters": True,
        }]
        self.insertions = []
        self.edits = []
        self.removals = []
        self.parent_candidate_calls = []
        self.parent_candidates = [
            {
                "identity": None,
                "label": "Root",
                "parent_identity": None,
                "depth": 0,
            },
            {
                "identity": ("opaque", "collection"),
                "label": "Nested",
                "parent_identity": None,
                "depth": 1,
            },
        ]

    def pending_external_publication(self):
        return None

    def diagnostics(self):
        return []

    def create_preference_item(self, scope, kind, fields, parent):
        self.edits.append(("create", scope, kind, fields, parent))
        return self.items[0]

    def list_preference_items(self, scope, kind):
        return list(self.items)

    def get_preference_fields(self, *args):
        return [{"id": "properties.path", "value": {"kind": "text", "value": "x"}}]

    def list_preference_filters(self, *args):
        return [{"path": [0, 1], "kind": "collection"}]

    def get_preference_filter_fields(self, *args):
        return [{"id": "bool", "value": {"kind": "filter_combine", "value": "and"}}]

    def preference_filter_kinds(self):
        return [{"kind": "group", "label": "Group"}]

    def get_new_preference_filter_fields(self, kind):
        return [{"id": "name", "value": {"kind": "text", "value": ""}}]

    def get_new_preference_item_fields(self, scope, kind):
        return [{"id": "properties.path", "value": {"kind": "text", "value": ""}}]

    def list_preference_parent_candidates(self, scope, kind):
        self.parent_candidate_calls.append((scope, kind))
        return list(self.parent_candidates)

    def insert_preference_filter(self, *args):
        self.insertions.append(args)

    def edit_preference_fields(self, *args):
        self.edits.append(("fields",) + args)

    def rename_preference_item(self, *args):
        self.edits.append(("rename",) + args)

    def edit_preference_filter_fields(self, *args):
        self.edits.append(("filter",) + args)

    def replace_preference_filter(self, *args):
        self.edits.append(("replace-filter",) + args)

    def remove_preference_filter(self, *args):
        self.edits.append(("remove-filter",) + args)

    def move_preference_filter(self, *args):
        self.edits.append(("move-filter",) + args)

    def remove_preference_item(self, *args):
        self.removals.append(args)


def test_preference_filter_replace_and_remove_preserve_opaque_paths():
    workspace = PreferenceWorkspace()
    identity = ["opaque", "item"]
    replacement_fields = [{
        "id": "filter.name",
        "value": {"kind": "text", "value": "admins"},
    }]

    GPO._apply_filter_operations(
        workspace,
        "computer",
        "registry",
        identity,
        [
            {
                "op": "replace",
                "path": [7, 2, 1],
                "filter_kind": "group",
                "fields": replacement_fields,
            },
            {"op": "remove", "path": [7, 2, 3]},
        ],
    )

    assert workspace.edits == [
        (
            "replace-filter",
            "computer",
            "registry",
            identity,
            [7, 2, 1],
            "group",
            replacement_fields,
        ),
        (
            "remove-filter",
            "computer",
            "registry",
            identity,
            [7, 2, 3],
        ),
    ]


def test_preference_filter_none_is_an_explicit_noop():
    workspace = PreferenceWorkspace()

    assert GPO._apply_filter_operations(
        workspace, "computer", "registry", ["opaque"], None
    ) is None
    assert workspace.edits == []
    assert workspace.insertions == []


def test_preference_filter_move_forwards_pre_move_paths_and_order():
    workspace = PreferenceWorkspace()
    identity = ["opaque", "item"]

    GPO._apply_filter_operations(
        workspace,
        "computer",
        "registry",
        identity,
        [
            {"op": "remove", "path": [0, 1]},
            {
                "op": "move",
                "source_path": [2, 0],
                "collection_path": [3, 1],
                "index": 2,
            },
            {"op": "edit", "path": [3, 1, 2], "fields": []},
        ],
    )

    assert workspace.edits == [
        ("remove-filter", "computer", "registry", identity, [0, 1]),
        ("move-filter", "computer", "registry", identity, [2, 0], [3, 1], 2),
        ("filter", "computer", "registry", identity, [3, 1, 2], []),
    ]


@pytest.mark.parametrize(
    "operations",
    [
        "not-an-ordered-list",
        ["not-an-operation"],
        [{"op": "unknown"}],
    ],
)
def test_preference_filter_operations_reject_malformed_input(operations):
    workspace = PreferenceWorkspace()

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._apply_filter_operations(
            workspace,
            "computer",
            "registry",
            ["opaque"],
            operations,
        )

    assert failure.value.category == "validation"
    assert failure.value.field == "filters"
    assert workspace.edits == []
    assert workspace.insertions == []


def test_preference_create_preserves_nested_paths_and_commits_once(monkeypatch):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commits = []
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )
    fields = [{
        "id": "properties.path",
        "value": {"kind": "optional_text", "value": None},
    }]
    filters = [{
        "op": "insert",
        "collection_path": [0, 2, 1],
        "index": 3,
        "filter_kind": "group",
        "fields": [{
            "id": "name",
            "value": {"kind": "text", "value": "admins"},
        }],
    }]

    result = GPO.gpo_editor_preference_create.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "files",
        {
            "fields": fields,
            "filters": filters,
            "parent": ["opaque", "collection"],
        },
    )

    assert workspace.edits[0][-2] == fields
    assert workspace.edits[0][-1] == ["opaque", "collection"]
    assert workspace.insertions[0][3] == [0, 2, 1]
    assert workspace.insertions[0][4] == 3
    assert workspace.insertions[0][5] == "group"
    assert len(commits) == 1
    assert result["item"]["identity"] == ["files", "opaque-id"]


def test_preference_show_supports_new_item_descriptors_without_identity(monkeypatch):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )

    result = GPO.gpo_editor_preference_show.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "files",
        {"identity": None},
    )

    assert result["item"] is None
    assert result["fields"][0]["value"]["kind"] == "text"
    assert result["filter_kinds"][0]["fields"]
    assert result["parent_candidates"] == [
        {
            "identity": None,
            "label": "Root",
            "parent_identity": None,
            "depth": 0,
        },
        {
            "identity": ["opaque", "collection"],
            "label": "Nested",
            "parent_identity": None,
            "depth": 1,
        },
    ]
    assert workspace.parent_candidate_calls == [("computer", "files")]


def test_preference_detail_keeps_unsupported_filters_without_leaking_errors():
    workspace = PreferenceWorkspace()
    filters = [
        {"path": [0], "kind": "collection", "label": "Collection"},
        {"path": [0, 0], "kind": None, "label": "Unknown filter"},
    ]
    workspace.list_preference_filters = lambda *args: filters

    def filter_fields(*args):
        path = args[-1]
        if path == [0]:
            return [{
                "id": "filter.bool",
                "value": {"kind": "filter_combine", "value": "and"},
            }]
        error = RuntimeError(
            "unsupported filter at /var/lib/freeipa/sysvol/private.xml"
        )
        error.code = "not_loaded"
        error.path = "/var/lib/freeipa/sysvol/private.xml"
        raise error

    workspace.get_preference_filter_fields = filter_fields

    result = GPO._preference_detail(
        workspace, "computer", "files", ["files", "opaque-id"]
    )

    assert result["filters"] == filters
    assert result["parent_candidates"][1]["identity"] == [
        "opaque", "collection"
    ]
    assert result["filter_fields"] == [
        {
            "path": [0],
            "fields": [{
                "id": "filter.bool",
                "value": {"kind": "filter_combine", "value": "and"},
            }],
            "available": True,
        },
        {
            "path": [0, 0],
            "fields": [],
            "available": False,
            "error_category": "unsupported",
        },
    ]
    serialized = json.dumps(result)
    assert "unsupported filter at" not in serialized
    assert "/var/lib/freeipa" not in serialized
    assert "private.xml" not in serialized


def test_preference_detail_reraises_other_filter_field_failures():
    workspace = PreferenceWorkspace()
    workspace.list_preference_filters = lambda *args: [
        {"path": [2], "kind": "computer"}
    ]
    error = RuntimeError("storage failure")
    error.code = "io"
    workspace.get_preference_filter_fields = lambda *args: (_ for _ in ()).throw(
        error
    )

    with pytest.raises(RuntimeError) as raised:
        GPO._preference_detail(
            workspace, "computer", "files", ["files", "opaque-id"]
        )

    assert raised.value is error


def test_preference_stale_identity_and_mid_operation_failure_do_not_commit(
    monkeypatch,
):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: pytest.fail("stale identity was committed"),
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_preference_update.execute(
            CommandHarness(context),
            "Test GPO",
            "computer",
            "files",
            {
                "identity": ["files", "stale"],
                "fields": [{
                    "id": "properties.path",
                    "value": {"kind": "text", "value": "new"},
                }],
            },
        )
    assert failure.value.category == "not_found"


def test_preference_update_and_delete_each_use_one_commit(monkeypatch):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commits = []
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )
    identity = ["files", "opaque-id"]
    typed_fields = [{
        "id": "properties.optional",
        "value": {"kind": "optional_text", "value": None},
    }]

    updated = GPO.gpo_editor_preference_update.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "files",
        {
            "identity": identity,
            "fields": typed_fields,
            "name": "renamed",
            "filters": [{
                "op": "edit",
                "path": [0, 3, 1],
                "fields": [{
                    "id": "bool",
                    "value": {"kind": "filter_combine", "value": "or"},
                }],
            }],
        },
    )
    deleted = GPO.gpo_editor_preference_delete.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "files",
        {"identity": identity},
    )

    assert len(commits) == 2
    field_edit = next(item for item in workspace.edits if item[0] == "fields")
    assert field_edit[-1] == typed_fields
    filter_edit = next(item for item in workspace.edits if item[0] == "filter")
    assert filter_edit[-2] == [0, 3, 1]
    assert updated["publication"]["changed"] is True
    assert workspace.removals == [("computer", "files", identity)]
    assert deleted["deleted_identity"] == identity


def test_preference_update_applies_all_targeting_operations_before_one_commit(
    monkeypatch,
):
    workspace = PreferenceWorkspace()
    context = editor_context()
    identity = ["files", "opaque-id"]
    operation_log = []
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    for action, method in (
        ("insert", "insert_preference_filter"),
        ("remove", "remove_preference_filter"),
        ("move", "move_preference_filter"),
        ("edit", "edit_preference_filter_fields"),
    ):
        monkeypatch.setattr(
            workspace,
            method,
            lambda *args, action=action: operation_log.append((action, args)),
        )
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: operation_log.append(("commit", args))
        or {"changed": True},
    )
    fields = [{
        "id": "filter.name",
        "value": {"kind": "text", "value": "admins"},
    }]
    operations = [
        {"op": "insert", "collection_path": [], "index": 1,
         "filter_kind": "collection", "fields": []},
        {"op": "insert", "collection_path": [1], "index": 0,
         "filter_kind": "group", "fields": fields},
        {"op": "move", "source_path": [0, 1],
         "collection_path": [1], "index": 1},
        {"op": "remove", "path": [0, 0]},
        {"op": "edit", "path": [1, 1], "fields": fields},
    ]

    result = GPO.gpo_editor_preference_update.execute(
        CommandHarness(context),
        "Test GPO",
        "computer",
        "files",
        {"identity": identity, "filters": operations},
    )

    assert [action for action, _ in operation_log] == [
        "insert", "insert", "move", "remove", "edit", "commit"
    ]
    assert operation_log[2][1] == (
        "computer", "files", identity, [0, 1], [1], 1
    )
    assert result["publication"] == {"changed": True}


def test_preference_failed_targeting_move_does_not_publish(monkeypatch):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: pytest.fail("invalid targeting move was published"),
    )

    def reject_move(*args):
        raise GPO.EditorFailure(
            "validation", "Cannot move a collection into its descendant.",
            field="filters",
        )

    monkeypatch.setattr(workspace, "move_preference_filter", reject_move)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_preference_update.execute(
            CommandHarness(context),
            "Test GPO",
            "computer",
            "files",
            {
                "identity": ["files", "opaque-id"],
                "filters": [
                    {"op": "edit", "path": [1], "fields": []},
                    {"op": "move", "source_path": [0],
                     "collection_path": [0, 1], "index": 0},
                ],
            },
        )

    assert failure.value.category == "validation"
    assert workspace.edits == [
        ("filter", "computer", "files", ["files", "opaque-id"], [1], [])
    ]


def test_preference_mid_request_failure_discards_workspace_without_commit(
    monkeypatch,
):
    workspace = PreferenceWorkspace()
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    monkeypatch.setattr(
        GPO,
        "_commit_external_once",
        lambda *args: pytest.fail("partially edited workspace was committed"),
    )

    with pytest.raises(GPO.EditorFailure):
        GPO.gpo_editor_preference_update.execute(
            CommandHarness(context),
            "Test GPO",
            "computer",
            "files",
            {
                "identity": ["files", "opaque-id"],
                "fields": [{
                    "id": "properties.path",
                    "value": {"kind": "text", "value": "edited in memory"},
                }],
                "filters": [{"op": "invalid-after-field-edit"}],
            },
        )
    assert any(item[0] == "fields" for item in workspace.edits)


def test_preference_documents_preserve_editability_but_redact_storage_path(
    monkeypatch,
):
    workspace = PreferenceWorkspace()
    workspace.list_preference_documents = lambda: [
        {
            "scope": "computer",
            "kind": "files",
            "label": "Files",
            "path": "Machine/Preferences/Files/Files.xml",
            "editable": True,
            "item_count": 1,
        },
        {
            "scope": "computer",
            "kind": "applications",
            "label": "Applications",
            "path": "Machine/Preferences/Applications/Applications.xml",
            "editable": False,
            "item_count": 2,
        },
    ]
    context = editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (workspace, runtime())
    )

    result = GPO.gpo_editor_preference_documents.execute(
        CommandHarness(context), "Test GPO"
    )

    assert [item["editable"] for item in result["documents"]] == [True, False]
    assert all("path" not in item for item in result["documents"])


def _script_command_environment(monkeypatch, workspace, context=None):
    context = context or editor_context()
    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: (workspace, script_runtime()),
    )
    recovered = []
    commits = []
    monkeypatch.setattr(
        GPO, "_recover_before_mutation",
        lambda *args: recovered.append(args),
    )
    monkeypatch.setattr(
        GPO, "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )
    return CommandHarness(context), recovered, commits


@pytest.mark.parametrize(("scope", "event"), [
    ("computer", "startup"), ("machine", "shutdown"),
    ("user", "logon"), ("user", "logoff"),
])
def test_script_context_accepts_only_scope_valid_events(scope, event):
    normalized_scope, normalized_event = GPO._validated_script_context(scope, event)
    assert normalized_event == event
    assert normalized_scope == ("computer" if scope == "machine" else scope)


@pytest.mark.parametrize(("scope", "event"), [
    ("computer", "logon"), ("user", "shutdown"), ("other", "startup"),
])
def test_script_context_rejects_cross_scope_events(scope, event):
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validated_script_context(scope, event)
    assert failure.value.category == "validation"


def test_script_validators_reject_path_forms_and_strict_base64(monkeypatch):
    with pytest.raises(GPO.EditorFailure):
        GPO._script_asset_name({"name": "../server-path"})
    with pytest.raises(GPO.EditorFailure):
        GPO._script_request({"gpo_path": "/srv"}, (), ())
    with pytest.raises(GPO.EditorFailure):
        GPO._decode_script_upload({"content_base64": "not base64!"})

    monkeypatch.setattr(GPO, "GPO_SCRIPT_UPLOAD_MAX_BYTES", 2)
    monkeypatch.setattr(GPO, "GPO_SCRIPT_UPLOAD_MAX_ENCODED_BYTES", 4)
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._decode_script_upload({"content_base64": "QUJD"})
    assert failure.value.category == "size_limit"
    assert failure.value.details == {"limit_bytes": 2}


def test_script_event_view_filters_groups_preserves_snapshots_and_sanitizes():
    view = GPO._script_event_view(ScriptWorkspace(), "computer", "startup")

    assert view["classic"]["snapshot"] == "classic-snapshot"
    assert view["powershell"]["snapshot"] == "powershell-snapshot"
    assert [item["identity"] for item in view["classic"]["entries"]] == [
        "classic-startup-0"
    ]
    assert view["classic"]["entries"][0]["kind"] == "managed_asset"
    assert view["powershell"]["entries"][0]["kind"] == "external"
    assert view["execution_order"] == "unspecified"
    diagnostic = view["classic"]["diagnostics"][0]
    assert diagnostic["code"] == "invalid_line"
    assert "/var/lib/freeipa" not in diagnostic["message"]
    assert "Machine/Scripts" not in diagnostic["message"]


def test_scripts_read_commands_do_not_recover_or_commit(monkeypatch):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(monkeypatch, workspace)

    shown = GPO.gpo_editor_scripts_show.execute(
        command, "Test GPO", "computer", "startup"
    )
    listed = GPO.gpo_editor_script_files.execute(
        command, "Test GPO", "computer", "startup"
    )

    assert shown["scripts"]["event"] == "startup"
    assert listed["scripts"]["assets"][0]["name"] == "startup.cmd"
    assert recovered == []
    assert commits == []


def test_script_download_returns_exact_bytes_without_path_or_commit(monkeypatch):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(monkeypatch, workspace)

    result = GPO.gpo_editor_script_asset_download.execute(
        command, "Test GPO", "computer", "startup",
        {"name": "startup.cmd", "revision": "asset-r1"},
    )

    assert result["asset"] == {
        "name": "startup.cmd", "byte_size": 3, "revision": "asset-r1",
        "content_base64": "QUJD",
    }
    assert "path" not in result["asset"]
    assert ("download", "computer", "startup", "startup.cmd", "asset-r1") in workspace.operations
    assert recovered == []
    assert commits == []


def test_script_download_rejects_bad_request_before_workspace(monkeypatch):
    opened = []
    monkeypatch.setattr(GPO, "_open_workspace", lambda *args, **kwargs: opened.append(args))
    command = CommandHarness(editor_context())

    for request in (
        {"name": "../secret", "revision": "asset-r1"},
        {"name": "startup.cmd", "revision": ""},
        {"name": "startup.cmd", "revision": "asset-r1", "path": "/etc"},
    ):
        with pytest.raises(GPO.EditorFailure):
            GPO.gpo_editor_script_asset_download.execute(
                command, "Test GPO", "computer", "startup", request,
            )
    assert opened == []


def test_script_download_rejects_oversized_binding_result(monkeypatch):
    workspace = ScriptWorkspace()
    workspace.read_script_asset = lambda *args: {
        "name": "startup.cmd", "revision": "asset-r1", "content": b"ABCD",
    }
    command, _recovered, commits = _script_command_environment(monkeypatch, workspace)
    monkeypatch.setattr(GPO, "GPO_SCRIPT_UPLOAD_MAX_BYTES", 3)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_asset_download.execute(
            command, "Test GPO", "computer", "startup",
            {"name": "startup.cmd", "revision": "asset-r1"},
        )

    assert failure.value.category == "size_limit"
    assert commits == []


def test_script_download_rejects_mismatched_binding_metadata(monkeypatch):
    workspace = ScriptWorkspace()
    workspace.read_script_asset = lambda *args: {
        "name": "/server/path", "revision": "asset-r1", "content": b"ABC",
    }
    command, _recovered, commits = _script_command_environment(monkeypatch, workspace)

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_asset_download.execute(
            command, "Test GPO", "computer", "startup",
            {"name": "startup.cmd", "revision": "asset-r1"},
        )

    assert failure.value.category == "operational"
    assert commits == []


def test_script_add_recovers_commits_once_and_returns_canonical_view(monkeypatch):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(monkeypatch, workspace)

    result = GPO.gpo_editor_script_entry_add.execute(
        command, "Test GPO", "computer", "startup", {
            "mode": "external_command", "executable_group": "classic",
            "snapshot": "classic-snapshot", "command_line": "cmd.exe",
            "parameters": "/c echo safe",
        },
    )

    assert len(recovered) == 1
    assert len(commits) == 1
    assert any(
        item["command_line"] == "cmd.exe"
        for item in result["scripts"]["classic"]["entries"]
    )


def test_script_add_existing_uses_inventory_canonical_name(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    GPO.gpo_editor_script_entry_add.execute(
        command, "Test GPO", "computer", "startup", {
            "mode": "existing_asset", "executable_group": "powershell",
            "snapshot": "powershell-snapshot", "name": "STARTUP.CMD",
            "parameters": "",
        },
    )

    add = next(operation for operation in workspace.operations if operation[0] == "add")
    assert add[5] == "startup.cmd"
    assert len(commits) == 1


def test_script_add_rejects_unknown_mode_before_workspace(monkeypatch):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entry_add.execute(
            command,
            "Test GPO",
            "computer",
            "startup",
            {
                "mode": "invented",
                "executable_group": "classic",
                "snapshot": "classic-snapshot",
                "parameters": "",
            },
        )

    assert failure.value.category == "validation"
    assert failure.value.field == "mode"
    assert recovered == []
    assert commits == []


def test_script_add_rejects_missing_existing_asset_without_commit(monkeypatch):
    workspace = ScriptWorkspace()
    workspace.assets = []
    command, _recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entry_add.execute(
            command,
            "Test GPO",
            "computer",
            "startup",
            {
                "mode": "existing_asset",
                "executable_group": "classic",
                "snapshot": "classic-snapshot",
                "name": "missing.cmd",
                "parameters": "",
            },
        )

    assert failure.value.category == "not_found"
    assert commits == []


def test_script_update_and_reorder_use_opaque_entry_contract(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    GPO.gpo_editor_script_entry_update.execute(
        command, "Test GPO", "computer", "startup", {
            "executable_group": "classic", "identity": "classic-startup-0",
            "command_line": "updated.cmd", "parameters": "--safe",
        },
    )
    GPO.gpo_editor_script_entries_reorder.execute(
        command, "Test GPO", "computer", "startup", {
            "executable_group": "classic", "snapshot": "classic-snapshot",
            "identities": ["classic-startup-0"],
        },
    )

    assert ("update", "classic-startup-0", "updated.cmd", "--safe") in workspace.operations
    assert any(operation[0] == "reorder" for operation in workspace.operations)
    assert len(commits) == 2


def test_script_stale_reorder_skips_commit(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    with pytest.raises(RuntimeError) as failure:
        GPO.gpo_editor_script_entries_reorder.execute(
            command, "Test GPO", "computer", "startup", {
                "executable_group": "classic", "snapshot": "stale",
                "identities": ["classic-startup-0"],
            },
        )
    assert failure.value.code == "conflict"
    assert commits == []


def test_script_remove_and_final_asset_delete_is_one_commit(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    result = GPO.gpo_editor_script_entry_remove.execute(
        command, "Test GPO", "computer", "startup", {
            "executable_group": "classic", "identity": "classic-startup-0",
            "delete_asset": True, "asset_revision": "asset-r1",
        },
    )

    assert [operation[0] for operation in workspace.operations if operation[0] in ("remove", "delete")] == [
        "remove", "delete"
    ]
    assert len(commits) == 1
    assert result["scripts"]["assets"] == []


def test_script_remove_rejects_non_boolean_delete_mode_before_workspace(
    monkeypatch,
):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entry_remove.execute(
            command,
            "Test GPO",
            "computer",
            "startup",
            {
                "executable_group": "classic",
                "identity": "classic-startup-0",
                "delete_asset": "yes",
            },
        )

    assert failure.value.category == "validation"
    assert failure.value.field == "delete_asset"
    assert recovered == []
    assert commits == []


def test_script_remove_rejects_asset_delete_for_unmanaged_entry(monkeypatch):
    workspace = ScriptWorkspace()
    command, _recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entry_remove.execute(
            command,
            "Test GPO",
            "computer",
            "shutdown",
            {
                "executable_group": "classic",
                "identity": "classic-shutdown-0",
                "delete_asset": True,
                "asset_revision": "asset-r1",
            },
        )

    assert failure.value.category == "validation"
    assert commits == []


def test_script_remove_rejects_missing_managed_asset_without_commit(
    monkeypatch,
):
    workspace = ScriptWorkspace()
    workspace.assets = []
    command, _recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entry_remove.execute(
            command,
            "Test GPO",
            "computer",
            "startup",
            {
                "executable_group": "classic",
                "identity": "classic-startup-0",
                "delete_asset": True,
                "asset_revision": "asset-r1",
            },
        )

    assert failure.value.category == "not_found"
    assert commits == []


def test_script_reorder_accepts_freeipa_json_tuple_identities(
    monkeypatch,
):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(
        monkeypatch,
        workspace,
    )

    GPO.gpo_editor_script_entries_reorder.execute(
        command,
        "Test GPO",
        "computer",
        "startup",
        {
            "executable_group": "classic",
            "snapshot": "classic-snapshot",
            "identities": ("classic-startup-0",),
        },
    )

    assert any(operation[0] == "reorder" and operation[-1] == ["classic-startup-0"]
               for operation in workspace.operations)
    assert len(recovered) == 1
    assert len(commits) == 1


def test_script_reorder_rejects_non_array_identities_before_workspace(monkeypatch):
    workspace = ScriptWorkspace()
    command, recovered, commits = _script_command_environment(
        monkeypatch, workspace
    )

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_entries_reorder.execute(
            command, "Test GPO", "computer", "startup", {
                "executable_group": "classic",
                "snapshot": "classic-snapshot",
                "identities": "classic-startup-0",
            },
        )

    assert failure.value.category == "validation"
    assert failure.value.field == "identities"
    assert recovered == []
    assert commits == []


def test_script_remove_shared_asset_does_not_commit(monkeypatch):
    workspace = ScriptWorkspace(shared_reference=True)
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    with pytest.raises(RuntimeError) as failure:
        GPO.gpo_editor_script_entry_remove.execute(
            command, "Test GPO", "computer", "startup", {
                "executable_group": "classic", "identity": "classic-startup-0",
                "delete_asset": True, "asset_revision": "asset-r1",
            },
        )
    assert failure.value.code == "asset_still_referenced"
    assert commits == []


def test_script_order_preserves_other_event_value_and_uses_powershell_snapshot(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    GPO.gpo_editor_script_order_update.execute(
        command, "Test GPO", "computer", "startup", {
            "snapshot": "powershell-snapshot",
            "execution_order": "powershell_first",
        },
    )

    assert ("order", "powershell-snapshot", True, False) in workspace.operations
    assert len(commits) == 1


@pytest.mark.parametrize(("scope", "event"), [
    ("computer", "shutdown"),
    ("user", "logoff"),
])
def test_script_end_event_order_preserves_start_value(
    monkeypatch, scope, event,
):
    workspace = ScriptWorkspace()
    workspace.groups["powershell"]["execution_order"] = {
        "start_execute_ps_first": False,
        "end_execute_ps_first": None,
    }
    workspace.set_script_execution_order = MagicMock(
        wraps=workspace.set_script_execution_order
    )
    command, _, commits = _script_command_environment(monkeypatch, workspace)

    result = GPO.gpo_editor_script_order_update.execute(
        command, "Test GPO", scope, event, {
            "snapshot": "powershell-snapshot",
            "execution_order": "powershell_first",
        },
    )

    workspace.set_script_execution_order.assert_called_once_with(
        scope, "powershell-snapshot", False, True
    )
    assert result["scripts"]["execution_order"] == "powershell_first"
    assert result["publication"] == {"changed": True}
    assert len(commits) == 1


def test_script_upload_rejects_bad_data_before_workspace_open(monkeypatch):
    opened = []
    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args: opened.append(args)
    )
    command = CommandHarness(editor_context())

    with pytest.raises(GPO.EditorFailure):
        GPO.gpo_editor_script_asset_upload.execute(
            command, "Test GPO", "computer", "startup", {
                "name": "upload.cmd", "content_base64": "bad!",
            },
        )
    assert opened == []


def test_script_asset_upload_recovers_commits_and_returns_uploaded_asset(
    monkeypatch,
):
    workspace = ScriptWorkspace()
    workspace.upload_script_asset = MagicMock(
        wraps=workspace.upload_script_asset
    )
    command, recovered, commits = _script_command_environment(
        monkeypatch, workspace
    )
    payload = b"echo safe\n"

    result = GPO.gpo_editor_script_asset_upload.execute(
        command, "Test GPO", "computer", "startup", {
            "name": "deploy.cmd",
            "content_base64": base64.b64encode(payload).decode("ascii"),
        },
    )

    workspace.upload_script_asset.assert_called_once_with(
        "computer", "startup", "deploy.cmd", payload
    )
    uploaded = next(
        asset for asset in result["scripts"]["assets"]
        if asset["name"] == "deploy.cmd"
    )
    assert uploaded == {
        "name": "deploy.cmd",
        "byte_size": len(payload),
        "revision": "new-r1",
        "references": [],
    }
    assert result["publication"] == {"changed": True}
    assert recovered == [(
        workspace, command.api.Backend.ldap2, command.context,
    )]
    assert commits == [(
        workspace, command.api.Backend.ldap2, command.context,
    )]


def test_script_upload_collision_is_safe_and_never_commits(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)
    encoded = base64.b64encode(b"new").decode("ascii")

    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_script_asset_upload.execute(
            command, "Test GPO", "computer", "startup", {
                "name": "STARTUP.CMD", "content_base64": encoded,
            },
        )
    assert failure.value.category == "asset_collision"
    assert failure.value.details["suggested_name"] == "startup-1.cmd"
    assert commits == []


def test_script_upload_and_add_replace_delete_use_one_commit(monkeypatch):
    workspace = ScriptWorkspace()
    command, _, commits = _script_command_environment(monkeypatch, workspace)
    encoded = base64.b64encode(b"new").decode("ascii")

    result = GPO.gpo_editor_script_upload_and_add.execute(
        command, "Test GPO", "computer", "startup", {
            "executable_group": "classic", "snapshot": "classic-snapshot",
            "name": "new.cmd", "content_base64": encoded, "parameters": "",
        },
    )
    assert any(asset["name"] == "new.cmd" for asset in result["scripts"]["assets"])
    assert len(commits) == 1

    GPO.gpo_editor_script_asset_replace.execute(
        command, "Test GPO", "computer", "startup", {
            "name": "new.cmd", "revision": "new-r1", "content_base64": encoded,
        },
    )
    GPO.gpo_editor_script_asset_delete.execute(
        command, "Test GPO", "computer", "startup", {
            "name": "new.cmd", "revision": "new-r1",
        },
    )
    assert len(commits) == 3


def test_editor_command_metadata_has_only_high_level_structured_contracts():
    expected = {
        "gpo_editor_open",
        "gpo_editor_children",
        "gpo_editor_policy_index",
        "gpo_editor_policy_show",
        "gpo_editor_policy_update",
        "gpo_editor_reconcile",
        "gpo_editor_preference_documents",
        "gpo_editor_preference_items",
        "gpo_editor_preference_show",
        "gpo_editor_preference_create",
        "gpo_editor_preference_update",
        "gpo_editor_preference_delete",
        "gpo_editor_scripts_show",
        "gpo_editor_security_definitions_show",
        "gpo_editor_security_definitions_update",
        "gpo_editor_security_show",
        "gpo_editor_security_update",
        "gpo_editor_advanced_audit_show",
        "gpo_editor_advanced_audit_update",
        "gpo_editor_script_files",
        "gpo_editor_script_asset_download",
        "gpo_editor_script_entry_add",
        "gpo_editor_script_entry_update",
        "gpo_editor_script_entry_remove",
        "gpo_editor_script_entries_reorder",
        "gpo_editor_script_order_update",
        "gpo_editor_script_asset_upload",
        "gpo_editor_script_upload_and_add",
        "gpo_editor_script_asset_replace",
        "gpo_editor_script_asset_delete",
    }
    commands = {
        name for name, value in vars(GPO).items()
        if name.startswith("gpo_editor_") and isinstance(value, type)
    }
    assert commands == expected

    assert {
        "ipaGpoMachineExtensionNames", "ipaGpoUserExtensionNames", "ipaGpoVersionNumber"
    } <= set(GPO.gpo.default_attributes)
    assert "ipaGpoFileSysPath" not in GPO.gpo.default_attributes
    modified = GPO.gpo.managed_permissions[
        "System: Modify Group Policy Objects"
    ]["ipapermdefaultattr"]
    assert {
        "ipaGpoMachineExtensionNames", "ipaGpoUserExtensionNames", "ipaGpoVersionNumber"
    } <= modified


@pytest.mark.parametrize("locale", ["en-US", "ru-RU"])
def test_security_catalog_passes_packaged_sdmx_1_0_schemas_to_native(
    locale, monkeypatch,
):
    calls = []

    class Catalog:
        def __init__(self, root, **options):
            calls.append((root, options))

        def generation(self):
            return {"semantic_revision": "good", "locale": locale}

        def diagnostics(self):
            return []

    monkeypatch.setattr(
        GPO, "_security_definition_locales", lambda: ["en-US", "ru-RU"]
    )
    catalog, state, selected_locale = GPO._get_security_catalog(
        [locale], SimpleNamespace(SecurityDefinitionCatalog=Catalog), now=10.0
    )

    assert isinstance(catalog, Catalog)
    assert selected_locale == locale
    assert state["generation"]["locale"] == locale
    assert GPO.GPO_SDMX_SCHEMA_ROOT == Path("/usr/share/xml/sdmx/1.0")
    assert calls == [("/usr/share/PolicyDefinitions", {
        "locale": locale,
        "sdmx_schema": "/usr/share/xml/sdmx/1.0/sdmx-1.0.xsd",
        "sdml_schema": "/usr/share/xml/sdmx/1.0/sdml-1.0.xsd",
    })]


def test_security_catalog_locales_and_refresh_retain_healthy_generation(
    tmp_path, monkeypatch,
):
    definitions = tmp_path / "definitions"
    for locale in ("en-US", "ru-RU"):
        directory = definitions / locale
        directory.mkdir(parents=True)
        (directory / "security.sdml").write_text("fixture")
    schemas = tmp_path / "schemas"
    schemas.mkdir()
    monkeypatch.setattr(GPO, "GPO_SECURITY_DEFINITION_ROOT", definitions)
    monkeypatch.setattr(GPO, "GPO_SDMX_SCHEMA_ROOT", schemas)
    monkeypatch.setattr(GPO, "GPO_SDMX_SCHEMA", schemas / "sdmx-1.0.xsd")
    monkeypatch.setattr(GPO, "GPO_SDML_SCHEMA", schemas / "sdml-1.0.xsd")

    class Catalog:
        def __init__(self, root, **options):
            self.root = root
            self.options = options
            self.refreshes = 0

        def generation(self):
            return {"semantic_revision": "good", "locale": self.options["locale"]}

        def diagnostics(self):
            return []

        def refresh_if_changed(self):
            self.refreshes += 1
            return {
                "status": "failed",
                "failure": {
                    "message": str(schemas / "private.xsd"),
                    "diagnostics": [{
                        "message": str(schemas / "private.xsd"),
                        "file": str(definitions / "private.sdmx"),
                        "code": "xsd.invalid",
                    }],
                },
            }

    module = SimpleNamespace(SecurityDefinitionCatalog=Catalog)
    first, first_state, locale = GPO._get_security_catalog(
        ["ru"], module, now=10.0
    )
    second, second_state, _ = GPO._get_security_catalog(
        ["ru-RU"], module, now=12.0
    )
    third, third_state, _ = GPO._get_security_catalog(
        ["ru-RU"], module, now=20.0
    )
    english, _, english_locale = GPO._get_security_catalog(
        ["en-US"], module, now=20.0
    )

    assert locale == "ru-RU"
    assert english_locale == "en-US" and english is not first
    assert first is second is third
    assert first_state["generation"]["semantic_revision"] == "good"
    assert second_state["refresh"] is None
    assert first.refreshes == 1
    assert third_state["generation"]["semantic_revision"] == "good"
    assert third_state["refresh"]["failure"]["diagnostics"][0]["file"] == "private.sdmx"
    assert str(tmp_path) not in str(third_state)


def test_workspace_constructor_prefers_current_binding_and_keeps_legacy_fallback(
    monkeypatch,
):
    context = editor_context()
    calls = []

    def current_workspace(root, **options):
        calls.append((root, options))
        return object()

    def legacy_workspace(*args, **kwargs):
        pytest.fail("legacy constructor selected over GroupPolicyWorkspace")

    module = SimpleNamespace(
        GroupPolicyWorkspace=current_workspace,
        HighLevelApi=legacy_workspace,
    )
    monkeypatch.setattr(GPO, "_load_admix", lambda: module)
    catalog = object()
    monkeypatch.setattr(
        GPO, "_get_security_catalog",
        lambda *args: (catalog, {"generation": {"semantic_revision": "good"}}, "ru-RU"),
    )

    _, state = GPO._open_workspace(
        context, ["ru"], with_catalog=False, with_security_catalog=True
    )

    assert calls[0][0] == str(context.gpo_root)
    assert calls[0][1]["security_catalog"] is catalog
    assert state["locales"] == ["ru-RU"]
    assert state["security_catalog"]["generation"]["semantic_revision"] == "good"

    del module.GroupPolicyWorkspace
    module.HighLevelApi = lambda *args, **kwargs: "legacy"
    workspace, _ = GPO._open_workspace(context, with_catalog=False)
    assert workspace == "legacy"


def test_security_definition_rpc_preserves_all_catalog_policies_and_commits_once(
    monkeypatch,
):
    class Workspace:
        def __init__(self):
            self.updates = []
            self.catalog = {
                "semantic_revision": "sha256:good",
                "policies": [
                    {"namespace": "urn:test", "policy_id": "p-{}".format(i)}
                    for i in range(185)
                ],
            }

        def pending_external_publication(self):
            return None

        def diagnostics(self):
            return []

        def security_definition_catalog(self):
            return self.catalog

        def security_definition_snapshot(self):
            return {"semantic_revision": "sha256:good", "diagnostics": []}

        def update_security_definitions(self, request):
            self.updates.append(request)

    workspace = Workspace()
    context = editor_context()
    opened = []
    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: (
            opened.append(kwargs) or workspace,
            {"catalog": None, "security_catalog": None, "locales": ["en-US"]},
        ),
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commits = []
    monkeypatch.setattr(
        GPO, "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )

    shown = GPO.gpo_editor_security_definitions_show.execute(
        CommandHarness(context), "Test GPO", locales=["en-US"]
    )
    request = {
        "expected_semantic_revision": "sha256:good",
        "policies": [{
            "namespace": "urn:test", "policy_id": "p-0",
            "transition": "define", "elements": [],
        }],
    }
    wire_request = json_decode_binary(json.dumps({"request": request}))["request"]
    assert isinstance(wire_request["policies"], tuple)
    updated = GPO.gpo_editor_security_definitions_update.execute(
        CommandHarness(context), "Test GPO", wire_request, locales=["en-US"]
    )
    alias = GPO.gpo_editor_security_show.execute(
        CommandHarness(context), "Test GPO", locales=["en-US"]
    )

    assert all(call == {
        "load_preferences": False, "with_catalog": False,
        "with_security_catalog": True,
    } for call in opened)
    assert len(shown["security_catalog"]["policies"]) == 185
    assert alias["security_catalog"] is shown["security_catalog"]
    assert workspace.updates == [request]
    assert len(commits) == 1
    assert updated["publication"] == {"changed": True}


def test_security_update_restores_nested_rpc_arrays_before_binding():
    request = {
        "expected_semantic_revision": "sha256:good",
        "policies": [{
            "namespace": "urn:test", "policy_id": "restricted-groups",
            "elements": [{
                "element_id": "groups", "action": "rows",
                "rows": [{
                    "action": "upsert",
                    "key": {"kind": "string", "value": "Administrators"},
                    "fields": {
                        "members": {
                            "state": "set",
                            "value": {"kind": "list", "value": ["alice", "bob"]},
                        },
                    },
                }],
            }],
        }],
    }
    wire_request = json_decode_binary(json.dumps({"request": request}))["request"]
    assert isinstance(wire_request["policies"][0]["elements"][0]["rows"], tuple)
    assert isinstance(
        wire_request["policies"][0]["elements"][0]["rows"][0]
        ["fields"]["members"]["value"]["value"], tuple,
    )

    assert GPO._validate_security_update(wire_request) == request
    assert isinstance(wire_request["policies"], tuple)


def test_security_rpc_array_restoration_reaches_real_binding(tmp_path):
    admix = pytest.importorskip("admix")
    sdmx_schema = GPO.GPO_SDMX_SCHEMA
    sdml_schema = GPO.GPO_SDML_SCHEMA
    if not sdmx_schema.exists() or not sdml_schema.exists():
        pytest.skip("installed SDMX schemas are unavailable")

    catalog = admix.SecurityDefinitionCatalog(
        "/usr/share/PolicyDefinitions", locale="en-US",
        sdmx_schema=str(sdmx_schema), sdml_schema=str(sdml_schema),
    )
    gpo_root = tmp_path / "gpo"
    gpo_root.mkdir()
    workspace = admix.GroupPolicyWorkspace(
        str(gpo_root), security_catalog=catalog, load_preferences=False,
        state_directory=str(tmp_path / "state"), state_key="rpc-array-test",
    )
    definition_catalog = workspace.security_definition_catalog()
    policy = next(
        policy for policy in definition_catalog["policies"]
        if len(policy.get("elements") or []) == 1
        and policy["elements"][0]["value_type"] == "integer"
        and policy["elements"][0].get("initial") is not None
    )
    element = policy["elements"][0]
    request = {
        "expected_semantic_revision": definition_catalog["semantic_revision"],
        "policies": [{
            "namespace": policy["namespace"], "policy_id": policy["policy_id"],
            "transition": "define", "elements": [{
                "element_id": element["id"], "action": "set",
                "value": element["initial"],
            }],
        }],
    }
    wire_request = json_decode_binary(json.dumps({"request": request}))["request"]
    result = workspace.update_security_definitions(
        GPO._validate_security_update(wire_request)
    )

    assert any(
        row["policy_id"] == policy["policy_id"] and row["state"] == "defined"
        for row in result["policies"]
    )


@pytest.mark.parametrize(("payload", "field"), [
    (None, "request"),
    ({"policies": []}, "request.expected_semantic_revision"),
    ({"expected_semantic_revision": "r", "policies": [], "extra": True}, "request"),
    ({"expected_semantic_revision": "r", "policies": [None]}, "request.policies[0]"),
])
def test_security_update_rejects_malformed_rpc_envelope(payload, field):
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validate_security_update(payload)
    assert failure.value.category == "validation"
    assert failure.value.field == field


@pytest.mark.parametrize(("policy", "field"), [
    ({"namespace": "n", "policy_id": "p", "extra": True}, "request.policies[0]"),
    ({"namespace": "", "policy_id": "p"}, "request.policies[0].namespace"),
    ({"namespace": "n", "policy_id": "p", "transition": "replace"}, "request.policies[0].transition"),
    ({"namespace": "n", "policy_id": "p", "elements": "wrong"}, "request.policies[0].elements"),
    ({"namespace": "n", "policy_id": "p", "elements": [None]}, "request.policies[0].elements[0]"),
    ({"namespace": "n", "policy_id": "p", "elements": [
        {"element_id": "e", "action": "set", "value": {"kind": "boolean", "value": True}},
        {"element_id": "e", "action": "unset"},
    ]}, "request.policies[0].elements[1]"),
])
def test_security_update_rejects_malformed_policy_actions(policy, field):
    request = {"expected_semantic_revision": "r", "policies": [policy]}
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validate_security_update(request)
    assert failure.value.category == "validation"
    assert failure.value.field == field


@pytest.mark.parametrize(("element", "suffix"), [
    ({"action": "unset"}, ".element_id"),
    ({"element_id": "e", "action": "replace"}, ""),
    ({"element_id": "e", "action": "unset", "value": None}, ""),
    ({"element_id": "e", "action": "set", "value": False}, ".value"),
    ({"element_id": "e", "action": "set", "value": {"kind": "boolean", "value": True, "extra": 1}}, ".value"),
    ({"element_id": "e", "action": "set", "value": {"kind": "", "value": True}}, ".value.kind"),
    ({"element_id": "e", "action": "rows", "rows": "wrong"}, ".rows"),
])
def test_security_update_rejects_malformed_element_actions(element, suffix):
    request = {"expected_semantic_revision": "r", "policies": [{
        "namespace": "n", "policy_id": "p", "elements": [element],
    }]}
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validate_security_update(request)
    assert failure.value.category == "validation"
    assert failure.value.field == "request.policies[0].elements[0]" + suffix


@pytest.mark.parametrize(("row", "suffix"), [
    (None, ""),
    ({"action": "replace", "key": {"kind": "string", "value": "x"}}, ""),
    ({"action": "delete", "key": {"kind": "string", "value": "x"}, "fields": {}}, ""),
    ({"action": "delete", "key": None}, ".key"),
    ({"action": "upsert", "key": {"kind": "string", "value": "x"}, "fields": []}, ".fields"),
    ({"action": "upsert", "key": {"kind": "string", "value": "x"}, "fields": {"": {"state": "unset"}}}, ".fields"),
    ({"action": "upsert", "key": {"kind": "string", "value": "x"}, "fields": {"members": None}}, ".fields.members"),
    ({"action": "upsert", "key": {"kind": "string", "value": "x"}, "fields": {"members": {"state": "replace"}}}, ".fields.members"),
    ({"action": "upsert", "key": {"kind": "string", "value": "x"}, "fields": {"members": {"state": "unset", "value": None}}}, ".fields.members"),
])
def test_security_update_rejects_malformed_keyed_rows(row, suffix):
    request = {"expected_semantic_revision": "r", "policies": [{
        "namespace": "n", "policy_id": "p", "elements": [{
            "element_id": "rows", "action": "rows", "rows": [row],
        }],
    }]}
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._validate_security_update(request)
    assert failure.value.category == "validation"
    assert failure.value.field == "request.policies[0].elements[0].rows[0]" + suffix


@pytest.mark.parametrize("payload", [
    {"expected_semantic_revision": "r", "policies": "not a list"},
    {"expected_semantic_revision": "r", "policies": [{
        "namespace": "n", "policy_id": "p", "elements": [{
            "element_id": "e", "action": "set", "value": {"kind": "integer"},
        }],
    }]},
    {"expected_semantic_revision": "r", "policies": [{
        "namespace": "n", "policy_id": "p", "transition": "undefine",
        "elements": [{"element_id": "e", "action": "unset"}],
    }]},
    {"expected_semantic_revision": "r", "policies": [{
        "namespace": "n", "policy_id": "p", "elements": [],
    }, {
        "namespace": "n", "policy_id": "p", "elements": [],
    }]},
])
def test_security_update_rejects_invalid_requests_before_workspace(
    monkeypatch, payload,
):
    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: pytest.fail("invalid request opened workspace"),
    )
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_security_definitions_update.execute(
            CommandHarness(editor_context()), "Test GPO", payload
        )
    assert failure.value.category == "validation"


def test_security_definition_rpc_rejects_secret_fields_from_binding(monkeypatch):
    class Workspace:
        def pending_external_publication(self):
            return None

        def diagnostics(self):
            return []

        def security_definition_catalog(self):
            return {"policies": [{"secret_value": "never expose"}]}

        def security_definition_snapshot(self):
            return {"diagnostics": []}

    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: (
            Workspace(), {"catalog": None, "locales": ["en-US"]}
        ),
    )
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_security_definitions_show.execute(
            CommandHarness(editor_context()), "Test GPO"
        )
    assert failure.value.category == "operational"
    assert "never expose" not in str(failure.value)


def test_security_binding_validation_diagnostics_are_safe_and_never_published(
    monkeypatch,
):
    class ConstraintFailure(RuntimeError):
        code = "validation"
        field = "security_definitions"
        diagnostics = [{
            "severity": "error", "stage": "validation",
            "code": "constraint.failed",
            "message": "Invalid " + str(GPO.GPO_SECURITY_DEFINITION_ROOT / "private.sdmx"),
            "file": str(GPO.GPO_SECURITY_DEFINITION_ROOT / "private.sdmx"),
            "policy_id": "test.policy", "element_id": "value",
        }]

    class Workspace:
        def pending_external_publication(self):
            return None

        def update_security_definitions(self, request):
            raise ConstraintFailure("private parser detail")

    monkeypatch.setattr(
        GPO, "_open_workspace", lambda *args, **kwargs: (
            Workspace(), {"catalog": None, "locales": ["en-US"]}
        ),
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    monkeypatch.setattr(
        GPO, "_commit_external_once",
        lambda *args: pytest.fail("invalid draft was published"),
    )
    payload = {
        "expected_semantic_revision": "sha256:good",
        "policies": [{"namespace": "urn:test", "policy_id": "test.policy"}],
    }

    with pytest.raises(ConstraintFailure) as failure:
        GPO.gpo_editor_security_definitions_update.execute(
            CommandHarness(editor_context()), "Test GPO", payload
        )
    with pytest.raises(errors.ExecutionError) as translated:
        GPO._translate_editor_exception(failure.value)

    details = json.loads(translated.value.kw["details"])
    assert translated.value.kw["error_category"] == "validation"
    assert details["diagnostics"][0]["file"] == "private.sdmx"
    assert details["diagnostics"][0]["code"] == "constraint.failed"
    assert str(GPO.GPO_SECURITY_DEFINITION_ROOT) not in str(details)
    assert "private parser detail" not in str(translated.value)


def test_advanced_audit_rpc_uses_one_workspace_and_one_publication(monkeypatch):
    class Workspace:
        def __init__(self):
            self.updates = []
            self.audit = {
                "rows": [{"kind": "option", "option": "crash_on_audit_fail"}],
                "subcategory_catalog": [],
            }

        def pending_external_publication(self):
            return None

        def diagnostics(self):
            return []

        def get_advanced_audit(self):
            return self.audit

        def update_advanced_audit(self, request):
            self.updates.append(request)
            return self.audit

    workspace = Workspace()
    context = editor_context()
    opened = []
    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: (
            opened.append(kwargs) or workspace,
            {"catalog": None, "locales": []},
        ),
    )
    monkeypatch.setattr(GPO, "_recover_before_mutation", lambda *args: None)
    commits = []
    monkeypatch.setattr(
        GPO, "_commit_external_once",
        lambda *args: commits.append(args) or {"changed": True},
    )

    shown = GPO.gpo_editor_advanced_audit_show.execute(
        CommandHarness(context), "Test GPO"
    )
    payload = {
        "set_options": [{
            "machine_name": "CrashOnAuditFail",
            "option": "crash_on_audit_fail",
            "enabled": False,
        }],
    }
    wire_payload = json_decode_binary(json.dumps({"request": payload}))["request"]
    assert isinstance(wire_payload["set_options"], tuple)
    updated = GPO.gpo_editor_advanced_audit_update.execute(
        CommandHarness(context), "Test GPO", wire_payload
    )

    assert shown["advanced_audit"] is workspace.audit
    assert updated["advanced_audit"] is workspace.audit
    assert workspace.updates[0]["set_options"] == payload["set_options"]
    assert isinstance(workspace.updates[0]["set_options"], list)
    assert workspace.updates[0]["clear_options"] == []
    assert len(workspace.updates) == len(commits) == 1
    assert updated["publication"] == {"changed": True}
    assert opened == [
        {"load_preferences": False, "with_catalog": False},
        {"load_preferences": False, "with_catalog": False},
    ]


@pytest.mark.parametrize("payload", [
    "invalid",
    {"unknown": []},
    {"set_options": "invalid"},
    {"set_options": ["invalid"]},
    {"clear_options": [{}]},
    {"clear_subcategories": ["invalid"]},
    {"set_global_sacls": ["invalid"]},
    {"clear_global_sacls": [{}]},
])
def test_advanced_audit_update_rejects_invalid_shape_before_workspace(
    monkeypatch, payload,
):
    monkeypatch.setattr(
        GPO, "_open_workspace",
        lambda *args, **kwargs: pytest.fail("invalid request opened workspace"),
    )
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO.gpo_editor_advanced_audit_update.execute(
            CommandHarness(editor_context()), "Test GPO", payload
        )
    assert failure.value.category == "validation"
