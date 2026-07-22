"""Smoke coverage for the installed libadmix editor binding.

These tests deliberately exercise the packaged extension and the PolicyDefinitions
tree that the FreeIPA plugin will use.  Backend command tests use fakes for failure
injection; this module guards the real DTO contract at the integration boundary.
"""

import shutil
from pathlib import Path

import pytest

from admix import AdmixError, HighLevelApi, TemplateCatalog


SCRIPTS_CSE_GUID = "{42B5FAAE-6536-11D2-AE5A-0000F87571E3}"
COMPUTER_SCRIPTS_TOOL_GUID = "{40B6664F-4972-11D1-A7CA-0000F87571E3}"
USER_SCRIPTS_TOOL_GUID = "{40B66650-4972-11D1-A7CA-0000F87571E3}"

MACHINE_ADMINISTRATIVE_TEMPLATES_EXTENSION = (
    "[{35378EAC-683F-11D2-A89A-00C04FBBCFA2}"
    "{D02B1F72-3407-48AE-BA88-E8213C6761F1}]"
)

POLICY_DEFINITIONS = Path("/usr/share/PolicyDefinitions")
FIXTURES = Path(__file__).resolve().parents[1] / "PoliciesData"
FIXED_ELEMENT_POLICY_ID = "BaseALTKDE:kde-filesearch"
FIXED_ELEMENT_PARAMETER_ID = "kde-basicsettings_setter"
CURSOR_SIZE_POLICY_ID = "BaseALTGnome:OrgGnomeDesktopInterfaceCursorSizeMachine"
CURSOR_SIZE_PARAMETER_ID = "gnome-cursor-size_setter"
CURSOR_BLOCK_PARAMETER_ID = "gnome-cursor-size_blocker"


@pytest.fixture(scope="module")
def catalog():
    if not POLICY_DEFINITIONS.is_dir():
        pytest.skip("the admx-basealt PolicyDefinitions tree is not installed")
    return TemplateCatalog(str(POLICY_DEFINITIONS), all_locales=True)


def _kde_fixture_root():
    matches = [
        path.parent
        for path in FIXTURES.rglob("GPT.INI")
        if "ALT_Settings_KDE" in str(path)
    ]
    assert len(matches) == 1
    return matches[0]


def _script_publication_workspace(tmp_path, state_key):
    """Return an empty, structurally valid GPO workspace for scripts tests."""
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)
    for event in ("Startup", "Shutdown"):
        (gpo_root / "Machine" / "Scripts" / event).mkdir(parents=True)
    for event in ("Logon", "Logoff"):
        (gpo_root / "User" / "Scripts" / event).mkdir(parents=True)
    api = HighLevelApi(
        str(gpo_root),
        load_preferences=False,
        state_directory=str(tmp_path / "state"),
        state_key=state_key,
    )
    identity = {
        "guid": "{99999999-9999-9999-9999-999999999999}",
        "distinguished_name": "CN=Scripts,DC=example,DC=test",
        "file_sys_path": (
            "\\\\example.test\\sysvol\\example.test\\Policies\\"
            "{99999999-9999-9999-9999-999999999999}"
        ),
    }
    return api, gpo_root, identity


def _publication_snapshot(identity, version, machine="", user=""):
    return {
        "identity": identity,
        "version_number": version,
        "machine_extension_names": machine,
        "user_extension_names": user,
    }


def _acknowledge_script_plan(api, plan):
    api.acknowledge_external(
        plan["idempotency_token"],
        _publication_snapshot(
            plan["identity"],
            plan["target_version"],
            plan["machine_extension_names"],
            plan["user_extension_names"],
        ),
    )


def test_installed_binding_exposes_scripts_dto(tmp_path):
    """Exercise the public scripts DTO directly through the installed binding."""
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)
    (gpo_root / "Machine" / "Scripts" / "Startup").mkdir(parents=True)

    api = HighLevelApi(str(gpo_root), load_preferences=False)
    classic = api.show_script_group("computer", "classic")
    powershell = api.show_script_group("computer", "powershell")
    assets = api.list_script_assets("computer", "startup")

    assert {"snapshot", "editable", "entries", "diagnostics"} <= classic.keys()
    assert {"snapshot", "execution_order"} <= powershell.keys()
    assert assets == []


def test_scripts_publication_preserves_exact_versions_and_cse_ownership(
    tmp_path,
):
    """Exercise the scripts publication plan across both scopes."""

    api, gpo_root, identity = _script_publication_workspace(
        tmp_path, "scripts-publication-contract"
    )
    current = _publication_snapshot(identity, 1)
    computer_pair = SCRIPTS_CSE_GUID + COMPUTER_SCRIPTS_TOOL_GUID
    user_pair = SCRIPTS_CSE_GUID + USER_SCRIPTS_TOOL_GUID

    # An orphan asset changes the computer half of GPT.INI but does not claim
    # Scripts CSE ownership.
    api.upload_script_asset("computer", "startup", "orphan.cmd", b"echo")
    asset_only = api.commit_external(current)["publication_plan"]
    assert asset_only["target_version"] == 2
    assert asset_only["affected_scopes"] == {"computer": True, "user": False}
    assert asset_only["machine_extension_names"] == ""
    _acknowledge_script_plan(api, asset_only)
    current = _publication_snapshot(identity, 2)

    classic = api.show_script_group("computer", "classic")
    api.add_script_entry(
        "computer", "classic", "startup", classic["snapshot"], "orphan.cmd", ""
    )
    first_computer = api.commit_external(current)["publication_plan"]
    assert first_computer["target_version"] == 3
    assert first_computer["machine_extension_names"] == "[{}]".format(
        computer_pair
    )
    assert first_computer["user_extension_names"] == ""
    _acknowledge_script_plan(api, first_computer)
    current = _publication_snapshot(
        identity, 3, first_computer["machine_extension_names"]
    )

    powershell = api.show_script_group("user", "powershell")
    api.add_script_entry(
        "user", "powershell", "logon", powershell["snapshot"], "logon.ps1", ""
    )
    first_user = api.commit_external(current)["publication_plan"]
    assert first_user["target_version"] == 65539
    assert first_user["machine_extension_names"] == "[{}]".format(
        computer_pair
    )
    assert first_user["user_extension_names"] == "[{}]".format(user_pair)
    _acknowledge_script_plan(api, first_user)
    current = _publication_snapshot(
        identity,
        65539,
        first_user["machine_extension_names"],
        first_user["user_extension_names"],
    )

    classic = api.show_script_group("computer", "classic")
    api.remove_script_entry(
        "computer", "classic", "startup", classic["entries"][0]["identity"]
    )
    final_computer = api.commit_external(current)["publication_plan"]
    assert final_computer["target_version"] == 65540
    assert final_computer["machine_extension_names"] == ""
    assert final_computer["user_extension_names"] == "[{}]".format(user_pair)
    _acknowledge_script_plan(api, final_computer)
    assert "Version=65540" in (gpo_root / "GPT.INI").read_text("utf-8")


def test_scripts_publication_recovery_does_not_duplicate_a_mutation(tmp_path):
    api, gpo_root, identity = _script_publication_workspace(
        tmp_path, "scripts-publication-recovery"
    )
    before = _publication_snapshot(identity, 1)
    classic = api.show_script_group("computer", "classic")
    api.add_script_entry(
        "computer", "classic", "startup", classic["snapshot"], "recover.cmd", ""
    )
    plan = api.commit_external(before)["publication_plan"]

    # A fresh workspace first asks the host to apply the original plan.  Once
    # the observed LDAP snapshot matches that plan it asks for acknowledgement,
    # then permits a no-op commit instead of replaying the mutation.
    reopened = HighLevelApi(
        str(gpo_root),
        load_preferences=False,
        state_directory=str(tmp_path / "state"),
        state_key="scripts-publication-recovery",
    )
    assert reopened.reconcile_external(before)["kind"] == "apply"
    published = _publication_snapshot(
        identity,
        plan["target_version"],
        plan["machine_extension_names"],
        plan["user_extension_names"],
    )
    assert reopened.reconcile_external(published)["kind"] == "acknowledge"
    _acknowledge_script_plan(reopened, plan)
    assert reopened.pending_external_publication() is None
    assert reopened.commit_external(published)["directory"] == "no_publication_required"


def test_catalog_loads_supported_locales_without_diagnostics(catalog):
    generation = catalog.generation()

    assert generation["number"] >= 1
    assert {"en-US", "ru-RU"} <= set(generation["loaded_locales"])
    assert catalog.diagnostics() == []


def test_catalog_retains_healthy_generation_after_unusable_refresh(tmp_path):
    template_root = tmp_path / "PolicyDefinitions"
    shutil.copytree(POLICY_DEFINITIONS, template_root)
    isolated = TemplateCatalog(str(template_root), all_locales=True)
    healthy = isolated.generation()

    for template in template_root.glob("*.admx"):
        template.write_text("<broken>", encoding="utf-8")

    refresh = isolated.refresh_if_changed()
    retained = isolated.generation()

    assert refresh["status"] == "failed"
    assert refresh["failure"] is not None
    assert refresh["current_generation"] == healthy["number"]
    assert retained == healthy


def test_catalog_publishes_a_new_generation_after_valid_refresh(tmp_path):
    template_root = tmp_path / "PolicyDefinitions"
    shutil.copytree(POLICY_DEFINITIONS, template_root)
    isolated = TemplateCatalog(str(template_root), all_locales=True)
    previous = isolated.generation()
    template = template_root / "BaseALT.admx"
    source = template.read_text(encoding="utf-8")
    template.write_text(
        source.replace(
            "</policyDefinitions>",
            "<!-- integration refresh -->\n</policyDefinitions>",
        ),
        encoding="utf-8",
    )

    refresh = isolated.refresh_if_changed()
    current = isolated.generation()

    assert refresh["status"] == "changed"
    assert refresh["failure"] is None
    assert current["number"] == previous["number"] + 1
    assert current["content_fingerprint"] != previous["content_fingerprint"]


def test_real_policy_fixture_returns_typed_web_dto(catalog):
    api = HighLevelApi(
        str(_kde_fixture_root()),
        template_catalog=catalog,
        locales=["ru-RU", "en-US"],
        load_preferences=True,
    )

    policy = api.get_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        ["en-US"],
    )

    assert policy["policy_id"] == FIXED_ELEMENT_POLICY_ID
    assert policy["state"] == "enabled"
    assert policy["capabilities"]["edit_parameters"] is True
    assert policy["state_actions"]["enabled"] == {
        "available": True,
        "mode": "element_values",
        "requires_parameters": True,
    }
    assert policy["state_actions"]["disabled"] == {
        "available": True,
        "mode": "delete_element_bindings",
        "requires_parameters": False,
    }
    assert policy["parameters"]
    assert all("default_value" in parameter for parameter in policy["parameters"])
    assert all("kind" in parameter for parameter in policy["parameters"])
    assert all(
        parameter["value"] is None or "kind" in parameter["value"]
        for parameter in policy["parameters"]
    )
    assert "key" not in policy
    assert "value_name" not in policy
    assert api.pending_external_publication() is None


def test_real_unknown_registry_type_stays_unsupported_and_path_free(
    catalog, tmp_path
):
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)
    registry = gpo_root / "Machine/Registry.pol"
    payload = bytearray(registry.read_bytes())
    marker = "Indexing-Enabled\0".encode("utf-16-le")
    type_offset = payload.index(marker) + len(marker) + 2
    assert payload[type_offset:type_offset + 4] == (4).to_bytes(4, "little")
    payload[type_offset:type_offset + 4] = (99).to_bytes(4, "little")
    registry.write_bytes(payload)

    api = HighLevelApi(
        str(gpo_root),
        template_catalog=catalog,
        locales=["en-US"],
    )
    policy = api.get_policy(
        "computer", FIXED_ELEMENT_POLICY_ID, ["en-US"]
    )
    parameter = next(
        item
        for item in policy["parameters"]
        if item["id"] == "kde-basicsettings_setter"
    )

    assert parameter["value"]["kind"] == "unsupported"
    assert parameter["value"]["value"]["kind"] == "preserved_unknown"
    assert parameter["value"]["value"]["reg_type"] == 99
    assert "key" not in policy
    assert "value_name" not in policy
    assert "Registry.pol" not in str(policy)


def test_real_workspace_exposes_authoritative_preference_inventory(catalog):
    api = HighLevelApi(
        str(_kde_fixture_root()),
        template_catalog=catalog,
        locales=["en-US"],
        load_preferences=True,
    )

    documents = api.list_preference_documents()

    assert documents
    assert all(
        {"scope", "kind", "label", "editable", "item_count"} <= document.keys()
        for document in documents
    )
    assert {document["scope"] for document in documents} == {"computer", "user"}


def test_real_catalog_omits_recursively_empty_categories(catalog):
    api = HighLevelApi(
        str(_kde_fixture_root()),
        template_catalog=catalog,
        locales=["en-US"],
        load_preferences=True,
    )

    machine_root = api.list_policies("computer", None, ["en-US"])
    assert "BaseALT:LinuxComponents" not in {
        item["id"] for item in machine_root
    }

    user_alt_system = api.list_policies(
        "user", "BaseALT:ALT_System", ["en-US"]
    )
    assert "BaseALT:ALT_CD_DVD" not in {
        item["id"] for item in user_alt_system
    }


def test_real_new_preference_fields_have_scope_and_checkbox_defaults(catalog):
    api = HighLevelApi(
        str(_kde_fixture_root()),
        template_catalog=catalog,
        locales=["en-US"],
        load_preferences=True,
    )

    computer = api.get_new_preference_item_fields("computer", "ini_files")
    user = api.get_new_preference_item_fields("user", "ini_files")

    assert "metadata.userContext" not in {field["id"] for field in computer}
    user_context = next(
        field for field in user if field["id"] == "metadata.userContext"
    )
    assert user_context["editable"] is True
    assert user_context["value"] == {
        "kind": "optional_boolean",
        "value": False,
    }

    by_id = {field["id"]: field for field in user}
    for field_id in (
        "properties.section",
        "properties.property",
        "properties.value",
    ):
        assert by_id[field_id]["editable"] is True
    assert by_id["properties.disabled"]["control"] == "optional_boolean_u8"
    assert by_id["properties.disabled"]["value"] == {
        "kind": "optional_unsigned_byte",
        "value": 0,
    }


def test_real_external_publication_round_trip(catalog, tmp_path):
    guid = "{E361BAA9-67B3-4828-84C1-6A74AADB9D06}"
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)
    api = HighLevelApi(
        str(gpo_root),
        template_catalog=catalog,
        locales=["en-US"],
        load_preferences=True,
        state_directory=str(tmp_path / "state"),
        state_key=guid,
    )

    updated = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        set_parameters=[{
            "parameter_id": FIXED_ELEMENT_PARAMETER_ID,
            "value": {"kind": "boolean", "value": False},
        }],
        locales=["en-US"],
    )
    assert updated["dirty"] is True

    identity = {
        "guid": guid,
        "distinguished_name": (
            f"CN={guid},CN=Policies,CN=System,DC=example,DC=test"
        ),
        "file_sys_path": (
            "\\\\example.test\\sysvol\\example.test\\Policies\\" + guid
        ),
    }
    committed = api.commit_external({
        "identity": identity,
        "version_number": 1,
        "machine_extension_names": "",
        "user_extension_names": "",
    })
    plan = committed["publication_plan"]

    assert committed["directory"] == "external_handoff"
    assert committed["files"]["affected_scopes"] == {
        "computer": True,
        "user": False,
    }
    assert {item["path"] for item in committed["files"]["paths"]} == {
        "Machine/Registry.pol",
        "GPT.INI",
    }
    assert plan["expected_version"] == 1
    assert plan["target_version"] == 2
    assert plan["machine_extension_names"] == (
        MACHINE_ADMINISTRATIVE_TEMPLATES_EXTENSION
    )
    assert plan["user_extension_names"] == ""
    assert api.pending_external_publication()["phase"] == (
        "awaiting_directory_publication"
    )

    published_snapshot = {
        "identity": plan["identity"],
        "version_number": plan["target_version"],
        "machine_extension_names": plan["machine_extension_names"],
        "user_extension_names": plan["user_extension_names"],
    }
    api.acknowledge_external(
        plan["idempotency_token"], published_snapshot
    )

    assert api.pending_external_publication() is None

    no_op = api.commit_external(published_snapshot)
    assert no_op["directory"] == "no_publication_required"
    assert no_op["publication_plan"] is None
    assert no_op["files"]["paths"] == []
    assert no_op["files"]["affected_scopes"] == {
        "computer": False,
        "user": False,
    }
    assert api.pending_external_publication() is None


def test_real_fixed_element_policy_state_round_trip(catalog, tmp_path):
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)

    def open_workspace():
        return HighLevelApi(
            str(gpo_root),
            template_catalog=catalog,
            locales=["en-US"],
            load_preferences=False,
            state_directory=str(tmp_path / "state"),
            state_key="fixed-element-policy-state-round-trip",
        )

    def policy(api):
        return api.get_policy(
            "computer", FIXED_ELEMENT_POLICY_ID, ["en-US"]
        )

    api = open_workspace()
    cleared = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        state="not_configured",
        locales=["en-US"],
    )
    assert cleared["state"] == "not_configured"
    assert cleared["dirty"] is True
    assert api.commit_offline()["directory"] == "skipped_offline"

    api = open_workspace()
    unconfigured = policy(api)
    assert unconfigured["state"] == "not_configured"
    parameter = next(
        item
        for item in unconfigured["parameters"]
        if item["id"] == FIXED_ELEMENT_PARAMETER_ID
    )
    assert parameter["value"] is None
    assert parameter["default_value"] is not None
    assert all(
        item["default_value"] is not None
        for item in unconfigured["parameters"]
    )

    enabled = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        state="enabled",
        set_parameters=[
            {
                "parameter_id": item["id"],
                "value": item["default_value"],
            }
            for item in unconfigured["parameters"]
        ],
        locales=["en-US"],
    )
    assert enabled["state"] == "enabled"
    assert enabled["dirty"] is True
    api.commit_offline()

    api = open_workspace()
    assert policy(api)["state"] == "enabled"
    disabled = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        state="disabled",
        locales=["en-US"],
    )
    assert disabled["state"] == "disabled"
    assert disabled["dirty"] is True
    api.commit_offline()

    api = open_workspace()
    assert policy(api)["state"] == "disabled"
    repeated = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        state="disabled",
        locales=["en-US"],
    )
    assert repeated["dirty"] is False
    final = api.update_policy(
        "computer",
        FIXED_ELEMENT_POLICY_ID,
        state="not_configured",
        locales=["en-US"],
    )
    assert final["state"] == "not_configured"
    assert final["dirty"] is True
    api.commit_offline()

    api = open_workspace()
    assert policy(api)["state"] == "not_configured"


def test_real_optional_block_clear_preserves_enabled_policy(catalog, tmp_path):
    gpo_root = tmp_path / "gpo"
    shutil.copytree(_kde_fixture_root(), gpo_root)

    def open_workspace():
        return HighLevelApi(
            str(gpo_root),
            template_catalog=catalog,
            locales=["en-US"],
            load_preferences=False,
            state_directory=str(tmp_path / "state"),
            state_key="optional-block-clear-round-trip",
        )

    api = open_workspace()
    policy = api.get_policy("computer", CURSOR_SIZE_POLICY_ID, ["en-US"])
    parameters = {item["id"]: item for item in policy["parameters"]}
    enabled = api.update_policy(
        "computer",
        CURSOR_SIZE_POLICY_ID,
        state="enabled",
        set_parameters=[
            {
                "parameter_id": CURSOR_SIZE_PARAMETER_ID,
                "value": parameters[CURSOR_SIZE_PARAMETER_ID]["default_value"],
            },
            {
                "parameter_id": CURSOR_BLOCK_PARAMETER_ID,
                "value": {"kind": "boolean", "value": True},
            },
        ],
        locales=["en-US"],
    )
    assert enabled["state"] == "enabled"

    cleared = api.update_policy(
        "computer",
        CURSOR_SIZE_POLICY_ID,
        clear_parameters=[CURSOR_BLOCK_PARAMETER_ID],
        locales=["en-US"],
    )
    assert cleared["state"] == "enabled"
    blocker = next(
        item
        for item in cleared["parameters"]
        if item["id"] == CURSOR_BLOCK_PARAMETER_ID
    )
    assert blocker["value"] is None
    api.commit_offline()

    reopened = open_workspace().get_policy(
        "computer", CURSOR_SIZE_POLICY_ID, ["en-US"]
    )
    assert reopened["state"] == "enabled"

    before_required_clear = reopened
    with pytest.raises(AdmixError) as error:
        open_workspace().update_policy(
            "computer",
            CURSOR_SIZE_POLICY_ID,
            clear_parameters=[CURSOR_SIZE_PARAMETER_ID],
            locales=["en-US"],
        )
    assert error.value.code == "validation"
    assert open_workspace().get_policy(
        "computer", CURSOR_SIZE_POLICY_ID, ["en-US"]
    ) == before_required_clear
