#!/usr/bin/env bash
# Publish exactly the artifact checked by integration; never overwrite a version.
set +x
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ $# -eq 1 && -d "$1" ]] || fail 'Usage: publish-rpm.sh ARTIFACT_DIRECTORY'
: "${PACKAGE_TOKEN:?PACKAGE_TOKEN is required}"
: "${PACKAGE_SERVER:?PACKAGE_SERVER is required}"
: "${PACKAGE_OWNER:?PACKAGE_OWNER is required}"
: "${PACKAGE_GROUP:?PACKAGE_GROUP is required}"
[[ ${EXPECTED_SHA256:-} =~ ^[a-f0-9]{64}$ ]] || fail 'Expected artifact SHA256 is missing or invalid'
[[ $PACKAGE_SERVER =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]] || fail 'Expected an HTTPS Forgejo origin'
[[ $PACKAGE_OWNER =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'Invalid package owner'
case "$PACKAGE_GROUP" in
    freeipa-server-gpo|freeipa-server-gpo-test) ;;
    *) fail 'Unexpected package group' ;;
esac

package_list=$(mktemp)
trap 'rm -f -- "$package_list"' EXIT
find "$1" -type f -name '*.rpm' -print0 > "$package_list"
mapfile -d '' -t packages < "$package_list"
rm -f -- "$package_list"
trap - EXIT
[[ ${#packages[@]} -eq 1 ]] || fail "Expected exactly one RPM, found ${#packages[@]}"
package=${packages[0]}
digest=$(sha256sum "$package")
[[ ${digest%% *} == "$EXPECTED_SHA256" ]] || fail 'RPM differs from the build artifact'

metadata=$(rpm -qp --queryformat '%{NAME} %{VERSION} %{RELEASE} %{ARCH}' "$package")
read -r name version release architecture <<< "$metadata"
[[ $name == freeipa-server-gpo ]] || fail 'Unexpected RPM package name'
[[ $architecture == x86_64 ]] || fail 'Expected the x86_64 RPM tested by CI'
[[ $version =~ ^[a-zA-Z0-9._+~-]+$ && $release =~ ^[a-zA-Z0-9._+~]+$ ]] || fail 'Invalid RPM version/release'
filename="$name-$version-$release.$architecture.rpm"
registry="${PACKAGE_SERVER%/}/api/packages/$PACKAGE_OWNER/alt/group/$PACKAGE_GROUP"

# Do not echo credentials, response bodies, or retry an ambiguous PUT. A 409
# fails explicitly: an existing release is never deleted or silently replaced.
http_status=$(curl -q --silent --show-error --fail-with-body \
    --proto '=https' --connect-timeout 15 --max-time 180 \
    --user "$PACKAGE_OWNER:$PACKAGE_TOKEN" \
    --upload-file "$package" --output /dev/null --write-out '%{http_code}' \
    "$registry/upload") || fail "RPM upload failed (HTTP ${http_status:-unknown})"
[[ $http_status == 201 ]] || fail "Unexpected upload status: $http_status (expected 201)"

# A successful PUT must result in the very same bytes being downloadable.
verification_dir=$(mktemp -d)
trap 'rm -f -- "$verification_dir/package.rpm"; rmdir -- "$verification_dir"' EXIT
http_status=$(curl -q --silent --show-error --fail-with-body \
    --proto '=https' --connect-timeout 15 --max-time 180 \
    --user "$PACKAGE_OWNER:$PACKAGE_TOKEN" \
    --output "$verification_dir/package.rpm" --write-out '%{http_code}' \
    "$registry.repo/$architecture/RPMS.classic/$filename") \
    || fail "Published RPM verification failed (HTTP ${http_status:-unknown}); inspect the registry before retrying"
[[ $http_status == 200 ]] || fail "Unexpected download status: $http_status (expected 200)"
digest=$(sha256sum "$verification_dir/package.rpm")
[[ ${digest%% *} == "$EXPECTED_SHA256" ]] || fail 'Published RPM checksum does not match the tested artifact'
printf 'Published and verified %s in %s (SHA256 %s)\n' "$filename" "$PACKAGE_GROUP" "$EXPECTED_SHA256"
