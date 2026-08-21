"""Static and command-line contracts for the package version."""

import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from ipa_gpo_install import __version__


ROOT = Path(__file__).resolve().parents[1]


def test_python_version_matches_rpm_spec():
    spec = (ROOT / "ipa-gpo-install.spec").read_text(encoding="utf-8")
    match = re.search(r"^Version:\s*(\S+)\s*$", spec, re.MULTILINE)

    assert match is not None
    assert __version__ == match.group(1)


def test_installed_entry_point_reports_package_version():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT)
    result = subprocess.run(
        [sys.executable, str(ROOT / "bin" / "ipa-gpo-install"), "--version"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )

    assert result.returncode == 0
    assert __version__ in result.stdout


def test_oddjob_config_exposes_expected_gpo_helpers():
    root = ET.parse(ROOT / "plugin" / "dbus_handlers" / "ipa-gpo.conf").getroot()

    service = root.find("./service")
    assert service is not None
    assert service.attrib == {"name": "org.freeipa.server"}

    object_node = service.find("./object")
    assert object_node is not None
    assert object_node.attrib == {"name": "/"}

    interface = object_node.find("./interface")
    assert interface is not None
    assert interface.attrib == {"name": "org.freeipa.server"}

    methods = {
        method.attrib["name"]: method.find("./helper").attrib
        for method in interface.findall("./method")
    }
    assert methods == {
        "create_gpo_structure": {
            "exec": (
                "/usr/libexec/ipa/oddjob/"
                "org.freeipa.server.create-gpo-structure"
            ),
            "arguments": "3",
            "prepend_user_name": "no",
            "argument_passing_method": "cmdline",
        },
        "delete_gpo_structure": {
            "exec": (
                "/usr/libexec/ipa/oddjob/"
                "org.freeipa.server.delete-gpo-structure"
            ),
            "arguments": "2",
            "prepend_user_name": "no",
            "argument_passing_method": "cmdline",
        },
    }
