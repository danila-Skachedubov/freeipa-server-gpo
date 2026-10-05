"""Real native/background refresh checks using isolated, disposable sources."""

import importlib.util
import os
from pathlib import Path
import threading
import time

import pytest


admix = pytest.importorskip('admix')
MODULE_PATH = (
    Path(__file__).resolve().parents[1] / 'plugin/ipaserver/plugins/gpo.py'
)
SPEC = importlib.util.spec_from_file_location('gpo_live_catalog_under_test', MODULE_PATH)
GPO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GPO)


def definition(prefix='demo', namespace='Catalog.Live.Demo'):
    return f'''<policyDefinitions revision="1.0" schemaVersion="1.0"
      xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
      <policyNamespaces><target prefix="{prefix}" namespace="{namespace}" /></policyNamespaces>
      <resources minRequiredRevision="1.0" />
      <supportedOn><definitions><definition name="Supported" displayName="Supported" /></definitions></supportedOn>
      <categories><category name="Root" displayName="$(string.Root)" /></categories>
      <policies><policy name="Policy" class="Both" displayName="$(string.Policy)"
          key="Software\\CatalogTest" valueName="Enabled">
        <parentCategory ref="Root" /><supportedOn ref="Supported" />
        <enabledValue><decimal value="1" /></enabledValue>
        <disabledValue><decimal value="0" /></disabledValue>
      </policy></policies>
    </policyDefinitions>'''


def resources(title='Before'):
    return f'''<policyDefinitionResources revision="1.0" schemaVersion="1.0"
      xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
      <resources><stringTable><string id="Root">{title}</string>
        <string id="Policy">{title} policy</string></stringTable>
        <presentationTable /></resources>
    </policyDefinitionResources>'''


def await_state(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    tick = threading.Event()
    while time.monotonic() < deadline:
        try:
            _catalog, state = GPO._get_catalog(admix)
        except GPO.EditorFailure:
            state = None
        if state is not None and predicate(state):
            return state
        tick.wait(0.005)
    pytest.fail('Background catalog state did not converge within the bounded wait')


@pytest.fixture
def sources(tmp_path, monkeypatch):
    GPO._reset_editor_globals_for_tests()
    root = tmp_path / 'definitions'
    root.mkdir()
    locale = root / 'en-US'
    locale.mkdir()
    monkeypatch.setattr(GPO, 'GPO_TEMPLATE_ROOT', root)
    monkeypatch.setattr(GPO, 'GPO_CATALOG_REFRESH_INTERVAL', 0.02)
    yield root, locale, tmp_path
    GPO._reset_editor_globals_for_tests()


def open_workspace(catalog, root):
    root.mkdir(exist_ok=True)
    return admix.GroupPolicyWorkspace(
        str(root), template_catalog=catalog, locales=['en-US'],
        load_preferences=False,
    )


def test_background_detects_added_replaced_and_removed_admx(sources):
    root, locale, temporary = sources
    (root / 'demo.admx').write_text(definition(), encoding='utf-8')
    (locale / 'demo.adml').write_text(resources(), encoding='utf-8')
    GPO._start_catalog_monitor(admix)
    catalog, initial = GPO._get_catalog(admix)
    pinned = open_workspace(catalog, temporary / 'gpo')

    extra = root / 'extra.admx'
    extra.write_text(definition('other', 'Catalog.Live.Extra'), encoding='utf-8')
    added = await_state(lambda state: state['generation']['number'] > 1)
    fresh = open_workspace(catalog, temporary / 'gpo')
    assert len(fresh.list_policies('computer', None, ['en-US'])) == 2
    assert len(pinned.list_policies('computer', None, ['en-US'])) == 1

    replacement = root / 'replacement.pending'
    replacement.write_text(definition('newer', 'Catalog.Live.Newer'), encoding='utf-8')
    replacement.replace(extra)
    replaced = await_state(
        lambda state: state['generation']['number'] > added['generation']['number']
    )
    assert replaced['generation']['content_fingerprint'] != added['generation']['content_fingerprint']

    extra.unlink()
    removed = await_state(
        lambda state: state['generation']['number'] > replaced['generation']['number']
    )
    assert len(open_workspace(catalog, temporary / 'gpo').list_policies('computer', None, ['en-US'])) == 1
    assert pinned.template_generation() == initial['generation']
    assert removed['refresh']['failure'] is None


def test_background_detects_same_size_adml_edit_with_restored_mtime(sources):
    root, locale, temporary = sources
    (root / 'demo.admx').write_text(definition(), encoding='utf-8')
    resource = locale / 'demo.adml'
    resource.write_text(resources('Before'), encoding='utf-8')
    GPO._start_catalog_monitor(admix)
    catalog, initial = GPO._get_catalog(admix)
    pinned = open_workspace(catalog, temporary / 'gpo')
    before = resource.stat()

    resource.write_text(resources('After!'), encoding='utf-8')
    os.utime(resource, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert resource.stat().st_size == before.st_size
    current = await_state(lambda state: state['generation']['number'] > 1)

    assert current['generation']['content_fingerprint'] != initial['generation']['content_fingerprint']
    assert pinned.list_policies('computer', None, ['en-US'])[0]['label'] == 'Before'
    fresh = open_workspace(catalog, temporary / 'gpo')
    assert fresh.list_policies('computer', None, ['en-US'])[0]['label'] == 'After!'


def test_background_retries_unusable_update_without_losing_last_good(sources):
    root, locale, temporary = sources
    source = root / 'demo.admx'
    source.write_text(definition(), encoding='utf-8')
    (locale / 'demo.adml').write_text(resources(), encoding='utf-8')
    GPO._start_catalog_monitor(admix)
    catalog, initial = GPO._get_catalog(admix)

    source.write_text('not XML', encoding='utf-8')
    failed = await_state(
        lambda state: state['refresh'] is not None and state['refresh']['status'] == 'failed'
    )
    assert failed['generation'] == initial['generation']
    assert str(root) not in str(failed)
    assert len(open_workspace(catalog, temporary / 'gpo').list_policies('computer', None, ['en-US'])) == 1

    source.write_text(definition().replace('name="Policy"', 'name="Repaired"'), encoding='utf-8')
    repaired = await_state(lambda state: state['generation']['number'] > 1)
    assert repaired['refresh']['failure'] is None


def test_background_recovers_sources_installed_after_failed_preload(sources):
    root, locale, _temporary = sources
    GPO._start_catalog_monitor(admix)
    with pytest.raises(GPO.EditorFailure):
        GPO._get_catalog(admix)

    (root / 'demo.admx').write_text(definition(), encoding='utf-8')
    (locale / 'demo.adml').write_text(resources(), encoding='utf-8')
    recovered = await_state(lambda state: state['generation']['number'] == 1)
    assert recovered['generation']['loaded_locales'] == ['en-US']
