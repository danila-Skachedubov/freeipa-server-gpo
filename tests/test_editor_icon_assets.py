"""Semantic icon assets must survive explicit installer packaging."""

import ast
import re
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "plugin/ui/grouppolicy"


def test_semantic_icons_are_included_by_the_explicit_ui_installer_manifest():
    module = ast.parse((ROOT / "ipa_gpo_install/actions.py").read_text())
    assignment = next(
        statement
        for statement in module.body
        if isinstance(statement, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "UI_PLUGIN_FILES"
            for target in statement.targets
        )
    )
    manifest = ast.literal_eval(assignment.value)
    assert len(manifest) == len(set(manifest))
    assert "css/icons.css" in manifest
    assert "js/components/editor-icons.js" in manifest
    assert re.search(r'@import\s+url\(["\'](?:\./)?icons\.css["\']\);', (UI / "css/main.css").read_text())
    references = re.findall(r"url\(\.\./(img/svg/ico/[^)]+)\)", (UI / "css/icons.css").read_text())
    assert len(references) == 58
    assert len(set(references)) == len(references)
    for reference in references:
        assert reference in manifest, reference
        element = ET.parse(UI / reference).getroot()
        assert element.tag == "{http://www.w3.org/2000/svg}svg"
        assert element.attrib["width"] == element.attrib["height"] == "16"
        assert element.attrib["viewBox"] == "0 0 16 16"
