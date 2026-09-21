# RPM release gate

`.forgejo/workflows/python-backend.yml` owns the complete pipeline:

1. Build one Sisyphus x86_64 RPM, including `%check` and Python coverage.
2. Save it as `alt-packages` and expose its SHA256 as a build job output.
3. Install that artifact in a disposable FreeIPA domain and run the live suite.
4. Only after successful integration, publish the same artifact when requested.

Integration verifies the build checksum before installation. Publication runs
in a separate job, verifies the same checksum, requires HTTP 201 from the ALT
registry, downloads the published RPM, and compares the bytes by SHA256.
There is no second RPM build between testing and publication.

## Triggers

| Event | Build/unit tests | Integration | Packages |
| --- | --- | --- | --- |
| Pull request | Yes | No | No |
| Push to another branch | Yes | No | No |
| Push to `master` or `ci/integration-container-probe` | Yes | Yes | No |
| Push of a matching `*-alt*` tag | Yes | Yes | Release group |
| Manual run, default inputs | Yes | Yes | No |
| Manual run, `publish_test_package=true` | Yes | Yes | Test group |

Release tags must match both the spec's `Version-Release` and the built RPM's
version/release. Existing package versions are never deleted or overwritten;
HTTP 409 fails the publication job. After an ambiguous network failure or a
download verification failure, inspect the registry before retrying: the PUT
may already have succeeded.

The package token is passed only to the publication step, through the
`PACKAGE_TOKEN` secret. The integration job does not need that secret.
Privileged integration is intentionally not enabled for pull requests.

## Checking changes

Run `python3 -m pytest tests/test_ci_publication.py` for publication failure
handling and the integration skip guard. These tests use fake RPM/curl tools
and never upload packages. Push the CI branch to check the real build/domain
pipeline. To verify the registry itself, run this workflow manually with the
test publication input enabled, using a package version absent from that group.
Do not create a release tag just to test CI.

CI sets `FREEIPA_GPO_REQUIRE_TESTS=1`: a zero-success, skipped, or xfailed live
suite cannot satisfy the release gate. Local integration remains opt-in.

## Limits

Passing this gate currently proves server-side CRUD and publication in the
tested Sisyphus environment. It does not prove client `gpupdate` application,
SMB availability, upgrades from old packages, or the editor's full RPC/role
permission matrix. Most editor tests still use local root LDAPI and temporary
state directories. Those checks and runner/dependency hardening remain separate
follow-up work.
