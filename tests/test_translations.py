"""Translation catalog contract tests for the installer."""

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "locale/ru/LC_MESSAGES/ipa-gpo-install.po"


def test_russian_catalog_covers_all_installer_messages(tmp_path):
    template = tmp_path / "ipa-gpo-install.pot"
    sources = sorted((ROOT / "ipa_gpo_install").glob("*.py"))
    sources.append(ROOT / "bin/ipa-gpo-install")

    subprocess.run(
        [
            "xgettext",
            "--language=Python",
            "--from-code=UTF-8",
            "--keyword=_",
            "--sort-output",
            f"--output={template}",
            *(str(path) for path in sources),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["msgfmt", "--check", "--output-file=/dev/null", str(CATALOG)],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["msgcmp", str(CATALOG), str(template)],
        check=True,
        capture_output=True,
        text=True,
    )

