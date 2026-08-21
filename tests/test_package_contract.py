"""Static and command-line contracts for the package version."""

import os
import re
import subprocess
import sys
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
