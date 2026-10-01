'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js/components/templates');
function load(name, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, name), 'utf8'), { define: (names, factory) => { result = factory(...names.map(name => dependencies[name])); }, Map, Set, console });
    return result;
}
const model = load('security/model.js');
const values = load('security/value-editor.js', { '../../../util/element-creator': {} });
const template = load('security-template.js', { '../../util/element-creator': {}, '../../locales/translations': { t: key => key }, './security/model': model, './security/value-editor': values });
const workbench = load('security/workbench.js', { '../../../util/element-creator': {}, '../../../locales/translations': { t: key => key } });
test('defined policies without settings use a dash and preserve explicit empty or false values', () => {
    const policy = { definition: { elements: [] }, state: { state: 'defined', elements: {} } };
    assert.equal(workbench.policySummary(policy), '—');
    policy.definition.elements.push({ id: 'enabled', value_type: 'boolean' });
    assert.equal(workbench.policySummary(policy), '—');
    policy.state.elements.enabled = { state: 'set', value: { kind: 'boolean', value: false } };
    assert.equal(workbench.policySummary(policy), 'Disabled');
    policy.definition.elements.push({ id: 'members', value_type: 'principal_list' });
    policy.state.elements.members = { state: 'set', value: { kind: 'principal_list', value: [] } };
    assert.equal(workbench.policySummary(policy), 'Disabled; Empty list');
});
function response() {
    const ns = 'urn:altlinux:sdmx:policies:';
    return { security_catalog: { semantic_revision: 'v1', categories: [
        { namespace: ns + 'b', id: 'security_options', display_name: 'Security Options' },
        { namespace: ns + 'a', id: 'security_options', display_name: 'Security Options' },
        { namespace: ns + 'registry', id: 'registry', display_name: 'Registry Security' }
    ], policies: [
        { namespace: ns + 'b', policy_id: 'b', display_name: 'Zulu', category: [ns + 'b', 'security_options'], elements: [{ id: 'enabled', value_type: 'boolean', required: true }] },
        { namespace: ns + 'a', policy_id: 'a', display_name: 'Alpha', category: [ns + 'a', 'security_options'], elements: [{ id: 'enabled', value_type: 'boolean', required: true }] },
        { namespace: ns + 'registry', policy_id: 'registry', display_name: 'Registry Security', category: [ns + 'registry', 'registry'], elements: [{ id: 'entries', value_type: 'collection', unique_by: 'key', fields: [] }] }
    ] }, security_snapshot: { policies: [] } };
}
test('merged sorted categories retain scalar policies only in category table and collapse collection folder', () => {
    const nodes = model.navigationNodes(response());
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].title, 'Registry Security');
    assert.equal(nodes[0].securityCollection, 'entries');
    assert.equal(nodes[0].children.length, 0);
    assert.equal(nodes[1].securityCategory, true);
    assert.equal(nodes[1].children[0].title, 'Alpha');
    assert.equal(nodes[1].children[1].title, 'Zulu');
    assert.ok(nodes[1].children.every(node => node.showInTree === false));
});
test('collection edits project only changed and deleted row keys', () => {
    const collection = { unique_by: 'key' };
    const row = value => ({ key: { state: 'set', value: { kind: 'string', value } } });
    const actions = values.rowActions(collection, [row('a'), row('b')], [row('b'), row('c')]);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].action, 'delete');
    assert.equal(actions[0].key.value, 'a');
    assert.equal(actions[1].action, 'upsert');
    assert.equal(actions[1].key.value, 'c');
});
test('Restricted Groups requires an explicit relationship and allows configured empty members', () => {
    const element = { id: 'groups', value_type: 'collection', unique_by: 'group', fields: [
        { id: 'group', required: true, element: { value_type: 'principal' } },
        { id: 'members', required: false, element: { value_type: 'principal_list' } },
        { id: 'member_of', required: false, element: { value_type: 'principal_list' } }
    ] };
    const row = { group: { state: 'set', value: { kind: 'principal', value: 'Administrators' } } };
    const draft = { defined: true, elements: { groups: { state: 'set', value: { kind: 'collection', value: [row] } } } };
    const policy = { definition: { elements: [element] } };
    assert.match(template._test.validateDraft(policy, draft), /Members or Member of/);
    row.members = { state: 'set', value: { kind: 'principal_list', value: [] } };
    assert.equal(template._test.validateDraft(policy, draft), null);
});
test('undefined policy transition and explicit empty values remain distinct', () => {
    const built = model.buildSecurityModel(response());
    const policy = [...built.policies.values()][0];
    const baseline = template._test.initialDraft(policy);
    const draft = JSON.parse(JSON.stringify(baseline)); draft.defined = true;
    draft.elements.enabled = { state: 'set', value: { kind: 'boolean', value: false } };
    const request = template._test.updateRequest(built, policy, baseline, draft);
    assert.equal(request.expected_semantic_revision, 'v1');
    assert.equal(request.policies[0].transition, 'define');
    assert.equal(request.policies[0].elements[0].value.value, false);
});
test('required service identity and descriptor cannot be blank, and enum selection is explicit', () => {
    for (const kind of ['service_name', 'sddl', 'principal', 'registry_key', 'file_path']) {
        assert.match(values.validationError({ value_type: kind }, { kind, value: '  ' }), /required/);
    }
    assert.match(values.validationError({ value_type: 'enum', options: [{ id: 'manual' }] }, { kind: 'enum', value: '' }), /Select/);
});
test('empty configured collection requires an item', () => {
    const policy = { definition: { elements: [{ id: 'rows', value_type: 'collection', unique_by: 'key', fields: [] }] } };
    const draft = { defined: true, elements: { rows: { state: 'set', value: { kind: 'collection', value: [] } } } };
    assert.match(template._test.validateDraft(policy, draft), /at least one item/);
});
test('scalar-only folders have no empty tree expander but lazy and item folders do', () => {
    const tree = load('../tree-view/tree-view-list.js', { '../../util/element-creator': {} });
    assert.equal(tree.hasVisibleChildren({ children: [{ showInTree: false }] }), false);
    assert.equal(tree.hasVisibleChildren({ lazy: true, children: [] }), true);
    assert.equal(tree.hasVisibleChildren({ children: [{ type: 'folder' }] }), true);
});
test('Advanced Audit supports all catalog rows and opaque global SACL editing without relabeling machine metadata', () => {
    const audit = load('advanced-audit/model.js', { '../../../locales/translations': { t: key => key.endsWith('.crash_on_audit_fail') ? 'Localized audit option' : key } });
    const fixture = { advanced_audit: { suggested_machine_name: 'DC1', rows: [], subcategory_catalog: [{ guid: 'audit-guid', display_name: 'Audit category' }] } };
    const families = audit.families(fixture);
    assert.equal(families.find(family => family.id === 'system_audit_policies').rows[0].editable, true);
    const sacls = families.find(family => family.id === 'global_object_access_auditing').rows;
    assert.equal(sacls.length, 2);
    assert.ok(sacls.every(row => row.editable && row.semantic_acl_editor === false));
    const option = families.find(family => family.id === 'audit_options').rows[0];
    assert.equal(option.display_name, 'Localized audit option');
    assert.equal(option.machine_name, 'DC1');
});
test('installed 185-policy catalog remains complete and sorted when Advanced Audit RPC fails', { skip: !fs.existsSync('/usr/share/sdmx/schema/1.0/sdmx-1.0.xsd') }, async () => {
    const fixture = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', [
        'import json,tempfile,pathlib',
        'from admix import SecurityDefinitionCatalog,Workspace',
        'c=SecurityDefinitionCatalog("/usr/share/PolicyDefinitions",locale="en-US",sdmx_schema="/usr/share/sdmx/schema/1.0/sdmx-1.0.xsd",sdml_schema="/usr/share/sdmx/schema/1.0/sdml-1.0.xsd")',
        'with tempfile.TemporaryDirectory() as d:',
        ' p=pathlib.Path(d); (p/"gpo").mkdir()',
        ' w=Workspace.open(p/"gpo",security_catalog=c,load_preferences=False,state_directory=p/"state",state_key="ui-test")',
        ' print(json.dumps({"security_catalog":w.security.definition_catalog(),"security_snapshot":w.security.definition_snapshot()}))'
    ].join('\n')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const api = { getDisplayName: () => 'UI test', securityDefinitionsShow: async () => fixture, advancedAuditShow: async () => { throw Error('Audit offline'); } };
    const audit = load('advanced-audit/model.js');
    const tree = load('../tree-view/tree-view-list-data.js', {
        '../editor-icons': load('../editor-icons.js'),
        '../../locales/translations': { t: key => key }, '../../util/API': api,
        '../templates/security/model': model, '../templates/advanced-audit/model': audit
    });
    const computer = tree.buildTreeViewList({})[0].children[0];
    const policies = computer.children.find(node => node.title === 'policies.title');
    const windowsSettings = policies.children.find(node => node.title === 'policies.windowsSettings');
    const node = windowsSettings.children.find(node => node.title === 'security.title');
    const nodes = await node.loadChildren();
    const visible = nodes.filter(node => node.showInTree !== false);
    assert.equal(visible.length, 11);
    assert.equal(visible.filter(node => node.securityCollection).length, 4);
    const scalars = visible.flatMap(node => node.children || []).filter(node => node.securityPolicy);
    assert.equal(scalars.length, 181);
    assert.ok(scalars.every(node => node.showInTree === false));
    assert.equal(scalars.length + visible.filter(node => node.securityCollection).length, 185);
    assert.deepEqual([...visible.map(node => node.title)], [...visible.map(node => node.title)].sort((a,b) => a.localeCompare(b)));
    api.advancedAuditShow = async () => ({ advanced_audit: { rows: [], subcategory_catalog: [] } });
    const available = (await node.loadChildren()).filter(node => node.showInTree !== false);
    assert.equal(available.length, 12);
    assert.equal(available[1].title, 'Advanced Audit Policy Configuration');
    assert.deepEqual([...available.map(node => node.title)], [...available.map(node => node.title)].sort((a,b) => a.localeCompare(b)));
});
