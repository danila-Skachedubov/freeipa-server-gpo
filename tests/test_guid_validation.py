"""Tests for the shared GPO GUID validator used by oddjob handlers."""

import pytest

from ipa_gpo_install.config import is_valid_guid


@pytest.mark.parametrize(
    "guid",
    [
        "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}",
        "{a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d}",
        "{A2b3C4d5-E6f7-4A8B-9C0D-1E2F3A4B5C6D}",
    ],
)
def test_valid_guid(guid):
    assert is_valid_guid(guid) is True


@pytest.mark.parametrize(
    "guid",
    [
        "A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D",
        "{A2B3C4D5E6F74A8B9C0D1E2F3A4B5C6D}",
        "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F}",
        "",
        "{}",
        "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}extra",
        "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D }",
        " {A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}",
        "{A2B3C4D5-E6F7-4A8B-9C0D-1E2F3A4B5C6D}\n",
    ],
)
def test_invalid_guid(guid):
    assert is_valid_guid(guid) is False


@pytest.mark.parametrize("guid", [None, 123, object()])
def test_non_string_guid_is_invalid(guid):
    assert is_valid_guid(guid) is False
