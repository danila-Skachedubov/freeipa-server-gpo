'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');
const cache = new Map();
function load(file) {
    file = path.posix.normalize(file);
    if (cache.has(file)) return cache.get(file);
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), {
        define: (dependencies, factory) => {
            result = factory(...dependencies.map(name => load(path.posix.join(path.posix.dirname(file), name + '.js'))));
        }
    }, { filename: file });
    cache.set(file, result);
    return result;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
const presentation = load('components/templates/preference/targeting-presentations.js');
const operandEditor = load('components/templates/preference/targeting-operand-editor.js');

const probe = spawnSync(process.env.PYTHON || 'python3', ['-c', 'from admix import _native; print(_native.__file__)'], { encoding: 'utf8' });
const skip = probe.error && probe.error.code === 'ENOENT' || /ModuleNotFoundError/.test(probe.stderr || '')
    ? 'Optional installed admix native binding is unavailable.' : false;

// This is an isolated format-contract check, not a server integration test.
// Every writable path is beneath a fresh TemporaryDirectory; no SYSVOL,
// installed configuration, real GPO or authentication context is consulted.
const python = String.raw`
import json
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from admix import _native

request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="gpo-targeting-native-") as temporary:
    root = Path(temporary)
    gpo = root / "gpo"
    (gpo / "Machine" / "Preferences" / "IniFiles").mkdir(parents=True)
    (gpo / "User").mkdir()
    (gpo / "GPT.INI").write_text("[General]\nVersion=0\n", encoding="utf-8")
    destination = gpo / "Machine" / "Preferences" / "IniFiles" / "IniFiles.xml"
    initial = '''<?xml version="1.0" encoding="utf-8"?>
<IniFiles clsid="{694C651A-08F2-47fa-A427-34C4F62BA207}">
  <Ini clsid="{EEFACE84-D3D8-4680-8D4B-BF103E759448}" name="Targeting contract" uid="{11111111-1111-1111-1111-111111111111}">
    <Properties path="%SystemDir%" section="TEST" property="VALUE" value="isolated" action="U" />
    <Filters>
      <FilterLanguage bool="AND" not="0" language="200" locale="77" default="1" displayName="Imported language" />
      <FilterTime bool="OR" not="1" begin="23:45:12.500+03:00" end="01:15:00+03:00" />
    </Filters>
  </Ini>
</IniFiles>'''
    destination.write_text(initial, encoding="utf-8")
    def open_workspace():
        return _native.GroupPolicyWorkspace(str(gpo), locales=["en-US"],
            state_directory=str(root / "state"), state_key="isolated-targeting-contract")
    workspace = open_workspace()
    kinds = workspace.preference_filter_kinds()
    inventory = {entry["kind"]: workspace.get_new_preference_filter_fields(entry["kind"]) for entry in kinds}
    identity = workspace.list_preference_items("computer", "ini_files")[0]["identity"]
    originals = [workspace.get_preference_filter_fields("computer", "ini_files", identity, [index]) for index in range(2)]
    if request["action"] == "inventory":
        result = {"kinds": kinds, "fields": inventory, "originals": originals, "native": _native.__file__}
    else:
        cases = request["cases"]
        for index, case in enumerate(cases, start=2):
            workspace.insert_preference_filter("computer", "ini_files", identity, [], index, case["kind"], case["fields"])
        expected_count = len(cases) + 2
        rejected = []
        for case in request.get("invalid", []):
            before = workspace.list_preference_filters("computer", "ini_files", identity)
            try:
                workspace.insert_preference_filter("computer", "ini_files", identity, [], expected_count, case["kind"], case["fields"])
            except Exception as error:
                rejected.append({"name": case["name"], "error": str(error)})
            else:
                raise AssertionError("native accepted invalid case: " + case["name"])
            assert workspace.list_preference_filters("computer", "ini_files", identity) == before
        assert destination.read_text(encoding="utf-8") == initial, "draft mutations must not publish early"
        workspace.commit_offline()
        reopened = open_workspace()
        rows = []
        for index, case in enumerate(cases, start=2):
            fields = reopened.get_preference_filter_fields("computer", "ini_files", identity, [index])
            rows.append({"name": case["name"], "kind": case["kind"], "values": {field["id"]: field["value"] for field in fields}})
        xml = ET.fromstring(destination.read_text(encoding="utf-8"))
        filters = xml.find("Ini/Filters")
        result = {"rows": rows, "rejected": rejected,
            "originals": [reopened.get_preference_filter_fields("computer", "ini_files", identity, [index]) for index in range(2)],
            "original_attributes": [dict(filters[index].attrib) for index in range(2)],
            "serialized_attributes": [dict(filters[index].attrib) for index in range(2, len(cases) + 2)],
            "gpt": (gpo / "GPT.INI").read_text(encoding="utf-8"),
            "filter_count": len(reopened.list_preference_filters("computer", "ini_files", identity))}
    print(json.dumps(result, ensure_ascii=False))
`;

function native(request) {
    if (probe.error || probe.status !== 0) assert.fail('Installed native probe failed: ' + (probe.error || probe.stderr));
    const execution = spawnSync(process.env.PYTHON || 'python3', ['-c', python], {
        input: JSON.stringify(request), encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024
    });
    assert.equal(execution.error, undefined, String(execution.error));
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    return JSON.parse(execution.stdout);
}
let inventory;
function currentInventory() {
    if (!inventory) inventory = native({ action: 'inventory' });
    return inventory;
}

const representatives = {
    battery: {},
    computer: { type: 'NETBIOS', name: 'CLIENT' },
    cpu: { speedMHz: '2000' },
    date: { period: 'WEEKLY', dow: 'MON', day: 15, month: 6, year: '2026' },
    disk: { drive: 'System', freeSpace: 100 },
    domain: { name: 'EXAMPLE', userContext: true },
    dun: { type: '' },
    file: { path: '%SystemRoot%\\example.exe', type: 'EXISTS', folder: false, min: '1.0.0.0', max: '2.0.0.0', gte: true, lte: false },
    ip_range: { min: '10.0.0.1', max: '10.0.0.254' },
    language: { languageLocale: 'ru-RU', default: true, system: false, native: false, displayName: 'Русский (Россия)' },
    ldap: { binding: 'LDAP://DC=example,DC=test', searchFilter: '(objectClass=computer)', variableName: 'LDAP_RESULT', attribute: 'cn' },
    mac_range: { min: '00:11:22:33:44:55', max: '00:11:22:33:44:66' },
    msi: { type: 'PRODUCT', subtype: 'EXISTS', code: '{01234567-89AB-CDEF-0123-456789ABCDEF}', item: 'ProductName', value: 'Example', min: '1.0.0.0', max: '2.0.0.0', gte: true, lte: true },
    org_unit: { name: 'OU=Clients,DC=example,DC=test', userContext: false, directMember: true },
    pcmcia: {},
    portable: { unknown: true, docked: false, undocked: true },
    proc_mode: { synchFore: true, asynchFore: false, backRefr: true, forceRefr: false, linkTrns: false, noChg: false, rsopTrns: false, safeBoot: false, slowLink: false, verbLog: false, rsopEnbl: true },
    ram: { totalMB: '8192' },
    run_once: { id: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}', userContext: false, comments: 'Isolated format-contract test' },
    site: { name: 'Example-Site' },
    terminal: { type: 'NE', option: 'NE', value: '', min: '10.0.0.1', max: '10.0.0.254' },
    time: { begin: '23:45:00', end: '01:15:00' },
    user: { name: 'EXAMPLE\\User', sid: 'S-1-5-21-1-2-3-1001' },
    variable: { variableName: 'EXAMPLE_TARGET', value: 'ready' },
    os: { class: 'NT', version: 'WINTHRESHOLD', type: 'PRO', edition: 'PRO', sp: 'NE' },
    registry: { type: 'KEYEXISTS', subtype: 'EQUALHEX', valueName: 'Enabled', valueType: 'REG_DWORD', valueData: '00000001', variableName: 'REG_RESULT', key: 'Software\\Example', hive: 'HKEY_LOCAL_MACHINE', min: '1.0.0.0', max: '2.0.0.0', gte: true, lte: true, version: '1.0.0.0' },
    wmi: { query: 'SELECT * FROM Win32_ComputerSystem', nameSpace: 'root\\cimv2', property: 'Name', variableName: 'WMI_RESULT' },
    group: { name: 'EXAMPLE\\Targeted', sid: 'S-1-5-21-1-2-3-1002', userContext: false, primaryGroup: false, localGroup: false },
    collection: { name: 'Example collection' }
};
function edits(kind, overrides = {}) {
    const values = { ...representatives[kind], ...overrides };
    const fields = currentInventory().fields[kind];
    return fields.map(field => ({
        id: field.id,
        value: { ...field.value, value: Object.hasOwn(values, field.id.replace(/^filter\./, ''))
            ? values[field.id.replace(/^filter\./, '')] : field.value.value }
    }));
}
function scenario(name, kind, overrides = {}) { return { name, kind, fields: edits(kind, overrides) }; }
function initializedNode(kind, language = 'en') {
    const source = { kind, available: true, originalPath: null, fields: plain(currentInventory().fields[kind]) };
    const fields = operandEditor.initialize(source, { language, scope: 'computer' });
    // Fill actual required name/path/query operands, not each optional field;
    // this exercises the renderer's defaults rather than replacing them.
    fields.forEach(field => {
        const id = field.id.replace(/^filter\./, '');
        const empty = field.value.value === null || field.value.value === '';
        if (empty && (field.required || ['user', 'group'].includes(kind) && id === 'name') && Object.hasOwn(representatives[kind], id)) {
            field.value.value = representatives[kind][id];
        }
    });
    return { ...source, fields };
}

test('the optional native check is installed and returns matching descriptors for every presentation kind', { skip }, () => {
    const data = currentInventory();
    assert.match(data.native, /_native.*\.(?:so|pyd)$/);
    assert.deepEqual(data.kinds.map(kind => kind.kind).sort(), plain(presentation.supportedKinds).sort());
    for (const kind of presentation.supportedKinds) {
        const fields = data.fields[kind];
        assert.ok(Array.isArray(fields), kind);
        assert.equal(fields.find(field => field.id === 'filter.bool').value.kind, 'filter_combine');
        assert.equal(fields.find(field => field.id === 'filter.not').value.kind, 'boolean');
        for (const field of fields) {
            if (['filter.bool', 'filter.not', 'filter.hidden', 'filter.displayName'].includes(field.id)) continue;
            assert.notEqual(presentation.fieldLabel(kind, field.id, 'missing', 'en'), 'missing', kind + '/' + field.id);
            assert.notEqual(presentation.fieldLabel(kind, field.id, 'missing', 'ru'), 'missing', kind + '/' + field.id);
            const choices = presentation.choices(kind, field.id, 'en');
            if (choices) assert.ok(['text', 'optional_text'].includes(field.value.kind), kind + '/' + field.id + ' uses original text envelopes');
        }
    }
    const language = data.fields.language.find(field => field.id === 'filter.languageLocale');
    assert.ok(language.choices.find(choice => choice.key === 'ru-RU'));
    assert.ok(language.choices.find(choice => choice.key === 'en-US'));
    assert.equal(language.value.kind, 'text');
});

let roundtrip;
function currentRoundtrip() {
    if (roundtrip) return roundtrip;
    const data = currentInventory();
    const cases = presentation.supportedKinds.map(kind => scenario('base/' + kind, kind));
    presentation.supportedKinds.forEach(kind => cases.push({
        name: 'initialized/' + kind, kind,
        fields: plain(initializedNode(kind).fields).map(field => ({ id: field.id, value: field.value }))
    }));
    cases.push({ name: 'initialized/language-ru', kind: 'language',
        fields: plain(initializedNode('language', 'ru').fields).map(field => ({ id: field.id, value: field.value })) });
    for (const kind of presentation.supportedKinds) {
        for (const field of data.fields[kind]) {
            const choices = presentation.choices(kind, field.id, 'en');
            if (!choices) continue;
            const operand = field.id.replace(/^filter\./, '');
            choices.forEach(choice => cases.push(scenario(kind + '/' + operand + '/' + choice.key, kind, { [operand]: choice.key })));
        }
    }
    // Language keys come from native inventory rather than a second static
    // language catalog. Exercise every known key without creating Unknown.
    data.fields.language.find(field => field.id === 'filter.languageLocale').choices
        .filter(choice => choice.key !== 'unknown').forEach(choice => cases.push(scenario('language/' + choice.key, 'language', {
            languageLocale: choice.key, displayName: choice.label
        })));
    cases.push(scenario('date/annual-leap-day', 'date', { period: 'YEARLY', dow: null, day: 29, month: 2, year: null }));
    cases.push(scenario('date/concrete-leap-day', 'date', { period: 'YEARLY', dow: null, day: 29, month: 2, year: '2024' }));
    cases.push(scenario('date/monthly-31', 'date', { period: 'MONTHLY', dow: null, day: 31, month: null, year: null }));
    cases.push(scenario('time/seconds-and-zone', 'time', { begin: '23:45:12.500+03:00', end: '01:15:00+03:00' }));
    cases.push(scenario('ip_range/ipv6-compressed', 'ip_range', { useIPv6: true, min: '2001:db8::beef', max: '64' }));
    cases.push(scenario('ip_range/ipv6-expanded', 'ip_range', { useIPv6: true, min: '2001:0DB8:0000:0000:0000:0000:0000:0001', max: '128' }));
    cases.push(scenario('ip_range/ipv6-mapped', 'ip_range', { useIPv6: true, min: '::ffff:192.0.2.1', max: '0' }));
    cases.push(scenario('ip_range/ipv4-explicit-false', 'ip_range', { useIPv6: false }));
    const invalid = [
        scenario('computer/unsupported-type', 'computer', { type: 'UNKNOWN' }),
        scenario('date/unsupported-period', 'date', { period: 'DAILY' }),
        scenario('date/unsupported-weekday', 'date', { dow: 'Monday' }),
        scenario('date/month-out-of-range', 'date', { month: 13 }),
        scenario('language/unsupported-key', 'language', { languageLocale: 'not-a-locale' }),
        scenario('cpu/unsigned-short-overflow', 'cpu', { speedMHz: '65536' }),
        scenario('ram/unsigned-short-overflow', 'ram', { totalMB: '65536' }),
        scenario('disk/unsigned-byte-overflow', 'disk', { freeSpace: 256 }),
        scenario('ip_range/inverted', 'ip_range', { min: '10.0.0.2', max: '10.0.0.1' }),
        scenario('mac_range/inverted', 'mac_range', { min: '00:11:22:33:44:66', max: '00:11:22:33:44:55' }),
        scenario('registry/unsupported-hive', 'registry', { hive: 'HKEY_USER' }),
        scenario('time/minute-only-needs-adapter', 'time', { begin: '08:00' }),
        scenario('ip_range/ipv6-prefix-negative', 'ip_range', { useIPv6: true, min: '2001:db8::1', max: '-1' }),
        scenario('ip_range/ipv6-prefix-overflow', 'ip_range', { useIPv6: true, min: '2001:db8::1', max: '129' }),
        scenario('ip_range/ipv6-prefix-text', 'ip_range', { useIPv6: true, min: '2001:db8::1', max: '64x' }),
        scenario('ip_range/ipv6-malformed-address', 'ip_range', { useIPv6: true, min: '2001:::1', max: '64' })
    ];
    roundtrip = { cases, invalid, result: native({ action: 'roundtrip', cases, invalid }) };
    return roundtrip;
}

test('all 29 kinds and every advertised presentation/native-language enum roundtrip with original typed envelopes', { skip }, () => {
    const { cases, result } = currentRoundtrip();
    assert.equal(result.rows.length, cases.length);
    assert.equal(result.filter_count, cases.length + 2);
    cases.forEach((scenario, index) => {
        const row = result.rows[index];
        assert.equal(row.name, scenario.name);
        assert.equal(row.kind, scenario.kind);
        scenario.fields.forEach(field => assert.deepEqual(row.values[field.id], field.value, scenario.name + '/' + field.id));
    });
    assert.match(result.gpt, /Version=1\b/, 'the entire temporary draft is published only once');
});

test('Date recurrence omissions and Time seconds/timezones retain the intended XML encoding', { skip }, () => {
    const { cases, result } = currentRoundtrip();
    function attributes(name) { return result.serialized_attributes[cases.findIndex(scenario => scenario.name === name)]; }
    const annual = attributes('date/annual-leap-day');
    assert.equal(annual.period, 'YEARLY');
    assert.equal(annual.day, '29');
    assert.equal(annual.month, '2');
    assert.equal(annual.year, undefined);
    assert.equal(annual.dow, undefined);
    assert.equal(attributes('date/concrete-leap-day').year, '2024');
    assert.deepEqual(Object.keys(attributes('date/monthly-31')).sort(), ['bool', 'day', 'not', 'period']);
    assert.equal(attributes('time/seconds-and-zone').begin, '23:45:12.500+03:00');
    assert.equal(attributes('time/seconds-and-zone').end, '01:15:00+03:00');
    assert.equal(attributes('base/time').begin, '23:45:00');
    assert.equal(attributes('base/time').end, '01:15:00', 'overnight ranges remain valid');
});

test('broken imported Language and original second-level Time data are not normalized during draft roundtrip', { skip }, () => {
    const original = currentInventory().originals;
    const { result } = currentRoundtrip();
    assert.deepEqual(result.originals, original);
    assert.equal(result.original_attributes[0].language, '200');
    assert.equal(result.original_attributes[0].locale, '77');
    assert.equal(result.original_attributes[0].displayName, 'Imported language');
    assert.equal(result.originals[0].find(field => field.id === 'filter.languageLocale').value.value, 'unknown');
    assert.equal(result.original_attributes[1].begin, '23:45:12.500+03:00');
    assert.equal(result.original_attributes[1].bool, 'OR');
    assert.equal(result.original_attributes[1].not, '1');
});

test('IPv6 targeting keeps its address/prefix semantics and legacy IPv4 omits the new optional attribute', { skip }, () => {
    const { cases, result } = currentRoundtrip();
    const attributes = name => result.serialized_attributes[cases.findIndex(scenario => scenario.name === name)];
    assert.equal(currentInventory().fields.ip_range.find(field => field.id === 'filter.useIPv6').value.kind, 'optional_boolean');
    assert.equal(attributes('base/ip_range').useIPv6, undefined);
    assert.equal(attributes('ip_range/ipv4-explicit-false').useIPv6, '0');
    assert.equal(attributes('ip_range/ipv6-compressed').useIPv6, '1');
    assert.equal(attributes('ip_range/ipv6-compressed').min, '2001:db8::beef');
    assert.equal(attributes('ip_range/ipv6-compressed').max, '64');
    assert.equal(attributes('ip_range/ipv6-expanded').min, '2001:0DB8:0000:0000:0000:0000:0000:0001');
    assert.equal(attributes('ip_range/ipv6-expanded').max, '128');
    assert.equal(attributes('ip_range/ipv6-mapped').min, '::ffff:192.0.2.1');
    assert.equal(attributes('ip_range/ipv6-mapped').max, '0');
});

test('the installed native rejects unsupported tokens and numeric/range/time violations without altering the draft', { skip }, () => {
    const { invalid, result } = currentRoundtrip();
    assert.deepEqual(result.rejected.map(scenario => scenario.name), invalid.map(scenario => scenario.name));
    assert.ok(result.rejected.every(scenario => scenario.error.length > 0));
});

test('renderer defaults and representative active operands validate for all 29 real native descriptors', { skip }, () => {
    for (const kind of presentation.supportedKinds) {
        const original = plain(currentInventory().fields[kind]);
        const initialized = initializedNode(kind);
        assert.deepEqual(plain(operandEditor.validateFields(initialized)), [], kind + ' renderer defaults');
        assert.deepEqual(currentInventory().fields[kind], original, kind + ' initialize must not change the source descriptors');
        const representative = { kind, available: true, originalPath: null, fields: original };
        const values = new Map(edits(kind).map(field => [field.id, field.value]));
        representative.fields.forEach(field => { field.value = values.get(field.id); });
        assert.deepEqual(plain(operandEditor.validateFields(representative)), [], kind + ' representative operands');
    }
    const english = initializedNode('language'), russian = initializedNode('language', 'ru');
    assert.equal(english.fields.find(field => field.id === 'filter.languageLocale').value.value, 'en-US');
    assert.equal(russian.fields.find(field => field.id === 'filter.languageLocale').value.value, 'ru-RU');
    assert.ok(russian.fields.find(field => field.id === 'filter.displayName').value.value.includes('русский') ||
        russian.fields.find(field => field.id === 'filter.displayName').value.value.includes('Русский'));
    const once = initializedNode('run_once').fields.find(field => field.id === 'filter.id').value.value;
    assert.match(once, /^\{[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}\}$/);
});

test('renderer preserves broken existing locale and seconds/timezones without eager initialization or validation normalization', { skip }, () => {
    currentInventory().originals.forEach((fields, index) => {
        const kind = index === 0 ? 'language' : 'time';
        const node = { kind, available: true, originalPath: [index], fields: plain(fields) };
        assert.deepEqual(plain(operandEditor.initialize(node, { language: 'ru', scope: 'computer' })), fields);
        assert.deepEqual(plain(operandEditor.validateFields(node)), []);
        assert.deepEqual(node.fields, fields);
    });
});
