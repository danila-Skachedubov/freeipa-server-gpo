"""Exercise publication failures without credentials or registry mutations."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = b"isolated RPM fixture\n"


@pytest.fixture
def publisher(tmp_path):
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    package = artifact / "freeipa-server-gpo-0.1.1-alt1.x86_64.rpm"
    package.write_bytes(PAYLOAD)
    commands = tmp_path / "commands"
    commands.mkdir()
    rpm = commands / "rpm"
    rpm.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "print(os.environ.get('RPM_METADATA', 'freeipa-server-gpo 0.1.1 alt1 x86_64'))\n"
    )
    rpm.chmod(0o755)
    curl = commands / "curl"
    curl.write_text(
        f"#!{sys.executable}\n" + '''
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
with open(os.environ["CURL_CALLS"], "a") as stream:
    stream.write(json.dumps(args) + "\\n")
upload = "--upload-file" in args
code = os.environ.get("UPLOAD_STATUS" if upload else "DOWNLOAD_STATUS", "201" if upload else "200")
if not upload and code == "200":
    Path(args[args.index("--output") + 1]).write_bytes(
        b"corrupted" if os.environ.get("CORRUPT_DOWNLOAD") else b"isolated RPM fixture\\n"
    )
sys.stdout.write(code)
if os.environ.get("NETWORK_FAILURE"):
    sys.exit(7)
# Model curl's HTTP error contract: omitting --fail would return success.
if int(code) >= 400 and ("--fail-with-body" in args or "--fail" in args):
    sys.exit(22)
'''
    )
    curl.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    env = os.environ.copy()
    env.update(
        PATH=f"{commands}{os.pathsep}{env['PATH']}",
        PACKAGE_TOKEN="dummy-token-not-a-real-secret",
        PACKAGE_SERVER="https://packages.example",
        PACKAGE_OWNER="test-owner",
        PACKAGE_GROUP="freeipa-server-gpo-test",
        EXPECTED_SHA256=hashlib.sha256(PAYLOAD).hexdigest(),
        CURL_CALLS=str(calls),
    )

    def run(**overrides):
        result = subprocess.run(
            ["bash", str(ROOT / "ci/publish-rpm.sh"), str(artifact)],
            env={**env, **overrides}, capture_output=True, text=True,
            timeout=15,
        )
        assert env["PACKAGE_TOKEN"] not in result.stdout + result.stderr
        requests = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        return result, requests

    return run, artifact


@pytest.mark.parametrize("group", ["freeipa-server-gpo", "freeipa-server-gpo-test"])
def test_publish_verifies_downloaded_bytes(publisher, group):
    run, _ = publisher
    result, calls = run(PACKAGE_GROUP=group)
    assert result.returncode == 0, result.stderr
    assert len(calls) == 2
    assert calls[0][-1] == f"https://packages.example/api/packages/test-owner/alt/group/{group}/upload"
    assert calls[1][-1] == f"https://packages.example/api/packages/test-owner/alt/group/{group}.repo/x86_64/RPMS.classic/freeipa-server-gpo-0.1.1-alt1.x86_64.rpm"
    assert "Published and verified" in result.stdout


@pytest.mark.parametrize("status", ["200", "302", "400", "401", "403", "409", "500"])
def test_upload_rejection_never_reports_success_or_retries(publisher, status):
    run, _ = publisher
    result, calls = run(UPLOAD_STATUS=status)
    assert result.returncode != 0
    assert len(calls) == 1
    assert status in result.stderr
    assert "Published and verified" not in result.stdout


@pytest.mark.parametrize("overrides", [
    {"DOWNLOAD_STATUS": "404"},
    {"DOWNLOAD_STATUS": "302"},
    {"CORRUPT_DOWNLOAD": "1"},
])
def test_download_failure_or_mismatch_fails_publication(publisher, overrides):
    run, _ = publisher
    result, calls = run(**overrides)
    assert result.returncode != 0
    assert len(calls) == 2
    assert "Published and verified" not in result.stdout


def test_network_failure_is_not_success(publisher):
    run, _ = publisher
    result, calls = run(NETWORK_FAILURE="1", UPLOAD_STATUS="000")
    assert result.returncode != 0
    assert len(calls) == 1


@pytest.mark.parametrize("count", [0, 2])
def test_missing_or_ambiguous_artifact_never_uploads(publisher, count):
    run, artifact = publisher
    if count == 0:
        next(artifact.iterdir()).unlink()
    else:
        (artifact / "unexpected.rpm").write_bytes(PAYLOAD)
    result, calls = run()
    assert result.returncode != 0
    assert not calls


def test_publisher_does_not_require_dev_fd():
    source = (ROOT / "ci/publish-rpm.sh").read_text()
    assert "< <(" not in source


@pytest.mark.parametrize("overrides", [
    {"PACKAGE_TOKEN": ""},
    {"EXPECTED_SHA256": ""},
    {"EXPECTED_SHA256": "0" * 64},
    {"PACKAGE_GROUP": "unintended-group"},
    {"PACKAGE_SERVER": "http://packages.example"},
    {"RPM_METADATA": "other-package 0.1.1 alt1 x86_64"},
    {"RPM_METADATA": "freeipa-server-gpo 0.1.1 alt1 src"},
])
def test_invalid_publication_inputs_never_upload(publisher, overrides):
    run, _ = publisher
    result, calls = run(**overrides)
    assert result.returncode != 0
    assert not calls


@pytest.mark.parametrize("test_body,required,expected", [
    ("assert True", "1", 0),
    ("assert False", "1", 1),
    ("pytest.skip('disabled')", "1", 1),
    ("pytest.xfail('not ready')", "1", 1),
    ("pytest.skip('local opt-out')", "0", 0),
])
def test_integration_gate_requires_executed_tests(tmp_path, test_body, required, expected):
    (tmp_path / "conftest.py").write_bytes(
        (ROOT / "tests/integration/conftest.py").read_bytes()
    )
    (tmp_path / "test_sample.py").write_text(
        f"import pytest\ndef test_sample():\n    {test_body}\n"
    )
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", str(tmp_path)],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
        env={**os.environ, "FREEIPA_GPO_REQUIRE_TESTS": required,
             "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTEST_ADDOPTS": ""},
    )
    assert result.returncode == expected, result.stdout + result.stderr
