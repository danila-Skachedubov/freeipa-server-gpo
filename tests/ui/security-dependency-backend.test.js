'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js/components/templates');
const catalogRoot = process.env.SDMX_BASEALT_ROOT || null;
const definitions = catalogRoot ? path.join(catalogRoot, 'definitions')
    : '/usr/share/PolicyDefinitions';
const schemas = catalogRoot ? path.join(catalogRoot, 'docs/schema')
    : '/usr/share/sdmx/schema/1.0';
const schema = path.join(schemas, 'sdmx-1.0.xsd');

function load(name, dependencies = {}) {
    let result;
    vm.runInNewContext(fs.readFileSync(path.join(root, name), 'utf8'), {
        define: (names, factory) => {
            result = factory(...names.map(dependency => dependencies[dependency]));
        },
        Map, Set, console
    });
    return result;
}

test('dependency proposals are accepted as one atomic libadmix update', {
    skip: !fs.existsSync(schema) || !fs.existsSync(path.join(definitions, 'account-password.sdmx'))
}, () => {
    const pythonSetup = [
        'import json,tempfile,pathlib',
        'from admix import SecurityDefinitionCatalog,Workspace',
        'catalog=SecurityDefinitionCatalog(' + JSON.stringify(definitions) +
            ',locale="en-US",sdmx_schema=' + JSON.stringify(schema) +
            ',sdml_schema=' + JSON.stringify(path.join(schemas, 'sdml-1.0.xsd')) + ')'
    ];
    const fixture = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', pythonSetup.concat([
        'with tempfile.TemporaryDirectory() as d:',
        ' p=pathlib.Path(d); (p/"gpo").mkdir()',
        ' w=Workspace.open(p/"gpo",security_catalog=catalog,load_preferences=False,state_directory=p/"state",state_key="dependency-catalog")',
        ' print(json.dumps({"security_catalog":w.security.definition_catalog(),"security_snapshot":w.security.definition_snapshot()}))'
    ]).join('\n')], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const modelTools = load('security/model.js');
    const model = modelTools.buildSecurityModel(fixture);
    const planner = load('security/dependency-plan.js');
    const values = load('security/value-editor.js', { '../../../util/element-creator': {} });
    const template = load('security-template.js', {
        '../../util/element-creator': {},
        '../../locales/translations': { t: key => key },
        './security/model': modelTools,
        './security/value-editor': values
    });
    const cases = [
        ['account-password', 'account.password.maximum_password_age', 42],
        ['account-password', 'account.password.minimum_password_age', 998],
        ['account-lockout', 'account.lockout.lockout_bad_count', 5],
        ['account-lockout', 'account.lockout.lockout_bad_count', 0],
        ['account-lockout', 'account.lockout.reset_lockout_count', 99999],
        ['account-kerberos', 'account.kerberos.max_ticket_age', 7],
        ['account-kerberos', 'account.kerberos.max_service_age', 600],
        ['account-kerberos', 'account.kerberos.max_ticket_age', 0],
        ['account-kerberos', 'account.kerberos.max_service_age', 0],
        ['account-kerberos', 'account.kerberos.max_service_age', 10],
        ['account-kerberos', 'account.kerberos.max_service_age', 99999],
        ['event-log', 'event_log.security_log_retention_days', 7]
    ];
    const requests = cases.map(([part, id, value]) => {
        const namespace = 'urn:altlinux:sdmx:policies:' + part;
        const policy = modelTools.policy(model, { namespace, policy_id: id });
        assert.ok(policy, id);
        const baseline = template._test.initialDraft(policy);
        const draft = JSON.parse(JSON.stringify(baseline));
        const definition = policy.definition.elements.find(element => element.id === 'value');
        draft.defined = true;
        draft.elements.value = { state: 'set', value: { kind: definition.value_type, value } };
        const plan = planner.plan(model, policy, draft);
        const request = template._test.updateRequest(model, policy, baseline, draft);
        for (const change of plan && plan.changes || []) {
            assert.equal(template._test.validateDraft(change.policy, change.draft), null, change.policy.policyId);
            request.policies.push(template._test.updateRequest(
                model, change.policy, template._test.initialDraft(change.policy), change.draft
            ).policies[0]);
        }
        return request;
    });
    const outcomes = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', pythonSetup.concat([
        'import sys',
        'requests=json.load(sys.stdin)',
        'outcomes=[]',
        'for index,request in enumerate(requests):',
        ' with tempfile.TemporaryDirectory() as d:',
        '  p=pathlib.Path(d); (p/"gpo").mkdir()',
        '  w=Workspace.open(p/"gpo",security_catalog=catalog,load_preferences=False,state_directory=p/"state",state_key="dependency-"+str(index))',
        '  try: w.security.update_definitions(request)',
        '  except Exception as error: outcomes.append(str(error))',
        '  else: outcomes.append(None)',
        'print(json.dumps(outcomes))'
    ]).join('\n')], { encoding: 'utf8', input: JSON.stringify(requests), maxBuffer: 8 * 1024 * 1024 }));
    assert.deepEqual(outcomes, cases.map(() => null));
});
