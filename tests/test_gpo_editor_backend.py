"""Focused unit and contract coverage for the FreeIPA libadmix editor host."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import ldap
import pytest
from ipalib import errors
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
        "gpcfilesyspath": [UNC],
        "versionnumber": [0],
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


def test_binding_contract_is_centralized_and_rejects_mismatches():
    assert "preference-parent-candidates" in GPO.ADMIX_REQUIRED_CAPABILITIES
    compatible = SimpleNamespace(HighLevelApi=SimpleNamespace(
        binding_api_version=lambda: 1,
        binding_capabilities=lambda: list(GPO.ADMIX_REQUIRED_CAPABILITIES),
    ))
    assert GPO._binding_info(compatible)["api_version"] == 1

    old = SimpleNamespace(HighLevelApi=SimpleNamespace(
        binding_api_version=lambda: 0,
        binding_capabilities=lambda: list(GPO.ADMIX_REQUIRED_CAPABILITIES),
    ))
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._binding_info(old)
    assert failure.value.category == "operational"
    assert failure.value.details["installed_api_version"] == 0

    missing = SimpleNamespace(HighLevelApi=SimpleNamespace(
        binding_api_version=lambda: 1,
        binding_capabilities=lambda: list(
            GPO.ADMIX_REQUIRED_CAPABILITIES - {"preference-field-controls"}
        ),
    ))
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._binding_info(missing)
    assert failure.value.details["missing_capabilities"] == [
        "preference-field-controls"
    ]

    missing_parent_candidates = SimpleNamespace(HighLevelApi=SimpleNamespace(
        binding_api_version=lambda: 1,
        binding_capabilities=lambda: list(
            GPO.ADMIX_REQUIRED_CAPABILITIES
            - {"preference-parent-candidates"}
        ),
    ))
    with pytest.raises(GPO.EditorFailure) as failure:
        GPO._binding_info(missing_parent_candidates)
    assert failure.value.details["missing_capabilities"] == [
        "preference-parent-candidates"
    ]


def test_lazy_catalog_refresh_is_throttled_and_retains_healthy_generation():
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

    module = SimpleNamespace(
        TemplateCatalog=Catalog,
        HighLevelApi=SimpleNamespace(
            binding_api_version=lambda: 1,
            binding_capabilities=lambda: list(GPO.ADMIX_REQUIRED_CAPABILITIES),
        ),
    )
    first, first_state = GPO._get_catalog(module, now=10.0)
    second, _ = GPO._get_catalog(module, now=12.0)
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
        "versionnumber"
    ]


def test_write_context_requires_every_publication_attribute(
    tmp_path, monkeypatch
):
    rights = {
        "gpcfilesyspath": True,
        "versionnumber": True,
        "gpcmachineextensionnames": True,
        "gpcuserextensionnames": False,
    }
    backend = FakeLdap(rights=rights)
    make_gpo_tree(tmp_path, monkeypatch)

    with pytest.raises(errors.ACIError):
        GPO._resolve_editor_context(
            backend, fake_api(), "Test GPO", write=True
        )
    assert [call[2] for call in backend.calls if call[0] == "can_write"] == [
        "gpcfilesyspath",
        "versionnumber",
        "gpcmachineextensionnames",
        "gpcuserextensionnames",
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
    backend = FakeLdap(entry(gpcfilesyspath=[unsafe_path]))
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

        @staticmethod
        def binding_api_version():
            return 1

        @staticmethod
        def binding_capabilities():
            return list(GPO.ADMIX_REQUIRED_CAPABILITIES)

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

        @staticmethod
        def binding_api_version():
            return 1

        @staticmethod
        def binding_capabilities():
            return list(GPO.ADMIX_REQUIRED_CAPABILITIES)

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


def plan(expected=0, target=1, machine="M", user="U"):
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
        "gPCMachineExtensionNames",
        "",
        None,
        True,
        absent_probe=GPO.GPC_ABSENT_EXTENSION_PROBE,
    )
    absent_empty = GPO._compare_replace_modifications(
        backend,
        "gPCUserExtensionNames",
        "",
        None,
        False,
        absent_probe=GPO.GPC_ABSENT_EXTENSION_PROBE,
    )

    assert present_empty == [
        (ldap.MOD_DELETE, "gPCMachineExtensionNames", [b""])
    ]
    probe = GPO.GPC_ABSENT_EXTENSION_PROBE.encode()
    assert absent_empty == [
        (ldap.MOD_ADD, "gPCUserExtensionNames", [probe]),
        (ldap.MOD_DELETE, "gPCUserExtensionNames", [probe]),
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
        (ldap.MOD_DELETE, "gPCFileSysPath", [UNC.encode()]),
        (ldap.MOD_ADD, "gPCFileSysPath", [UNC.encode()]),
        (ldap.MOD_DELETE, "versionNumber", [b"0"]),
        (ldap.MOD_ADD, "versionNumber", [b"1"]),
        (
            ldap.MOD_ADD,
            "gPCMachineExtensionNames",
            [b"[(EXACT-MACHINE)]"],
        ),
        (ldap.MOD_ADD, "gPCUserExtensionNames", [probe]),
        (ldap.MOD_DELETE, "gPCUserExtensionNames", [probe]),
    ]
    assert backend.removed == [DN_VALUE]


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
        return {"policy_id": policy_id, "dirty": False, "parameters": []}

    def set_policy_comment(self, scope, policy_id, target, text, locales):
        self.comments.append((scope, policy_id, target, text, locales))
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


def runtime():
    return {
        "binding": {"api_version": 1, "capabilities": []},
        "catalog": None,
        "locales": ["en-US"],
    }


def test_editor_command_success_envelope_uses_eager_string_summary():
    envelope = GPO._GpoEditorCommand._run(None, lambda: {"ok": True})

    assert isinstance(envelope["summary"], str)
    assert envelope["result"] == {"ok": True}


def test_policy_form_update_is_one_workspace_and_one_commit(monkeypatch):
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
            "value": {"kind": "integer", "value": 4},
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

    def remove_preference_item(self, *args):
        self.removals.append(args)


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


def test_editor_command_metadata_has_only_high_level_structured_contracts():
    expected = {
        "gpo_editor_open",
        "gpo_editor_children",
        "gpo_editor_policy_show",
        "gpo_editor_policy_update",
        "gpo_editor_reconcile",
        "gpo_editor_preference_documents",
        "gpo_editor_preference_items",
        "gpo_editor_preference_show",
        "gpo_editor_preference_create",
        "gpo_editor_preference_update",
        "gpo_editor_preference_delete",
    }
    commands = {
        name for name, value in vars(GPO).items()
        if name.startswith("gpo_editor_") and isinstance(value, type)
    }
    assert commands == expected
    source = MODULE_PATH.read_text()
    legacy_suffixes = (
        "get" + "_policy",
        "set" + "_policy",
        "delete" + "_policy",
        "get" + "_current_value",
        "save" + "_preference",
        "get" + "_preferences",
        "delete" + "_preference",
        "get" + "_locale",
        "set" + "_locale",
    )
    legacy = ["class gpo_" + suffix for suffix in legacy_suffixes]
    legacy.extend((
        "_call_" + "gpui" + "service_method",
        "name" + "_gpt",
    ))
    for legacy in legacy:
        assert legacy not in source

    assert {
        "gPCMachineExtensionNames", "gPCUserExtensionNames", "versionNumber"
    } <= set(GPO.gpo.default_attributes)
    assert "gPCFileSysPath" not in GPO.gpo.default_attributes
    modified = GPO.gpo.managed_permissions[
        "System: Modify Group Policy Objects"
    ]["ipapermdefaultattr"]
    assert {
        "gPCMachineExtensionNames", "gPCUserExtensionNames", "versionNumber"
    } <= modified
