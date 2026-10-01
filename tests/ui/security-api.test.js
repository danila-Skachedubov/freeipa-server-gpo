'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApi(rpc) {
    let api;
    const filename = path.resolve(__dirname,
        '../../plugin/ui/grouppolicy/js/util/API.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        define: (names, factory) => {
            api = factory({ api_version: '2.0' }, rpc, {
                getLanguage: () => 'ru'
            });
        },
        navigator: { language: 'ru-RU', languages: ['ru-RU'] }
    });
    return api;
}

test('Security RPC preserves arrays and exposes structured FreeIPA validation errors', async () => {
    const specs = [];
    const response = {
        error: {
            message: 'Security policy actions must be a list.',
            data: { error_category: 'validation', field: 'request.policies' }
        }
    };
    const api = loadApi({ command(spec) {
        specs.push(spec);
        return { execute() {
            if (spec.method === 'editor_open') {
                spec.on_success({ result: { result: {} } });
            } else {
                spec.on_error({ responseJSON: response }, 'error', {
                    message: response.error.message, data: response
                });
            }
        } };
    } });
    await api.initialize('Test GPO');
    const request = {
        expected_semantic_revision: 'sha256:good',
        policies: [{ namespace: 'urn:test', policy_id: 'p', elements: [] }]
    };

    await assert.rejects(api.securityDefinitionsUpdate(request), error => {
        assert.equal(error.category, 'validation');
        assert.equal(error.field, 'request.policies');
        return true;
    });
    assert.equal(specs[0].retry, true);
    assert.equal(specs[1].retry, false);
    assert.deepEqual(JSON.parse(JSON.stringify(specs[1].options.request)), request);
    assert.equal(Array.isArray(specs[1].options.request.policies), true);
});

test('Advanced Audit RPC uses editor error rendering instead of FreeIPA retry dialog', async () => {
    const specs = [];
    const api = loadApi({ command(spec) {
        specs.push(spec);
        return { execute() {
            if (spec.method === 'editor_open') {
                spec.on_success({ result: { result: {} } });
            } else {
                spec.on_error(null, 'error', {
                    message: 'Advanced Audit operations must be lists.',
                    data: { error_category: 'validation', field: 'request.set_options' }
                });
            }
        } };
    } });
    await api.initialize('Test GPO');

    await assert.rejects(api.advancedAuditUpdate({ set_options: [] }), error => {
        assert.equal(error.category, 'validation');
        assert.equal(error.field, 'request.set_options');
        return true;
    });
    assert.equal(specs[1].retry, false);
});
