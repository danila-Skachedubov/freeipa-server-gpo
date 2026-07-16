"""Smoke coverage for the installed libadmix editor binding.

These tests deliberately exercise the packaged extension and the PolicyDefinitions
tree that the FreeIPA plugin will use.  Backend command tests use fakes for failure
injection; this module guards the real DTO contract at the integration boundary.
"""

import shutil
from pathlib import Path

import pytest

from admix import HighLevelApi, TemplateCatalog


REQUIRED_CAPABILITIES = {
    "typed-policy-values",
    "atomic-policy-updates",
    "policy-capabilities",
    "element-policy-state-actions",
    "preference-item-lifecycle",
    "preference-filter-lifecycle",
    "preference-field-controls",
    "preference-parent-candidates",
    "policy-comments",
    "external-publication-recovery",
    "snapshot-verified-publication",
    "reusable-template-catalog",
    "external-file-publication-resume",
    "external-no-publication-required",
    "planner-owned-extension-values",
}

MACHINE_ADMINISTRATIVE_TEMPLATES_EXTENSION = (
    "[{35378EAC-683F-11D2-A89A-00C04FBBCFA2}"
    "{D02B1F72-3407-48AE-BA88-E8213C6761F1}]"
)

POLICY_DEFINITIONS = Path("/usr/share/PolicyDefinitions")
FIXTURES = Path(__file__).resolve().parents[1] / "PoliciesData"
FIXED_ELEMENT_POLICY_ID = "BaseALTKDE:kde-filesearch"
FIXED_ELEMENT_PARAMETER_ID = "kde-basicsettings_setter"


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


def test_installed_binding_has_complete_editor_contract():
    assert HighLevelApi.binding_api_version() == 3
    assert REQUIRED_CAPABILITIES <= set(HighLevelApi.binding_capabilities())


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
