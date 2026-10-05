'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApi(specs, responseForSpec) {
    let api;
    const filename = path.resolve(__dirname,
        '../../plugin/ui/grouppolicy/js/util/API.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        define: (_names, factory) => {
            api = factory({ api_version: '2.0' }, {
                command(spec) {
                    specs.push(spec);
                    return { execute() { spec.on_success({ result: { result:
                        responseForSpec ? responseForSpec(spec) : {
                            asset: { name: 'existing.cmd', byte_size: 1,
                                revision: 'r1', content_base64: 'QQ==' }
                        }
                    } }); } };
                }
            }, { getLanguage: () => 'en' });
        },
        navigator: { language: 'en-US', languages: ['en-US'] }
    });
    return api;
}

test('Script download uses the selected scoped asset and never mutates an editor envelope', async () => {
    const specs = [];
    const api = loadApi(specs, spec => spec.method === 'editor_open'
        ? { gpo: { version: 1 } }
        : { gpo: { version: 999 }, asset: { name: 'existing.cmd',
            byte_size: 1, revision: 'r1', content_base64: 'QQ==' } });
    await api.initialize('Test GPO');
    const result = await api.scriptAssetDownload('computer', 'startup', {
        name: 'existing.cmd', revision: 'r1'
    });
    assert.equal(result.asset.content_base64, 'QQ==');
    const request = specs[1];
    assert.equal(request.method, 'editor_script_asset_download');
    assert.deepEqual(Array.from(request.args), ['Test GPO', 'computer', 'startup']);
    assert.deepEqual(JSON.parse(JSON.stringify(request.options.request)), {
        name: 'existing.cmd', revision: 'r1'
    });
    assert.equal(request.retry, false);
    assert.equal((await api.open()).gpo.version, 1);
    assert.equal(specs.length, 2);
});

test('Each Scripts editor action sends its request to the matching scoped RPC', async () => {
    const specs = [];
    const api = loadApi(specs);
    await api.initialize('Test GPO');
    const request = { marker: 'opaque-editor-value', identities: ['first', 'second'] };
    const routes = [
        ['scriptsShow', 'editor_scripts_show', false],
        ['scriptFiles', 'editor_script_files', false],
        ['scriptEntryAdd', 'editor_script_entry_add', true],
        ['scriptEntryUpdate', 'editor_script_entry_update', true],
        ['scriptEntryRemove', 'editor_script_entry_remove', true],
        ['scriptEntriesReorder', 'editor_script_entries_reorder', true],
        ['scriptOrderUpdate', 'editor_script_order_update', true],
        ['scriptAssetUpload', 'editor_script_asset_upload', true],
        ['scriptUploadAndAdd', 'editor_script_upload_and_add', true],
        ['scriptAssetReplace', 'editor_script_asset_replace', true],
        ['scriptAssetDelete', 'editor_script_asset_delete', true],
        ['scriptAssetDownload', 'editor_script_asset_download', true]
    ];
    for (const [method, route, hasRequest] of routes) {
        await api[method]('user', 'logoff', ...(hasRequest ? [request] : []));
        const spec = specs.at(-1);
        assert.equal(spec.method, route, method);
        assert.deepEqual(Array.from(spec.args), ['Test GPO', 'user', 'logoff'], method);
        assert.equal(spec.retry, false, method);
        assert.deepEqual(hasRequest ? JSON.parse(JSON.stringify(spec.options.request))
            : spec.options.request, hasRequest ? request : undefined, method);
    }
});
