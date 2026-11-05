"""Device credential resolution: fails closed, never logs the secret."""

import os

import pytest

from provian.device import DeviceCredentials, load_device_credentials
from provian.exceptions import ProvianError

from .conftest import TEST_CREDENTIAL, TEST_KEY, TEST_SECRET


def _write_private(path, text):
    """What register-device writes: a 0600 regular file (the loader ignores anything looser)."""
    path.write_text(text)
    os.chmod(path, 0o600)


def test_explicit_credential_wins():
    creds = load_device_credentials(TEST_CREDENTIAL, "https://r.test/", environ={})
    assert (creds.device_key, creds.device_secret, creds.relay_url) == (TEST_KEY, TEST_SECRET, "https://r.test")


def test_env_alone_then_file_alone(tmp_path):
    env = {"PROVIAN_DEVICE_KEY": TEST_KEY, "PROVIAN_DEVICE_SECRET": TEST_SECRET, "PROVIAN_RELAY_URL": "https://e.test"}
    creds = load_device_credentials(environ=env, credentials_path=str(tmp_path / "none"))
    assert creds.relay_url == "https://e.test"

    path = tmp_path / "credentials"
    _write_private(path, 
        "# written by register-device\n"
        "export PROVIAN_DEVICE_KEY=\"%s\"\nPROVIAN_DEVICE_SECRET='%s'\nPROVIAN_RELAY_URL=https://f.test\n"
        % (TEST_KEY, TEST_SECRET)
    )
    creds = load_device_credentials(environ={}, credentials_path=str(path))
    assert (creds.device_key, creds.device_secret, creds.relay_url) == (TEST_KEY, TEST_SECRET, "https://f.test")


def test_file_before_env_as_the_ts_sdk_orders_it(tmp_path):
    path = tmp_path / "credentials"
    _write_private(path, "PROVIAN_DEVICE_KEY=%s\nPROVIAN_DEVICE_SECRET=%s\n" % (TEST_KEY, TEST_SECRET))
    other_key, other_secret = "pdk_" + "e" * 32, "pds_" + "f" * 64
    env = {"PROVIAN_DEVICE_KEY": other_key, "PROVIAN_DEVICE_SECRET": other_secret}
    creds = load_device_credentials(environ=env, credentials_path=str(path))
    assert (creds.device_key, creds.device_secret) == (TEST_KEY, TEST_SECRET)


def test_key_and_secret_always_come_from_one_source(tmp_path):
    """A half credential in one source is never paired with the other source's half (a sure 401)."""
    other_key, other_secret = "pdk_" + "e" * 32, "pds_" + "f" * 64
    half_file = tmp_path / "credentials"
    _write_private(half_file, "PROVIAN_DEVICE_KEY=%s\n" % TEST_KEY)
    # half file + full env -> the env pair, never file key + env secret
    creds = load_device_credentials(
        environ={"PROVIAN_DEVICE_KEY": other_key, "PROVIAN_DEVICE_SECRET": other_secret},
        credentials_path=str(half_file),
    )
    assert (creds.device_key, creds.device_secret) == (other_key, other_secret)
    # full file + half env -> the file pair
    full_file = tmp_path / "full"
    _write_private(full_file, "PROVIAN_DEVICE_KEY=%s\nPROVIAN_DEVICE_SECRET=%s\n" % (TEST_KEY, TEST_SECRET))
    creds = load_device_credentials(environ={"PROVIAN_DEVICE_KEY": other_key}, credentials_path=str(full_file))
    assert (creds.device_key, creds.device_secret) == (TEST_KEY, TEST_SECRET)
    # RED: half file + the other half in env -> refused, not mixed
    with pytest.raises(ProvianError) as err:
        load_device_credentials(environ={"PROVIAN_DEVICE_SECRET": other_secret}, credentials_path=str(half_file))
    assert err.value.code == "DEVICE_CREDENTIALS_REQUIRED"


def test_missing_credentials_fail_closed(tmp_path):
    with pytest.raises(ProvianError) as err:
        load_device_credentials(environ={}, credentials_path=str(tmp_path / "missing"))
    assert err.value.code == "DEVICE_CREDENTIALS_REQUIRED"


def test_malformed_credentials_are_refused():
    with pytest.raises(ProvianError):
        DeviceCredentials("abc", "def")
    with pytest.raises(ProvianError):
        DeviceCredentials.parse("my-agent")


def test_repr_never_shows_the_secret():
    creds = DeviceCredentials(TEST_KEY, TEST_SECRET)
    assert TEST_SECRET not in repr(creds)


def test_a_credentials_file_readable_by_others_is_ignored_like_the_ts_sdk_ignores_it(tmp_path):
    path = tmp_path / "credentials"
    path.write_text("PROVIAN_DEVICE_KEY=%s\nPROVIAN_DEVICE_SECRET=%s\n" % (TEST_KEY, TEST_SECRET))
    os.chmod(path, 0o644)
    # RED control (2026-10-17): the loader took the file whatever its mode.
    with pytest.raises(ProvianError) as err:
        load_device_credentials(environ={}, credentials_path=str(path))
    assert err.value.code == "DEVICE_CREDENTIALS_REQUIRED"
    assert "readable by other users" in str(err.value)
    # ...and the env pair still wins when the file is ignored.
    creds = load_device_credentials(
        environ={"PROVIAN_DEVICE_KEY": TEST_KEY, "PROVIAN_DEVICE_SECRET": TEST_SECRET}, credentials_path=str(path)
    )
    assert creds.device_key == TEST_KEY
    os.chmod(path, 0o600)
    creds = load_device_credentials(environ={}, credentials_path=str(path))
    assert (creds.device_key, creds.device_secret) == (TEST_KEY, TEST_SECRET)


def test_a_symlinked_credentials_file_is_ignored(tmp_path):
    target = tmp_path / "real"
    _write_private(target, "PROVIAN_DEVICE_KEY=%s\nPROVIAN_DEVICE_SECRET=%s\n" % (TEST_KEY, TEST_SECRET))
    link = tmp_path / "credentials"
    os.symlink(str(target), str(link))
    with pytest.raises(ProvianError):
        load_device_credentials(environ={}, credentials_path=str(link))
