'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadAmd(relativePath, dependencies, globals = {}) {
    let exported;
    const filename = path.join(ROOT, relativePath);
    const sandbox = Object.assign({
        console,
        Promise,
        Map,
        Set,
        JSON,
        Error,
        String,
        Number,
        Boolean,
        Object,
        Array,
        define(names, factory) {
            exported = factory(...names.map((name) => dependencies[name]));
        }
    }, globals);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return exported;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

class TestEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.bubbles = options.bubbles !== false;
        this.key = options.key;
        this.target = null;
        this.currentTarget = null;
        this.defaultPrevented = false;
        this.propagationStopped = false;
    }

    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
}

class TestClassList {
    constructor(element) {
        this.element = element;
        this.values = new Set();
    }

    validate(value) {
        const token = String(value);
        if (!token) {
            throw new DOMException('The token provided must not be empty.', 'SyntaxError');
        }
        if (/[\t\n\f\r ]/.test(token)) {
            throw new DOMException(
                'The token provided contains HTML space characters, which are not valid in tokens.',
                'InvalidCharacterError'
            );
        }
        return token;
    }

    add(...values) {
        const tokens = values.map((value) => this.validate(value));
        tokens.forEach((token) => this.values.add(token));
    }
    remove(...values) {
        const tokens = values.map((value) => this.validate(value));
        tokens.forEach((token) => this.values.delete(token));
    }
    contains(value) { return this.values.has(this.validate(value)); }
    toggle(value, force) {
        const token = this.validate(value);
        const enabled = force === undefined ? !this.values.has(token) : Boolean(force);
        if (enabled) this.values.add(token);
        else this.values.delete(token);
        return enabled;
    }

    toString() { return Array.from(this.values).join(' '); }
}

function matchesTestSelector(element, selector) {
    let rest = selector.trim();
    if (!rest) return false;
    const tag = rest.match(/^[a-zA-Z][\w-]*/);
    if (tag && element.tagName !== tag[0].toUpperCase()) return false;
    const selectorWithoutAttributes = rest.replace(/\[[^\]]+\]/g, '');
    for (const match of selectorWithoutAttributes.matchAll(/\.([\w-]+)/g)) {
        if (!element.classList.contains(match[1])) return false;
    }
    for (const match of rest.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!element.hasAttribute(match[1])) return false;
        if (match[2] !== undefined && element.getAttribute(match[1]) !== match[2]) return false;
    }
    return true;
}

class TestElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.classList = new TestClassList(this);
        this.style = {};
        this.listeners = new Map();
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.required = false;
        this.type = '';
        this._textContent = '';
        this.focused = false;
    }

    get className() { return this.classList.toString(); }
    set className(value) {
        this.classList.values.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach((item) => this.classList.add(item));
    }

    get textContent() {
        return this._textContent + this.children.map((child) => child.textContent).join('');
    }
    set textContent(value) {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
        this._textContent = value === null || value === undefined ? '' : String(value);
    }

    get innerHTML() { return this.textContent; }
    set innerHTML(value) {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
        this._textContent = value ? String(value) : '';
    }

    appendChild(child) {
        if (!(child instanceof TestElement)) throw new TypeError('test DOM accepts TestElement children');
        if (child.parentNode) {
            child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    setAttribute(name, value) {
        const text = String(value);
        this.attributes.set(name, text);
        if (name === 'class') this.className = text;
        if (name === 'value') this.value = text;
        if (name === 'type') this.type = text;
        if (name === 'disabled') this.disabled = true;
        if (name === 'required') this.required = true;
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'disabled') this.disabled = false;
        if (name === 'required') this.required = false;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
        if (this.listeners.has(type)) this.listeners.get(type).delete(handler);
    }
    dispatchEvent(event) {
        const next = event instanceof TestEvent ? event : new TestEvent(event.type || event);
        if (!next.target) next.target = this;
        next.currentTarget = this;
        Array.from(this.listeners.get(next.type) || []).forEach((handler) => handler(next));
        if (next.bubbles && !next.propagationStopped && this.parentNode) {
            this.parentNode.dispatchEvent(next);
        }
        return !next.defaultPrevented;
    }
    click() { this.dispatchEvent(new TestEvent('click')); }
    focus() { this.focused = true; }

    querySelectorAll(selector) {
        const parts = selector.trim().split(/\s+/);
        const descendants = [];
        const visit = (node) => node.children.forEach((child) => {
            descendants.push(child);
            visit(child);
        });
        visit(this);
        return descendants.filter((candidate) => {
            if (!matchesTestSelector(candidate, parts[parts.length - 1])) return false;
            let ancestor = candidate.parentNode;
            for (let index = parts.length - 2; index >= 0; index -= 1) {
                while (ancestor && !matchesTestSelector(ancestor, parts[index])) ancestor = ancestor.parentNode;
                if (!ancestor) return false;
                ancestor = ancestor.parentNode;
            }
            return true;
        });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class TestDocument {
    createElement(tagName) { return new TestElement(tagName); }
    createTextNode(value) {
        const node = new TestElement('#text');
        node.textContent = value;
        return node;
    }
}

class TestElementCreator {
    constructor(tagName, options = {}) {
        this.element = new TestElement(tagName);
        const classes = Array.isArray(options.className) ? options.className : [options.className];
        this.element.classList.add(...classes.filter(Boolean));
        Object.entries(options.attrs || {}).forEach(([name, value]) => {
            if (value !== null && value !== undefined) this.element.setAttribute(name, value);
        });
        Object.entries(options.style || {}).forEach(([name, value]) => { this.element.style[name] = value; });
        if (options.text !== null && options.text !== undefined) this.element.textContent = options.text;
        Object.entries(options.events || {}).forEach(([name, handler]) => this.element.addEventListener(name, handler));
        (options.children || []).forEach((child) => this.append(child));
    }

    getElement() { return this.element; }
    append(child) {
        const element = child instanceof TestElementCreator ? child.getElement() : child;
        if (element instanceof TestElement) this.element.appendChild(element);
        return this;
    }
    setText(value) { this.element.textContent = value; return this; }
    on(name, handler) { this.element.addEventListener(name, handler); return this; }
}

function createTestElement(tagName, options) {
    return new TestElementCreator(tagName, options);
}

function preferenceTestHeader() {
    const root = createTestElement('div', { children: [
        createTestElement('div', { className: 'gp__control', children: [
            createTestElement('button', { className: ['button', 'preferences__btn-create'] }),
            createTestElement('button', { className: ['button', 'preferences__btn-edit'] }),
            createTestElement('button', { className: ['button', 'preferences__btn-delete'] })
        ] }),
        createTestElement('div', { className: 'gp__control-actions' })
    ] });
    return { getElement: () => root.getElement() };
}

function preferenceTestStatus() {
    return {
        renderError(error, actions = {}) {
            const children = [];
            if (actions.onRefresh) children.push(createTestElement('button', {
                className: 'gpo-editor-status__refresh',
                events: { click: actions.onRefresh }
            }));
            if (actions.onReconcile) children.push(createTestElement('button', {
                className: 'gpo-editor-status__reconcile',
                events: { click: actions.onReconcile }
            }));
            return createTestElement('div', {
                className: ['gpo-editor-status', 'gpo-editor-status--error'],
                attrs: { 'data-error-category': error.category || error.code || 'operational' },
                text: `${error.category || error.code || 'operational'}:${error.message || ''}`,
                children
            });
        }
    };
}

function loadPreferenceRenderer(API, confirm = () => true) {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const renderer = loadAmd('js/components/templates/preference/preferences-view-template.js', {
        '../../../util/element-creator': { createElement: createTestElement },
        '../../../util/API': API,
        '../../../util/editor-dto': dto,
        '../../editor-status': preferenceTestStatus(),
        '../../../locales/translations': { t: (key) => key }
    }, { window: { confirm }, Element: TestElement });
    return renderer;
}

async function flushPreferenceRenderer() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

test('test DOM rejects invalid class tokens atomically like DOMTokenList', () => {
    const classList = new TestElement('div').classList;

    assert.throws(() => classList.add('valid', 'two tokens'), { name: 'InvalidCharacterError' });
    assert.equal(classList.values.has('valid'), false);
    assert.throws(() => classList.add(''), { name: 'SyntaxError' });
});

test('real element creator normalizes every class input into valid DOM tokens', () => {
    const elementCreator = loadAmd('js/util/element-creator.js', {}, {
        document: new TestDocument(),
        Element: TestElement
    });
    const simple = elementCreator.createElement('div', { className: 'alpha beta' });
    assert.equal(simple.getElement().className, 'alpha beta');

    const creator = elementCreator.createElement('div', {
        className: ['gamma delta', 'epsilon\tzeta', '', '   ', null, false, 17]
    });
    assert.equal(creator.getElement().className, 'gamma delta epsilon zeta');

    assert.doesNotThrow(() => creator.addClass(['eta theta', '\niota\r', '', null, {}, 23]));
    assert.equal(creator.getElement().className, 'gamma delta epsilon zeta eta theta iota');

    assert.doesNotThrow(() => creator.removeClass(['delta eta', '\t\n', null, false, 23]));
    assert.equal(creator.getElement().className, 'gamma epsilon zeta theta iota');
});

test('API sends only displayname, opaque ids, structured request, and request locales', async () => {
    const calls = [];
    const rpc = {
        command(spec) {
            calls.push(spec);
            return {
                execute() {
                    spec.on_success({ result: { summary: null, result: { ok: true } } });
                }
            };
        }
    };
    const API = loadAmd('js/util/API.js', {
        'freeipa/ipa': { api_version: '2.0' },
        'freeipa/rpc': rpc,
        '../locales/translations': { getLanguage: () => 'ru' }
    }, { navigator: { languages: ['en-US'], language: 'en-US' } });

    await API.initialize('Desktop policy');
    await API.children('computer', 'opaque/category');
    await API.policyUpdate('computer', 'opaque:policy', {
        state: 'enabled',
        set_parameters: [{ parameter_id: 'size', value: { kind: 'integer', value: 32 } }]
    });
    await API.preferenceUpdate('user', 'ini_files', {
        identity: ['opaque', 'identity'],
        fields: [{ id: 'properties.value', value: { kind: 'optional_text', value: null } }]
    });
    await API.preferenceCreate('computer', 'registry', {
        fields: [],
        filters: [{
            op: 'insert', collection_path: [4, 2], index: 1, filter_kind: 'group', fields: []
        }]
    });
    await API.preferenceDelete('computer', 'registry', ['opaque', 'item']);
    await API.reconcile();

    assert.deepEqual(calls.map((call) => call.method), [
        'editor_open', 'editor_children', 'editor_policy_update', 'editor_preference_update',
        'editor_preference_create', 'editor_preference_delete', 'editor_reconcile'
    ]);
    assert.deepEqual(plain(calls[0].args), ['Desktop policy']);
    assert.deepEqual(plain(calls[1].args), ['Desktop policy', 'computer']);
    assert.deepEqual(plain(calls[2].args), ['Desktop policy', 'computer', 'opaque:policy']);
    assert.deepEqual(plain(calls[3].args), ['Desktop policy', 'user', 'ini_files']);
    assert.deepEqual(plain(calls[4].args), ['Desktop policy', 'computer', 'registry']);
    assert.deepEqual(plain(calls[5].args), ['Desktop policy', 'computer', 'registry']);
    assert.deepEqual(plain(calls[6].args), ['Desktop policy']);
    assert.deepEqual(plain(calls[0].options.locales), ['ru-RU', 'en-US']);
    assert.equal(calls[1].options.category_id, 'opaque/category');
    assert.deepEqual(plain(calls[2].options.request.set_parameters[0].value), {
        kind: 'integer', value: 32
    });
    assert.deepEqual(plain(calls[4].options.request.filters[0]), {
        op: 'insert', collection_path: [4, 2], index: 1, filter_kind: 'group', fields: []
    });
    assert.deepEqual(plain(calls[5].options.request.identity), ['opaque', 'item']);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[3].options, 'locales'), false);
    assert.equal(JSON.stringify(calls).includes('gpcfile' + 'syspath'), false);
    assert.equal(JSON.stringify(calls).includes('registry_' + 'path'), false);
});

test('scripts API mirrors every RPC without creating trusted client path state', async () => {
    const calls = [];
    const rpc = {
        command(spec) {
            calls.push(spec);
            return {
                execute() {
                    const result = spec.method === 'editor_open'
                        ? { gpo: { displayname: 'Desktop policy', revision: 'before' } }
                        : {
                            gpo: { displayname: 'Desktop policy', revision: spec.method },
                            scripts: { scope: 'computer', event: 'startup' }
                        };
                    spec.on_success({ result: { result } });
                }
            };
        }
    };
    const API = loadAmd('js/util/API.js', {
        'freeipa/ipa': { api_version: '2.0' },
        'freeipa/rpc': rpc,
        '../locales/translations': { getLanguage: () => 'en' }
    }, { navigator: { language: 'en-US' } });
    const entry = {
        mode: 'existing_asset', executable_group: 'classic', snapshot: 'classic-v1',
        name: 'startup.cmd', parameters: ''
    };
    const asset = { name: 'startup.cmd', content_base64: 'ZWNobyBoaQ==' };

    await API.initialize('Desktop policy');
    await API.scriptsShow('computer', 'startup');
    await API.scriptFiles('computer', 'startup');
    await API.scriptEntryAdd('computer', 'startup', entry);
    await API.scriptEntryUpdate('computer', 'startup', {
        executable_group: 'classic', identity: 'entry-1', command_line: 'startup.cmd', parameters: ''
    });
    await API.scriptEntryRemove('computer', 'startup', {
        executable_group: 'classic', identity: 'entry-1', delete_asset: false
    });
    await API.scriptEntriesReorder('computer', 'startup', {
        executable_group: 'classic', snapshot: 'classic-v2', identities: ['entry-2', 'entry-1']
    });
    await API.scriptOrderUpdate('computer', 'startup', {
        snapshot: 'powershell-v1', execution_order: 'powershell_first'
    });
    await API.scriptAssetUpload('computer', 'startup', asset);
    await API.scriptUploadAndAdd('computer', 'startup', {
        executable_group: 'classic', snapshot: 'classic-v1', name: 'startup.cmd',
        content_base64: 'ZWNobyBoaQ==', parameters: ''
    });
    await API.scriptAssetReplace('computer', 'startup', {
        name: 'startup.cmd', revision: 'asset-v1', content_base64: 'ZWNobyBuZXc='
    });
    await API.scriptAssetDelete('computer', 'startup', {
        name: 'startup.cmd', revision: 'asset-v2'
    });
    entry.name = 'mutated-after-dispatch.cmd';
    asset.name = 'mutated-after-dispatch.cmd';

    assert.deepEqual(calls.map((call) => call.method), [
        'editor_open', 'editor_scripts_show', 'editor_script_files',
        'editor_script_entry_add', 'editor_script_entry_update',
        'editor_script_entry_remove', 'editor_script_entries_reorder',
        'editor_script_order_update', 'editor_script_asset_upload',
        'editor_script_upload_and_add', 'editor_script_asset_replace',
        'editor_script_asset_delete'
    ]);
    calls.slice(1).forEach((call) => {
        assert.deepEqual(plain(call.args), ['Desktop policy', 'computer', 'startup']);
        assert.equal(Object.prototype.hasOwnProperty.call(call.options, 'locales'), false);
    });
    assert.deepEqual(plain(calls[3].options.request), {
        mode: 'existing_asset', executable_group: 'classic', snapshot: 'classic-v1',
        name: 'startup.cmd', parameters: ''
    });
    assert.deepEqual(plain(calls[8].options.request), {
        name: 'startup.cmd', content_base64: 'ZWNobyBoaQ=='
    });
    assert.equal(API.getOpenResult().gpo.revision, 'editor_script_asset_delete');
    assert.equal(JSON.stringify(calls).includes('gpcfile' + 'syspath'), false);
    assert.equal(JSON.stringify(calls).includes('server_' + 'path'), false);
});

test('API preserves structured error categories and field data', async () => {
    const rpc = {
        command(spec) {
            return {
                execute() {
                    spec.on_error({
                        responseJSON: {
                            error: {
                                message: 'invalid value',
                                data: { error_category: 'validation', field: 'cursor_size', path: ['parameters', 0] }
                            }
                        }
                    }, 'error', null);
                }
            };
        }
    };
    const API = loadAmd('js/util/API.js', {
        'freeipa/ipa': { api_version: '2.0' },
        'freeipa/rpc': rpc,
        '../locales/translations': { getLanguage: () => 'en' }
    }, { navigator: { language: 'en-US' } });

    await assert.rejects(API.initialize('Policy'), (error) => {
        assert.equal(error.category, 'validation');
        assert.equal(error.field, 'cursor_size');
        assert.deepEqual(plain(error.path), ['parameters', 0]);
        return true;
    });
    const conflict = API._test.normalizeError(null, null, {
        message: 'conflict',
        data: {
            error_category: 'publication_conflict',
            details: JSON.stringify({ safe_next_actions: ['refresh', 'reconcile'] })
        }
    });
    assert.equal(conflict.category, 'publication_conflict');
    assert.deepEqual(plain(conflict.details.safe_next_actions), ['refresh', 'reconcile']);
    const authorization = API._test.normalizeError(null, null, {
        name: 'ACIError', message: 'not allowed'
    });
    assert.equal(authorization.category, 'authorization');
    const stale = API._test.normalizeError(null, null, {
        data: { error_category: 'not_found', field: 'identity' }, message: 'stale item'
    });
    assert.equal(stale.category, 'not_found');
    assert.equal(stale.field, 'identity');
});

test('pending publication is inspected and reconciled explicitly without resubmitting an edit', async () => {
    const calls = [];
    const rpc = {
        command(spec) {
            calls.push(spec.method);
            return {
                execute() {
                    const result = spec.method === 'editor_open'
                        ? { pending_publication: { phase: 'awaiting_directory_publication' } }
                        : {
                            recovery: {
                                kind: 'conflict',
                                conflict: {
                                    conflict_fields: ['version'],
                                    safe_next_actions: ['refresh', 'operator_intervention']
                                }
                            }
                        };
                    spec.on_success({ result: { result } });
                }
            };
        }
    };
    const API = loadAmd('js/util/API.js', {
        'freeipa/ipa': { api_version: '2.0' },
        'freeipa/rpc': rpc,
        '../locales/translations': { getLanguage: () => 'en' }
    }, { navigator: { language: 'en-US' } });
    const opened = await API.initialize('Policy');
    assert.equal(opened.pending_publication.phase, 'awaiting_directory_publication');
    const reconciled = await API.reconcile();
    assert.equal(reconciled.recovery.kind, 'conflict');
    assert.deepEqual(calls, ['editor_open', 'editor_reconcile']);
});

test('policy draft helper preserves every supported discriminated value kind', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    assert.deepEqual(plain(dto.typedValueFromInput({ kind: 'boolean', value: false }, 'boolean', '', true)), {
        kind: 'boolean', value: true
    });
    assert.deepEqual(plain(dto.typedValueFromInput({ kind: 'integer', value: 1 }, 'boolean', '', false)), {
        kind: 'boolean', value: false
    });
    assert.deepEqual(plain(dto.typedValueFromInput({ kind: 'integer', value: 1 }, 'decimal', '42', false)), {
        kind: 'integer', value: 42
    });
    assert.deepEqual(plain(dto.typedValueFromInput({ kind: 'text', value: 'old' }, 'text', 'new', false)), {
        kind: 'text', value: 'new'
    });
    assert.deepEqual(plain(dto.typedValueFromInput({ kind: 'text_list', value: [] }, 'list', 'a\nb', false)), {
        kind: 'text_list', value: ['a', 'b']
    });
    assert.deepEqual(plain(dto.typedValueFromInput({
        kind: 'registry', value: { kind: 'dword', value: 1 }
    }, 'decimal', '64', false)), {
        kind: 'integer', value: 64
    });
    const unsupported = { kind: 'unsupported', value: { kind: 'preserved_unknown', reg_type: 99, bytes: [1] } };
    assert.deepEqual(plain(dto.typedValueFromInput(unsupported, 'text', 'overwrite', false)), unsupported);
    const choices = [{
        label: 'Exact registry choice',
        value: { kind: 'registry', value: { kind: 'expand_string', value: '%HOME%' } }
    }];
    assert.deepEqual(plain(dto.policyChoiceValue(choices, '0')), choices[0].value);
    assert.equal(dto.policyChoiceValue(choices, ''), null);
    assert.equal(dto.canEditPolicyParameters({
        state: 'enabled', capabilities: { edit_parameters: true }
    }, 'enabled'), true);
    assert.equal(dto.canEditPolicyParameters({
        state: 'unknown_raw_values', capabilities: { edit_parameters: true }
    }, 'enabled'), false);
    assert.equal(dto.canEditPolicyParameters({
        state: 'enabled', capabilities: { edit_parameters: false }
    }, 'enabled'), false);
    assert.equal(dto.canEditPolicyParameters({
        state: 'not_configured', capabilities: { edit_parameters: true }
    }, 'not_configured'), false);
    assert.equal(dto.canEditPolicyParameters({
        state: 'not_configured', capabilities: { edit_parameters: true }
    }, 'enabled'), true);
});

test('policy state actions control radios independently from persisted representability', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'not_configured',
        representability: { enabled: false, disabled: false, not_configured: true },
        capabilities: { enable: true, disable: true, clear: true, edit_parameters: true },
        state_actions: {
            enabled: { available: true, mode: 'element_values', requires_parameters: true },
            disabled: { available: true, mode: 'delete_element_bindings', requires_parameters: false },
            not_configured: { available: true, mode: 'remove_owned_records', requires_parameters: false }
        }
    };
    assert.equal(dto.canSelectPolicyState(policy, 'enabled'), true);
    assert.equal(dto.canSelectPolicyState(policy, 'disabled'), true);
    assert.deepEqual(plain(dto.policyStateAction(policy, 'enabled')), {
        available: true, mode: 'element_values', requires_parameters: true
    });
    assert.equal(dto.canEditPolicyParameters(policy, 'not_configured'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'disabled'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'enabled'), true);
    policy.state = 'unknown_raw_values';
    assert.equal(dto.canSelectPolicyState(policy, 'enabled'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'enabled'), false);
});

test('state_actions is authoritative and parameter editing requires Enabled availability', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'not_configured',
        capabilities: {
            enable: true, disable: true, clear: true, edit_parameters: true
        },
        state_actions: {
            enabled: { available: false, mode: null, requires_parameters: false },
            not_configured: {
                available: true, mode: 'remove_owned_records', requires_parameters: false
            }
        }
    };

    assert.equal(dto.canSelectPolicyState(policy, 'disabled'), false);
    assert.equal(dto.canSelectPolicyState(policy, 'enabled'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'enabled'), false);
    assert.deepEqual(plain(dto.policyStateAction(policy, 'disabled')), {
        available: false, mode: null, requires_parameters: false
    });
});

test('explicit-action policies keep state selectable and parameters scoped to Enabled', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'disabled',
        capabilities: {
            enable: true, disable: true, clear: true, edit_parameters: true
        },
        state_actions: {
            enabled: {
                available: true, mode: 'explicit_actions', requires_parameters: false
            },
            disabled: {
                available: true, mode: 'explicit_actions', requires_parameters: false
            },
            not_configured: {
                available: true, mode: 'explicit_actions', requires_parameters: false
            }
        },
        parameters: [{
            id: 'text', value: { kind: 'text', value: 'persisted' },
            default_value: { kind: 'text', value: 'default' }
        }],
        comment: null
    };
    const baseline = {
        state: 'disabled',
        parameters: [{
            parameter_id: 'text', value: { kind: 'text', value: 'persisted' }
        }],
        comment: ''
    };
    const enabledDraft = {
        state: 'enabled',
        parameters: [{
            parameter_id: 'text', value: { kind: 'text', value: 'draft' }
        }],
        comment: ''
    };

    ['enabled', 'disabled', 'not_configured'].forEach(function(state) {
        assert.equal(dto.canSelectPolicyState(policy, state), true);
    });
    assert.equal(dto.canEditPolicyParameters(policy, 'disabled'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'not_configured'), false);
    assert.equal(dto.canEditPolicyParameters(policy, 'enabled'), true);
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, enabledDraft, baseline)), {
        state: 'enabled',
        set_parameters: [{
            parameter_id: 'text', value: { kind: 'text', value: 'draft' }
        }]
    });
});

test('enabling an element policy materializes defaults but disabled omits parameter edits', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'not_configured',
        state_actions: {
            enabled: { available: true, mode: 'element_values', requires_parameters: true }
        },
        parameters: [
            {
                id: 'flag', value: null,
                default_value: { kind: 'boolean', value: false }
            },
            { id: 'optional_text', value: null, default_value: null }
        ],
        comment: null
    };
    const baseline = {
        state: 'not_configured',
        parameters: [
            { parameter_id: 'flag', value: { kind: 'boolean', value: false } },
            { parameter_id: 'optional_text', value: { kind: 'text', value: '' } }
        ],
        comment: ''
    };
    const enabled = Object.assign({}, baseline, { state: 'enabled' });
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, enabled, baseline)), {
        state: 'enabled',
        set_parameters: [{
            parameter_id: 'flag', value: { kind: 'boolean', value: false }
        }]
    });
    const disabled = {
        state: 'disabled',
        parameters: [
            { parameter_id: 'flag', value: { kind: 'boolean', value: true } },
            { parameter_id: 'optional_text', value: { kind: 'text', value: 'draft' } }
        ],
        comment: ''
    };
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, disabled, baseline)), {
        state: 'disabled'
    });
    const notConfigured = Object.assign({}, disabled, { state: 'not_configured' });
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, notConfigured, baseline)), {});
});

test('only supported fixed-element defaults materialize when Enabled requires parameters', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const defaults = [
        ['false', { kind: 'boolean', value: false }],
        ['zero', { kind: 'integer', value: 0 }],
        ['empty-text', { kind: 'text', value: '' }],
        ['empty-list', { kind: 'text_list', value: [] }],
        ['enum', { kind: 'registry', value: { kind: 'dword', value: 2 } }],
        ['unsupported', { kind: 'unsupported', value: { kind: 'preserved_unknown', reg_type: 99, bytes: [1] } }]
    ];
    const policy = {
        state: 'not_configured',
        state_actions: {
            enabled: { available: true, mode: 'element_values', requires_parameters: true }
        },
        parameters: defaults.map(function(entry) {
            return { id: entry[0], value: null, default_value: entry[1] };
        }),
        comment: null
    };
    const baseline = {
        state: 'not_configured',
        parameters: defaults.map(function(entry) {
            return { parameter_id: entry[0], value: entry[1] };
        }),
        comment: ''
    };
    const enabled = Object.assign({}, baseline, { state: 'enabled' });
    const request = dto.buildPolicyUpdate(policy, enabled, baseline);

    assert.deepEqual(plain(request.set_parameters), defaults.slice(0, -1).map(function(entry) {
        return { parameter_id: entry[0], value: entry[1] };
    }));
    assert.equal(request.set_parameters.some(function(item) {
        return item.parameter_id === 'unsupported';
    }), false);

    policy.state_actions.enabled.requires_parameters = false;
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, enabled, baseline)), {
        state: 'enabled'
    });
});

test('unknown parameter kind with no value renders read-only without throwing', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    function fakeElement(spec) {
        const element = {
            disabled: false,
            checked: false,
            value: spec && spec.attrs && spec.attrs.value || '',
            querySelector() { return null; }
        };
        return {
            getElement() { return element; }
        };
    }
    const template = loadAmd('js/components/templates/admx-template.js', {
        '../../util/element-creator': { createElement: (tag, spec) => fakeElement(spec || {}) },
        '../../util/API': {},
        '../../util/editor-dto': dto,
        '../editor-status': {},
        '../../locales/translations': { t: (key) => key }
    });

    const control = template._test.createParameterControl({
        id: 'opaque', kind: 'future-kind', value: null, default_value: null,
        required: false, editable: true
    }, true);
    assert.equal(control.read(), null);
    control.setDisabled(false);
    assert.equal(control.input.disabled, true);
});

test('optional boolean policy parameter uses one checkbox without a clear action', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const template = loadAmd('js/components/templates/admx-template.js', {
        '../../util/element-creator': { createElement: createTestElement },
        '../../util/API': {},
        '../../util/editor-dto': dto,
        '../editor-status': {},
        '../../locales/translations': { t: (key) => key }
    });

    const control = template._test.createParameterControl({
        id: 'block', label: 'Block', kind: 'boolean',
        value: { kind: 'boolean', value: false },
        default_value: null, required: false, editable: true
    }, true);
    const root = control.element.getElement();

    assert.equal(root.querySelectorAll('input[type="checkbox"]').length, 1);
    assert.equal(root.querySelector('button.gpo-editor-field__clear'), null);
    assert.equal(root.querySelectorAll('.gpo-editor-boolean label').length, 1);
    assert.deepEqual(plain(control.read()), { kind: 'boolean', value: false });
});

test('required boolean policy parameter keeps one checkbox without a clear action', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const template = loadAmd('js/components/templates/admx-template.js', {
        '../../util/element-creator': { createElement: createTestElement },
        '../../util/API': {},
        '../../util/editor-dto': dto,
        '../editor-status': {},
        '../../locales/translations': { t: (key) => key }
    });

    const control = template._test.createParameterControl({
        id: 'required-block', label: 'Block', kind: 'boolean',
        value: { kind: 'boolean', value: true },
        default_value: null, required: true, editable: true
    }, true);
    const root = control.element.getElement();

    assert.equal(root.querySelectorAll('input[type="checkbox"]').length, 1);
    assert.equal(root.querySelector('button.gpo-editor-field__clear'), null);
    assert.deepEqual(plain(control.read()), { kind: 'boolean', value: true });
});

test('one atomic policy request contains state, ordered sets, clears, and comment', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'not_configured',
        parameters: [
            { id: 'one', value: { kind: 'integer', value: 1 } },
            { id: 'two', value: { kind: 'optional_text', value: 'old' } }
        ],
        comment: { text: 'before', source: 'locale', locale: 'ru-RU' }
    };
    const request = dto.buildPolicyUpdate(policy, {
        state: 'enabled',
        parameters: [
            { parameter_id: 'one', value: { kind: 'integer', value: 2 } },
            { parameter_id: 'two', value: null }
        ],
        comment: 'after'
    });
    assert.deepEqual(plain(request), {
        state: 'enabled',
        set_parameters: [{ parameter_id: 'one', value: { kind: 'integer', value: 2 } }],
        clear_parameters: ['two'],
        comment: {
            action: 'set',
            target: { kind: 'locale', locale: 'ru-RU' },
            text: 'after'
        }
    });
});

test('policy update compares canonical controls to the rendered baseline', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const policy = {
        state: 'enabled',
        parameters: [{ id: 'flag', value: { kind: 'integer', value: 1 } }],
        comment: null
    };
    const baseline = {
        state: 'enabled',
        parameters: [{ parameter_id: 'flag', value: { kind: 'boolean', value: true } }],
        comment: ''
    };
    assert.deepEqual(plain(dto.buildPolicyUpdate(policy, baseline, baseline)), {});
});

test('failed atomic submission retains the complete policy draft', async () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const draft = {
        state: 'enabled',
        parameters: [
            { parameter_id: 'text', value: { kind: 'text', value: 'unsaved' } },
            { parameter_id: 'list', value: { kind: 'text_list', value: ['one', 'two'] } }
        ],
        comment: 'unsaved comment'
    };
    const outcome = await dto.submitPreservingDraft(draft, () => Promise.reject(new Error('validation')));
    assert.equal(outcome.ok, false);
    assert.deepEqual(plain(outcome.draft), draft);
    assert.equal(outcome.error.message, 'validation');
});

test('preference values preserve optional and typed semantics', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    assert.deepEqual(plain(dto.preferenceValueFromInput({ kind: 'optional_text', value: 'x' }, '', false)), {
        kind: 'optional_text', value: null
    });
    assert.deepEqual(plain(dto.preferenceValueFromInput({ kind: 'optional_boolean', value: null }, 'false', false)), {
        kind: 'optional_boolean', value: false
    });
    assert.deepEqual(plain(dto.preferenceValueFromInput({ kind: 'optional_unsigned_byte', value: null }, '12', false)), {
        kind: 'optional_unsigned_byte', value: 12
    });
    assert.deepEqual(plain(dto.preferenceValueFromInput({ kind: 'text_list', value: [] }, 'one\ntwo', false)), {
        kind: 'text_list', value: ['one', 'two']
    });
    assert.deepEqual(plain(dto.optionalTextValue(true, '')), {
        kind: 'optional_text', value: ''
    });
    assert.deepEqual(plain(dto.optionalTextValue(false, 'kept out')), {
        kind: 'optional_text', value: null
    });
});

test('preference create request preserves typed editable fields and ignores readonly descriptors', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const descriptors = [
        {
            id: 'properties.path', label: 'Path', required: true, editable: true,
            value: { kind: 'text', value: '' }
        },
        {
            id: 'properties.disabled', label: 'Disabled', required: false, editable: true,
            value: { kind: 'optional_boolean', value: null }
        },
        {
            id: 'metadata.changed', label: 'Changed', required: false, editable: false,
            value: { kind: 'optional_text', value: null }
        }
    ];
    const fields = [
        { id: 'properties.path', value: { kind: 'text', value: '/srv/share' } },
        { id: 'properties.disabled', value: { kind: 'optional_boolean', value: false } },
        { id: 'metadata.changed', value: { kind: 'optional_text', value: 'user-forged' } }
    ];

    const result = dto.buildPreferenceRequest({ creating: true, descriptors, fields });

    assert.equal(result.changed, true);
    assert.deepEqual(plain(result.errors), []);
    assert.deepEqual(plain(result.request), {
        fields: [
            { id: 'properties.path', value: { kind: 'text', value: '/srv/share' } },
            { id: 'properties.disabled', value: { kind: 'optional_boolean', value: false } }
        ]
    });

    result.request.fields[0].value.value = 'mutated response';
    assert.equal(fields[0].value.value, '/srv/share');
});

test('preference parent candidates preserve opaque identity and omit the root parent', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const candidates = [
        { identity: null, label: 'Root', parent_identity: null, depth: 0 },
        {
            identity: ['opaque', 'nested'], label: 'Nested',
            parent_identity: null, depth: 1
        }
    ];

    assert.equal(dto.preferenceParentIdentity(candidates, '0'), null);
    const selected = dto.preferenceParentIdentity(candidates, '1');
    assert.deepEqual(plain(selected), ['opaque', 'nested']);

    const nested = dto.buildPreferenceRequest({
        creating: true, descriptors: [], fields: [], parent: selected
    });
    assert.deepEqual(plain(nested.request), {
        fields: [], parent: ['opaque', 'nested']
    });
    nested.request.parent[0] = 'mutated';
    assert.deepEqual(candidates[1].identity, ['opaque', 'nested']);

    const root = dto.buildPreferenceRequest({
        creating: true,
        descriptors: [],
        fields: [],
        parent: dto.preferenceParentIdentity(candidates, '0')
    });
    assert.deepEqual(plain(root.request), { fields: [] });
});

test('preference update emits changed fields, rename and filters while a true no-op emits no request', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const descriptors = [
        {
            id: 'properties.value', required: true, editable: true,
            value: { kind: 'text', value: 'old' }
        },
        {
            id: 'properties.disabled', required: false, editable: true,
            value: { kind: 'optional_boolean', value: null }
        },
        {
            id: 'metadata.status', required: false, editable: false,
            value: { kind: 'optional_text', value: 'generated' }
        }
    ];
    const identity = ['opaque', 'item'];
    const filters = [{
        op: 'edit', path: [7, 1],
        fields: [{ id: 'filter.not', value: { kind: 'boolean', value: true } }]
    }];

    const changed = dto.buildPreferenceRequest({
        creating: false,
        identity,
        descriptors,
        fields: [
            { id: 'properties.value', value: { kind: 'text', value: 'new' } },
            { id: 'properties.disabled', value: { kind: 'optional_boolean', value: null } },
            { id: 'metadata.status', value: { kind: 'optional_text', value: 'forged' } }
        ],
        name: 'Renamed item',
        originalName: 'Original item',
        filters
    });

    assert.equal(changed.changed, true);
    assert.deepEqual(plain(changed.request), {
        identity,
        fields: [{ id: 'properties.value', value: { kind: 'text', value: 'new' } }],
        name: 'Renamed item',
        filters
    });

    identity[0] = 'mutated';
    filters[0].path[0] = 99;
    assert.deepEqual(plain(changed.request.identity), ['opaque', 'item']);
    assert.deepEqual(plain(changed.request.filters[0].path), [7, 1]);

    const renameOnly = dto.buildPreferenceRequest({
        creating: false,
        identity: ['opaque', 'item'],
        descriptors,
        fields: descriptors.map((field) => ({ id: field.id, value: field.value })),
        name: 'Renamed item',
        originalName: 'Original item'
    });
    assert.equal(renameOnly.changed, true);
    assert.deepEqual(plain(renameOnly.request), {
        identity: ['opaque', 'item'],
        name: 'Renamed item'
    });

    const noOp = dto.buildPreferenceRequest({
        creating: false,
        identity: ['opaque', 'item'],
        descriptors,
        fields: descriptors.map((field) => ({ id: field.id, value: field.value })),
        name: 'Original item',
        originalName: 'Original item'
    });
    assert.equal(noOp.changed, false);
    assert.equal(noOp.request, null);
    assert.deepEqual(plain(noOp.errors), []);
});

test('preference request rejects duplicate descriptors, blank rename and invalid typed values', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const descriptors = [
        {
            id: 'duplicate', required: false, editable: true,
            value: { kind: 'text', value: 'first' }
        },
        {
            id: 'duplicate', required: false, editable: true,
            value: { kind: 'text', value: 'second' }
        },
        {
            id: 'required', required: true, editable: true,
            value: { kind: 'text', value: 'baseline' }
        },
        {
            id: 'byte', required: false, editable: true,
            value: { kind: 'optional_unsigned_byte', value: null }
        },
        {
            id: 'action', required: true, editable: true,
            value: { kind: 'action', value: 'update' }
        }
    ];
    const result = dto.buildPreferenceRequest({
        creating: false,
        identity: ['item'],
        descriptors,
        fields: [
            { id: 'required', value: { kind: 'text', value: '   ' } },
            { id: 'byte', value: { kind: 'optional_unsigned_byte', value: 256 } },
            { id: 'action', value: { kind: 'action', value: 'invented' } }
        ],
        name: '   ',
        originalName: 'Original'
    });

    assert.equal(result.changed, false);
    assert.equal(result.request, null);
    assert.deepEqual(plain(result.errors), [
        { id: 'duplicate', code: 'duplicate_descriptor' },
        { id: 'required', code: 'required' },
        { id: 'byte', code: 'unsigned_byte_range' },
        { id: 'action', code: 'invalid_value' },
        { id: 'name', code: 'required' }
    ]);
});

test('preference validation distinguishes optional absence, invalid numbers and enum values', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const field = { required: false, editable: true };

    assert.equal(dto.validatePreferenceField(
        field, { kind: 'optional_unsigned_byte', value: null }
    ), null);
    assert.equal(dto.validatePreferenceField(
        field, { kind: 'unsigned_byte', value: -1 }
    ), 'unsigned_byte_range');
    assert.equal(dto.validatePreferenceField(
        field, { kind: 'integer', value: 1.5 }
    ), 'invalid_number');
    assert.equal(dto.validatePreferenceField(
        field, { kind: 'integer', value: Number.NaN }
    ), 'invalid_number');
    assert.equal(dto.validatePreferenceField(
        field, { kind: 'action', value: 'replace' }
    ), null);
    assert.equal(dto.validatePreferenceField(
        field, { kind: 'filter_combine', value: 'xor' }
    ), 'invalid_value');
    assert.equal(dto.validatePreferenceField(
        { required: true }, { kind: 'boolean', value: false }
    ), null);
    const choice = {
        required: true,
        control: 'choice',
        choices: [
            { key: 'unknown', label: 'Unknown' },
            { key: 'ru-MD', label: 'Russian (Moldova)' }
        ]
    };
    assert.equal(dto.validatePreferenceField(
        choice, { kind: 'text', value: 'unknown' }
    ), null);
    assert.equal(dto.validatePreferenceField(
        choice, { kind: 'text', value: 'not-a-locale' }
    ), 'invalid_value');
    assert.equal(dto.validatePreferenceField(
        { required: true, control: 'choice', choices: [{ key: '', label: 'Broken' }] },
        { kind: 'text', value: '' }
    ), 'invalid_value');
});

test('targeting-filter lifecycle keeps opaque paths and typed fields unchanged', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const pathValue = [7, 1, 9];
    const fields = [{ id: 'filter.not', value: { kind: 'boolean', value: true } }];
    assert.deepEqual(plain(dto.insertFilterOperation(pathValue, 2, 'group', fields)), {
        op: 'insert', collection_path: pathValue, index: 2, filter_kind: 'group', fields
    });
    assert.deepEqual(plain(dto.editFilterOperation(pathValue, fields)), {
        op: 'edit', path: pathValue, fields
    });
    assert.deepEqual(plain(dto.replaceFilterOperation(pathValue, 'wmi', fields)), {
        op: 'replace', path: pathValue, filter_kind: 'wmi', fields
    });
    assert.deepEqual(plain(dto.removeFilterOperation(pathValue)), {
        op: 'remove', path: pathValue
    });
    const operation = dto.removeFilterOperation(pathValue);
    pathValue[0] = 99;
    assert.deepEqual(plain(operation.path), [7, 1, 9]);
});

test('targeting-filter planner orders field edits before structure and suppresses removed descendants', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const fieldEdits = [
        {
            path: [2],
            fields: [{ id: 'filter.name', value: { kind: 'optional_text', value: 'parent' } }]
        },
        {
            path: [2, 1],
            fields: [{ id: 'filter.name', value: { kind: 'optional_text', value: 'child' } }]
        },
        {
            path: [4],
            fields: [{ id: 'filter.not', value: { kind: 'boolean', value: true } }]
        },
        { path: [5], fields: [] },
        { path: null, fields: [{ id: 'ignored', value: { kind: 'text', value: 'x' } }] }
    ];
    const remove = dto.removeFilterOperation([2]);

    const result = dto.buildPreferenceFilterOperations(fieldEdits, remove);

    assert.deepEqual(plain(result), [
        {
            op: 'edit', path: [4],
            fields: [{ id: 'filter.not', value: { kind: 'boolean', value: true } }]
        },
        { op: 'remove', path: [2] }
    ]);
    assert.equal(dto.pathWithin([2], [2]), true);
    assert.equal(dto.pathWithin([2, 1], [2]), true);
    assert.equal(dto.pathWithin([2], [2, 1]), false);
    assert.equal(dto.pathWithin([20], [2]), false);

    remove.path[0] = 99;
    fieldEdits[2].fields[0].value.value = false;
    assert.deepEqual(plain(result[0].fields[0].value), { kind: 'boolean', value: true });
    assert.deepEqual(plain(result[1].path), [2]);
});

test('targeting-filter planner suppresses replaced descendants but retains edits before insert', () => {
    const dto = loadAmd('js/util/editor-dto.js', {});
    const fieldEdits = [
        {
            path: [1, 0],
            fields: [{ id: 'filter.value', value: { kind: 'text', value: 'nested' } }]
        },
        {
            path: [3],
            fields: [{ id: 'filter.value', value: { kind: 'text', value: 'sibling' } }]
        }
    ];
    const replace = dto.replaceFilterOperation([1], 'group', []);
    assert.deepEqual(plain(dto.buildPreferenceFilterOperations(fieldEdits, replace)), [
        {
            op: 'edit', path: [3],
            fields: [{ id: 'filter.value', value: { kind: 'text', value: 'sibling' } }]
        },
        { op: 'replace', path: [1], filter_kind: 'group', fields: [] }
    ]);

    const insert = dto.insertFilterOperation([], 2, 'wmi', []);
    assert.deepEqual(plain(dto.buildPreferenceFilterOperations(fieldEdits, insert)), [
        {
            op: 'edit', path: [1, 0],
            fields: [{ id: 'filter.value', value: { kind: 'text', value: 'nested' } }]
        },
        {
            op: 'edit', path: [3],
            fields: [{ id: 'filter.value', value: { kind: 'text', value: 'sibling' } }]
        },
        { op: 'insert', collection_path: [], index: 2, filter_kind: 'wmi', fields: [] }
    ]);
});

test('preference create form selects an opaque parent only when candidates are available', async () => {
    const creates = [];
    let showCalls = 0;
    const rootCandidate = {
        identity: null, label: 'Root', parent_identity: null, depth: 0
    };
    const nestedCandidate = {
        identity: ['opaque', 'collection'], label: 'Nested',
        parent_identity: null, depth: 1
    };
    const API = {
        preferenceItems: async () => ({ items: [] }),
        preferenceShow: async () => {
            showCalls += 1;
            return {
                item: null,
                fields: [{
                    id: 'properties.name', label: 'Name', required: true, editable: true,
                    value: { kind: 'text', value: '' }
                }],
                new_item_fields: [{
                    id: 'properties.name', label: 'Name', required: true, editable: true,
                    value: { kind: 'text', value: '' }
                }],
                parent_candidates: showCalls === 1
                    ? [rootCandidate, nestedCandidate] : [rootCandidate],
                filters: [], filter_fields: [], filter_kinds: []
            };
        },
        preferenceCreate: async (scope, kind, request) => {
            creates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'registry',
            document: { label: 'Registry', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();
    const createButton = header.getElement().querySelector('.preferences__btn-create');
    assert.equal(root.classList.contains('gp__preference'), true);
    assert.equal(root.classList.contains('gpo-editor-preferences'), true);

    createButton.click();
    await flushPreferenceRenderer();
    const parentSelect = root.querySelector('.gpo-editor-preference-parent select');
    assert.ok(parentSelect);
    assert.equal(parentSelect.value, '0');
    assert.equal(parentSelect.querySelectorAll('option').length, 2);
    parentSelect.value = '1';
    parentSelect.dispatchEvent(new TestEvent('change'));
    const nameInput = root.querySelector('[data-field-id="properties.name"]').querySelector('input');
    nameInput.value = 'Created';
    nameInput.dispatchEvent(new TestEvent('input'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();

    assert.deepEqual(creates, [{
        scope: 'computer',
        kind: 'registry',
        request: {
            fields: [{
                id: 'properties.name', value: { kind: 'text', value: 'Created' }
            }],
            parent: ['opaque', 'collection']
        }
    }]);

    createButton.click();
    await flushPreferenceRenderer();
    assert.equal(root.querySelector('.gpo-editor-preference-parent'), null);
});

test('user INI create keeps optional text editable and renders booleans with descriptor defaults', async () => {
    const creates = [];
    const API = {
        preferenceItems: async () => ({ items: [] }),
        preferenceShow: async () => ({
            item: null,
            fields: [],
            new_item_fields: [
                {
                    id: 'metadata.userContext', label: 'User context', required: false, editable: true,
                    control: 'optional_toggle', value: { kind: 'optional_boolean', value: null }
                },
                {
                    id: 'metadata.bypassErrors', label: 'Bypass errors', required: false, editable: true,
                    control: 'optional_toggle', value: { kind: 'optional_boolean', value: null }
                },
                {
                    id: 'metadata.removePolicy', label: 'Remove policy', required: false, editable: true,
                    control: 'optional_toggle', value: { kind: 'optional_boolean', value: true }
                },
                {
                    id: 'properties.path', label: 'Path', required: true, editable: true,
                    value: { kind: 'text', value: '' }
                },
                {
                    id: 'properties.section', label: 'Section', required: false, editable: true,
                    value: { kind: 'optional_text', value: null }
                },
                {
                    id: 'properties.property', label: 'Property', required: false, editable: true,
                    value: { kind: 'optional_text', value: null }
                },
                {
                    id: 'properties.value', label: 'Value', required: false, editable: true,
                    value: { kind: 'optional_text', value: null }
                },
                {
                    id: 'properties.disabled', label: 'Disabled', required: false, editable: true,
                    control: 'optional_boolean_u8',
                    value: { kind: 'optional_unsigned_byte', value: null }
                }
            ],
            parent_candidates: [], filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceCreate: async (scope, kind, request) => {
            creates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'user', preferenceKind: 'ini_files',
            document: { label: 'INI Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    header.getElement().querySelector('.preferences__btn-create').click();
    await flushPreferenceRenderer();

    const userContextField = root.querySelector('[data-field-id="metadata.userContext"]');
    const userContext = userContextField.querySelector('input[type="checkbox"]');
    assert.ok(userContextField.textContent.includes('preferences.editor.userContext'));
    assert.equal(userContext.checked, false);
    ['properties.section', 'properties.property', 'properties.value'].forEach((id) => {
        const input = root.querySelector('[data-field-id="' + id + '"]').querySelector('input');
        assert.equal(input.disabled, false);
    });
    assert.equal(root.querySelectorAll('.gpo-editor-field select').length, 0);
    const bypass = root.querySelector('[data-field-id="metadata.bypassErrors"]')
        .querySelector('input[type="checkbox"]');
    const disabled = root.querySelector('[data-field-id="properties.disabled"]')
        .querySelector('input[type="checkbox"]');
    const removePolicy = root.querySelector('[data-field-id="metadata.removePolicy"]')
        .querySelector('input[type="checkbox"]');
    assert.equal(bypass.checked, false);
    assert.equal(removePolicy.checked, true);
    assert.equal(disabled.checked, false);

    const values = {
        'properties.path': '/etc/example.ini',
        'properties.section': 'desktop',
        'properties.property': 'cursor-size',
        'properties.value': '48'
    };
    Object.entries(values).forEach(([id, value]) => {
        const input = root.querySelector('[data-field-id="' + id + '"]').querySelector('input');
        input.value = value;
        input.dispatchEvent(new TestEvent('input'));
    });
    bypass.checked = true;
    bypass.dispatchEvent(new TestEvent('change'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();

    assert.deepEqual(creates, [{
        scope: 'user',
        kind: 'ini_files',
        request: {
            fields: [
                { id: 'metadata.userContext', value: { kind: 'optional_boolean', value: false } },
                { id: 'metadata.bypassErrors', value: { kind: 'optional_boolean', value: true } },
                { id: 'metadata.removePolicy', value: { kind: 'optional_boolean', value: true } },
                { id: 'properties.path', value: { kind: 'text', value: '/etc/example.ini' } },
                { id: 'properties.section', value: { kind: 'optional_text', value: 'desktop' } },
                { id: 'properties.property', value: { kind: 'optional_text', value: 'cursor-size' } },
                { id: 'properties.value', value: { kind: 'optional_text', value: '48' } },
                { id: 'properties.disabled', value: { kind: 'optional_unsigned_byte', value: 0 } }
            ]
        }
    }]);
});

test('computer preference create hides and omits a legacy userContext descriptor', async () => {
    const creates = [];
    const API = {
        preferenceItems: async () => ({ items: [] }),
        preferenceShow: async () => ({
            item: null,
            fields: [],
            new_item_fields: [
                {
                    id: 'metadata.userContext', label: 'User context', required: false, editable: true,
                    control: 'optional_toggle', value: { kind: 'optional_boolean', value: true }
                },
                {
                    id: 'properties.path', label: 'Path', required: true, editable: true,
                    value: { kind: 'text', value: '' }
                }
            ],
            parent_candidates: [], filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceCreate: async (scope, kind, request) => {
            creates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'ini_files',
            document: { label: 'INI Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    header.getElement().querySelector('.preferences__btn-create').click();
    await flushPreferenceRenderer();
    assert.equal(root.querySelector('[data-field-id="metadata.userContext"]'), null);
    const path = root.querySelector('[data-field-id="properties.path"]').querySelector('input');
    path.value = '/etc/computer.ini';
    path.dispatchEvent(new TestEvent('input'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();

    assert.deepEqual(creates, [{
        scope: 'computer',
        kind: 'ini_files',
        request: {
            fields: [{
                id: 'properties.path', value: { kind: 'text', value: '/etc/computer.ini' }
            }]
        }
    }]);
});

test('pending preference form open blocks every competing item mutation', async () => {
    let resolveShow;
    let showCalls = 0;
    const pendingShow = new Promise((resolve) => { resolveShow = resolve; });
    const calls = { create: 0, delete: 0, confirm: 0 };
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'opening'], label: 'Opening item', has_filters: false }]
        }),
        preferenceShow: () => {
            showCalls += 1;
            return pendingShow;
        },
        preferenceCreate: async () => { calls.create += 1; return {}; },
        preferenceDelete: async () => { calls.delete += 1; return {}; },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API, () => {
        calls.confirm += 1;
        return true;
    });
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();
    const headerElement = header.getElement();
    const createButton = headerElement.querySelector('.preferences__btn-create');
    const editButton = headerElement.querySelector('.preferences__btn-edit');
    const deleteButton = headerElement.querySelector('.preferences__btn-delete');

    root.querySelector('tbody tr').click();
    editButton.click();

    assert.equal(showCalls, 1);
    assert.equal(root.classList.contains('gpo-editor-preferences--opening'), true);
    assert.equal(root.getAttribute('aria-busy'), 'true');
    assert.equal(createButton.classList.contains('active'), false);
    assert.equal(editButton.classList.contains('active'), false);
    assert.equal(deleteButton.classList.contains('active'), false);
    assert.equal(root.querySelector('.gpo-editor-preference-table__actions button').disabled, true);

    createButton.click();
    editButton.click();
    deleteButton.click();
    root.querySelector('.gpo-editor-preference-table__actions button').click();
    root.querySelector('tbody tr').dispatchEvent(new TestEvent('dblclick'));
    assert.equal(showCalls, 1);
    assert.deepEqual(calls, { create: 0, delete: 0, confirm: 0 });
    assert.equal(root.querySelector('.gpo-editor-preference-table__actions button').disabled, true);

    resolveShow({
        item: { identity: ['opaque', 'opening'], label: 'Opening item' },
        fields: [{
            id: 'properties.value', label: 'Value', required: true, editable: true,
            value: { kind: 'text', value: 'before' }
        }],
        filters: [], filter_fields: [], filter_kinds: []
    });
    await flushPreferenceRenderer();

    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(root.classList.contains('gpo-editor-preferences--opening'), false);
    assert.equal(root.hasAttribute('aria-busy'), false);
    assert.equal(showCalls, 1);
});

test('read-only preference item opens details without mutation controls', async () => {
    const calls = { show: 0, create: 0, update: 0, delete: 0 };
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'readonly'], label: 'Read-only item', has_filters: false }]
        }),
        preferenceShow: async () => {
            calls.show += 1;
            return {
                item: { identity: ['opaque', 'readonly'], label: 'Read-only item' },
                fields: [{
                    id: 'properties.path', label: 'Path', required: true, editable: true,
                    value: { kind: 'text', value: '/srv/readonly' }
                }],
                filters: [], filter_fields: [], filter_kinds: []
            };
        },
        preferenceCreate: async () => { calls.create += 1; },
        preferenceUpdate: async () => { calls.update += 1; },
        preferenceDelete: async () => { calls.delete += 1; },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: false }
        },
        isCurrent: () => true
    });
    const root = view.getElement();
    const detailsButton = root.querySelector('.gpo-editor-preference-table__actions').querySelector('button');

    detailsButton.click();
    await flushPreferenceRenderer();

    assert.equal(calls.show, 1);
    assert.ok(root.querySelector('.preference__modal--readonly'));
    assert.equal(root.querySelector('.btn-ok'), null);
    assert.equal(header.getElement().querySelector('.gp__control').style.display, 'none');
    assert.equal(root.querySelector('[data-field-id="properties.path"]').querySelector('input').disabled, true);
    assert.ok(root.querySelectorAll('.gpo-editor-filters__toolbar button').every((button) => button.disabled));
    assert.deepEqual(calls, { show: 1, create: 0, update: 0, delete: 0 });
});

test('editable preference update submits rename and one changed typed field exactly once', async () => {
    const updates = [];
    let itemLoads = 0;
    const API = {
        preferenceItems: async () => {
            itemLoads += 1;
            return { items: [{ identity: ['opaque', 'editable'], label: 'Original item', has_filters: false }] };
        },
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'editable'], label: 'Original item' },
            fields: [
                {
                    id: 'properties.value', label: 'Value', required: true, editable: true,
                    value: { kind: 'text', value: 'unchanged' }
                },
                {
                    id: 'properties.disabled', label: 'Disabled', required: false, editable: true,
                    value: { kind: 'optional_boolean', value: null }
                }
            ],
            filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceUpdate: async (scope, kind, request) => {
            updates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'user', preferenceKind: 'environment_variables',
            document: { label: 'Environment', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    const nameInput = root.querySelector('[data-field-id="name"]').querySelector('input');
    const disabledCheckbox = root.querySelector('[data-field-id="properties.disabled"]')
        .querySelector('input[type="checkbox"]');
    nameInput.value = 'Renamed item';
    nameInput.dispatchEvent(new TestEvent('input'));
    assert.equal(disabledCheckbox.checked, false);
    disabledCheckbox.dispatchEvent(new TestEvent('change'));

    assert.equal(view.hasUnsavedChanges(), true);
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();

    assert.deepEqual(updates, [{
        scope: 'user',
        kind: 'environment_variables',
        request: {
            identity: ['opaque', 'editable'],
            fields: [{
                id: 'properties.disabled',
                value: { kind: 'optional_boolean', value: false }
            }],
            name: 'Renamed item'
        }
    }]);
    assert.equal(itemLoads, 2);
    assert.equal(root.querySelector('.preference__modal'), null);
});

test('generic preference choice controls keep Unknown unchanged and submit selected keys', async () => {
    const updates = [];
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'choice'], label: 'Choice item', has_filters: false }]
        }),
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'choice'], label: 'Choice item' },
            fields: [{
                id: 'filter.languageLocale', label: 'Language', required: true, editable: true,
                control: 'choice',
                value: { kind: 'text', value: 'unknown' },
                choices: [
                    { key: 'unknown', label: 'Unknown' },
                    { key: 'en-US', label: 'English (United States)' },
                    { key: 'ru-MD', label: 'Russian (Moldova)' }
                ]
            }],
            filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceUpdate: async (scope, kind, request) => {
            updates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'computer', preferenceKind: 'ini_files',
            document: { label: 'Ini Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    let select = root.querySelector('[data-field-id="filter.languageLocale"]').querySelector('select');
    assert.equal(select.value, 'unknown');
    assert.deepEqual(select.children.map((option) => [option.value, option.textContent]), [
        ['unknown', 'Unknown'],
        ['en-US', 'English (United States)'],
        ['ru-MD', 'Russian (Moldova)']
    ]);
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();
    assert.deepEqual(updates, []);

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    select = root.querySelector('[data-field-id="filter.languageLocale"]').querySelector('select');
    select.value = 'ru-MD';
    select.dispatchEvent(new TestEvent('change'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();
    assert.deepEqual(updates, [{
        scope: 'computer',
        kind: 'ini_files',
        request: {
            identity: ['opaque', 'choice'],
            fields: [{ id: 'filter.languageLocale', value: { kind: 'text', value: 'ru-MD' } }]
        }
    }]);
});

test('failed preference save keeps the complete draft and form available for retry', async () => {
    const updates = [];
    let rejectUpdate;
    const pendingUpdate = new Promise((resolve, reject) => { rejectUpdate = reject; });
    const failure = Object.assign(new Error('Server rejected the value'), {
        category: 'validation', field: 'properties.value'
    });
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'draft'], label: 'Draft item', has_filters: false }]
        }),
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'draft'], label: 'Draft item' },
            fields: [
                {
                    id: 'properties.value', label: 'Value', required: true, editable: true,
                    value: { kind: 'text', value: 'before' }
                },
                {
                    id: 'metadata.generated', label: 'Generated', required: false, editable: false,
                    value: { kind: 'text', value: 'server-owned' }
                }
            ],
            filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceUpdate: (scope, kind, request) => {
            updates.push({ scope, kind, request: plain(request) });
            return pendingUpdate;
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'computer', preferenceKind: 'registry',
            document: { label: 'Registry', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    const valueInput = root.querySelector('[data-field-id="properties.value"]').querySelector('input');
    const readonlyInput = root.querySelector('[data-field-id="metadata.generated"]').querySelector('input');
    valueInput.value = 'unsaved draft';
    valueInput.dispatchEvent(new TestEvent('input'));
    root.querySelector('.btn-ok').click();

    assert.equal(valueInput.disabled, true);
    assert.equal(readonlyInput.disabled, true);
    assert.equal(root.querySelector('.close').disabled, true);
    assert.equal(root.querySelector('.btn-cancel').disabled, true);
    rejectUpdate(failure);
    await flushPreferenceRenderer();

    assert.equal(updates.length, 1);
    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(valueInput.value, 'unsaved draft');
    assert.equal(view.hasUnsavedChanges(), true);
    assert.equal(root.querySelector('.gpo-editor-preference-form__error .gpo-editor-status')
        .getAttribute('data-error-category'), 'validation');
    assert.equal(valueInput.disabled, false);
    assert.equal(readonlyInput.disabled, true);
    assert.equal(root.querySelector('.close').disabled, false);
    assert.equal(root.querySelector('.btn-cancel').disabled, false);
    assert.equal(root.querySelector('.btn-ok').disabled, false);
});

test('pending preference save disables every close path and cannot be discarded', async () => {
    let resolveUpdate;
    let updates = 0;
    const pendingUpdate = new Promise((resolve) => { resolveUpdate = resolve; });
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'pending'], label: 'Pending item', has_filters: false }]
        }),
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'pending'], label: 'Pending item' },
            fields: [
                {
                    id: 'properties.value', label: 'Value', required: true, editable: true,
                    value: { kind: 'text', value: 'before' }
                },
                {
                    id: 'metadata.generated', label: 'Generated', required: false, editable: false,
                    value: { kind: 'text', value: 'server-owned' }
                }
            ],
            filters: [{
                path: [0], kind: 'group', label: 'Filter', depth: 0,
                child_count: 0, supports_children: false
            }],
            filter_fields: [{
                path: [0], available: true, fields: [{
                    id: 'filter.value', label: 'Filter value', required: true, editable: true,
                    value: { kind: 'text', value: 'filter draft' }
                }]
            }],
            filter_kinds: [{
                kind: 'group', label: 'Group', supports_children: false, fields: []
            }]
        }),
        preferenceUpdate: () => {
            updates += 1;
            return pendingUpdate;
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    let filterNode = root.querySelector('.gpo-editor-filter-node');
    filterNode.click();
    filterNode = root.querySelector('.gpo-editor-filter-node');
    const valueInput = root.querySelector('[data-field-id="properties.value"]').querySelector('input');
    const readonlyInput = root.querySelector('[data-field-id="metadata.generated"]').querySelector('input');
    const filterInput = root.querySelector('[data-field-id="filter.value"]').querySelector('input');
    valueInput.value = 'pending draft';
    valueInput.dispatchEvent(new TestEvent('input'));
    const saveButton = root.querySelector('.btn-ok');
    const closeButton = root.querySelector('.close');
    const cancelButton = root.querySelector('.btn-cancel');
    saveButton.click();

    assert.equal(updates, 1);
    assert.equal(saveButton.disabled, true);
    assert.equal(closeButton.disabled, true);
    assert.equal(cancelButton.disabled, true);
    assert.equal(valueInput.disabled, true);
    assert.equal(readonlyInput.disabled, true);
    assert.equal(filterInput.disabled, true);
    assert.equal(filterNode.disabled, true);
    for (const selector of ['input', 'select', 'button']) {
        assert.ok(root.querySelector('.preference__modal').querySelectorAll(selector)
            .every((element) => element.disabled));
    }
    assert.equal(view.hasUnsavedChanges(), true);
    assert.ok(root.querySelector('.preference__modal'));
    for (const selector of [
        '.preferences__btn-create', '.preferences__btn-edit', '.preferences__btn-delete'
    ]) {
        assert.equal(header.getElement().querySelector(selector).classList.contains('active'), false);
    }

    closeButton.click();
    cancelButton.click();
    assert.equal(view.cancelChanges(), false);
    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(valueInput.value, 'pending draft');

    resolveUpdate({});
    await flushPreferenceRenderer();

    assert.equal(updates, 1);
    assert.equal(root.querySelector('.preference__modal'), null);
});

test('preference reconciliation conflict stays visible without discarding the draft', async () => {
    let reconciliations = 0;
    const publicationFailure = Object.assign(new Error('Publication pending'), {
        category: 'publication_conflict'
    });
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'conflict'], label: 'Conflict item', has_filters: false }]
        }),
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'conflict'], label: 'Conflict item' },
            fields: [{
                id: 'properties.value', label: 'Value', required: true, editable: true,
                value: { kind: 'text', value: 'before' }
            }],
            filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceUpdate: async () => { throw publicationFailure; },
        reconcile: async () => {
            reconciliations += 1;
            return {
                recovery: {
                    kind: 'conflict',
                    conflict: { conflict_fields: ['version'], safe_next_actions: ['refresh'] }
                }
            };
        }
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    const valueInput = root.querySelector('[data-field-id="properties.value"]').querySelector('input');
    valueInput.value = 'conflicted draft';
    valueInput.dispatchEvent(new TestEvent('input'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();
    root.querySelector('.gpo-editor-status__reconcile').click();
    await flushPreferenceRenderer();

    assert.equal(reconciliations, 1);
    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(valueInput.value, 'conflicted draft');
    assert.equal(view.hasUnsavedChanges(), true);
    const visibleError = root.querySelector('.gpo-editor-preference-form__error .gpo-editor-status');
    assert.equal(visibleError.getAttribute('data-error-category'), 'publication_conflict');
    assert.match(visibleError.textContent, /still conflicted/);
});

test('successful preference reconciliation preserves the draft and requires refresh', async () => {
    let updates = 0;
    let reconciliations = 0;
    let itemLoads = 0;
    let resolveReconcile;
    const pendingReconcile = new Promise((resolve) => { resolveReconcile = resolve; });
    const publicationFailure = Object.assign(new Error('Publication pending'), {
        category: 'publication_conflict'
    });
    const API = {
        preferenceItems: async () => {
            itemLoads += 1;
            return {
                items: [{ identity: ['opaque', 'reconciled'], label: 'Reconciled item', has_filters: false }]
            };
        },
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'reconciled'], label: 'Reconciled item' },
            fields: [{
                id: 'properties.value', label: 'Value', required: true, editable: true,
                value: { kind: 'text', value: 'before' }
            }],
            filters: [], filter_fields: [], filter_kinds: []
        }),
        preferenceUpdate: async () => {
            updates += 1;
            throw publicationFailure;
        },
        reconcile: () => {
            reconciliations += 1;
            return pendingReconcile;
        }
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    const valueInput = root.querySelector('[data-field-id="properties.value"]').querySelector('input');
    valueInput.value = 'reconciled draft';
    valueInput.dispatchEvent(new TestEvent('input'));
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();
    const reconcileButton = root.querySelector('.gpo-editor-status__reconcile');
    reconcileButton.click();

    assert.equal(valueInput.disabled, true);
    assert.equal(root.querySelector('.close').disabled, true);
    assert.equal(root.querySelector('.btn-cancel').disabled, true);
    assert.equal(root.querySelector('.btn-ok').disabled, true);
    assert.equal(reconcileButton.disabled, true);
    resolveReconcile({ recovery: { kind: 'clean' } });
    await flushPreferenceRenderer();

    const saveButton = root.querySelector('.btn-ok');
    assert.equal(updates, 1);
    assert.equal(reconciliations, 1);
    assert.equal(itemLoads, 2);
    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(valueInput.value, 'reconciled draft');
    assert.equal(view.hasUnsavedChanges(), true);
    assert.equal(saveButton.disabled, true);
    assert.equal(valueInput.disabled, true);
    assert.equal(root.querySelector('.close').disabled, false);
    assert.equal(root.querySelector('.btn-cancel').disabled, false);
    assert.ok(root.querySelector('.gpo-editor-preference-notice--info'));
    assert.equal(root.querySelector('.gpo-editor-status__action').disabled, false);

    saveButton.click();
    await flushPreferenceRenderer();
    assert.equal(updates, 1);
    assert.ok(root.querySelector('.preference__modal'));
});

test('open preference modal blocks header mutations and the delete path', async () => {
    const calls = { show: 0, create: 0, delete: 0, confirm: 0 };
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'selected'], label: 'Selected item', has_filters: false }]
        }),
        preferenceShow: async () => {
            calls.show += 1;
            return {
                item: { identity: ['opaque', 'selected'], label: 'Selected item' },
                fields: [{
                    id: 'properties.value', label: 'Value', required: true, editable: true,
                    value: { kind: 'text', value: 'before' }
                }],
                filters: [], filter_fields: [], filter_kinds: []
            };
        },
        preferenceCreate: async () => { calls.create += 1; return {}; },
        preferenceDelete: async () => { calls.delete += 1; return {}; },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API, () => {
        calls.confirm += 1;
        return true;
    });
    const header = preferenceTestHeader();
    const view = await renderer.renderPreferencesTemplate({
        header,
        item: {
            scope: 'computer', preferenceKind: 'files',
            document: { label: 'Files', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();
    const headerElement = header.getElement();
    const createButton = headerElement.querySelector('.preferences__btn-create');
    const editButton = headerElement.querySelector('.preferences__btn-edit');
    const deleteButton = headerElement.querySelector('.preferences__btn-delete');

    root.querySelector('tbody tr').click();
    assert.equal(createButton.classList.contains('active'), true);
    assert.equal(editButton.classList.contains('active'), true);
    assert.equal(deleteButton.classList.contains('active'), true);
    editButton.click();
    await flushPreferenceRenderer();

    assert.equal(calls.show, 1);
    assert.ok(root.querySelector('.preference__modal'));
    assert.equal(createButton.classList.contains('active'), false);
    assert.equal(editButton.classList.contains('active'), false);
    assert.equal(deleteButton.classList.contains('active'), false);

    createButton.click();
    editButton.click();
    deleteButton.click();
    await flushPreferenceRenderer();
    assert.deepEqual(calls, { show: 1, create: 0, delete: 0, confirm: 0 });
    assert.ok(root.querySelector('.preference__modal'));

    root.querySelector('.btn-cancel').click();
    assert.equal(root.querySelector('.preference__modal'), null);
    assert.equal(createButton.classList.contains('active'), true);
    assert.equal(editButton.classList.contains('active'), true);
    assert.equal(deleteButton.classList.contains('active'), true);

    deleteButton.click();
    await flushPreferenceRenderer();
    assert.deepEqual(calls, { show: 1, create: 0, delete: 1, confirm: 1 });
});

test('preference filter removal publishes one safe structural operation for the subtree', async () => {
    const updates = [];
    const API = {
        preferenceItems: async () => ({
            items: [{ identity: ['opaque', 'filters'], label: 'Filtered item', has_filters: true }]
        }),
        preferenceShow: async () => ({
            item: { identity: ['opaque', 'filters'], label: 'Filtered item' },
            fields: [{
                id: 'properties.value', label: 'Value', required: true, editable: true,
                value: { kind: 'text', value: 'unchanged' }
            }],
            filters: [
                {
                    path: [2], kind: 'collection', label: 'Parent', depth: 0,
                    child_count: 1, supports_children: true
                },
                {
                    path: [2, 0], kind: 'group', label: 'Child', depth: 1,
                    child_count: 0, supports_children: false
                }
            ],
            filter_fields: [
                { path: [2], available: true, fields: [] },
                { path: [2, 0], available: true, fields: [] }
            ],
            filter_kinds: [
                { kind: 'collection', label: 'Collection', supports_children: true, fields: [] },
                { kind: 'group', label: 'Group', supports_children: false, fields: [] }
            ]
        }),
        preferenceUpdate: async (scope, kind, request) => {
            updates.push({ scope, kind, request: plain(request) });
            return {};
        },
        reconcile: async () => ({ recovery: { kind: 'clean' } })
    };
    const renderer = loadPreferenceRenderer(API);
    const view = await renderer.renderPreferencesTemplate({
        header: preferenceTestHeader(),
        item: {
            scope: 'computer', preferenceKind: 'registry',
            document: { label: 'Registry', editable: true }
        },
        isCurrent: () => true
    });
    const root = view.getElement();

    root.querySelector('.gpo-editor-preference-table__actions').querySelector('button').click();
    await flushPreferenceRenderer();
    const filterNodes = root.querySelectorAll('.gpo-editor-filter-node');
    assert.equal(filterNodes.length, 2);
    filterNodes[0].click();
    root.querySelector('.gpo-editor-filter-remove').click();

    assert.equal(root.querySelectorAll('.gpo-editor-filter-node').length, 0);
    assert.equal(root.querySelector('.gpo-editor-filter-add').disabled, true);
    assert.equal(view.hasUnsavedChanges(), true);
    root.querySelector('.btn-ok').click();
    await flushPreferenceRenderer();

    assert.deepEqual(updates, [{
        scope: 'computer',
        kind: 'registry',
        request: {
            identity: ['opaque', 'filters'],
            filters: [{ op: 'remove', path: [2] }]
        }
    }]);
});

test('tree navigation loads returned category ids lazily and uses server document inventory', async () => {
    const childCalls = [];
    const API = {
        getDisplayName: () => 'Policy',
        open: () => Promise.resolve({}),
        children(scope, categoryId) {
            childCalls.push([scope, categoryId]);
            return Promise.resolve({ children: [
                { kind: 'category', id: 'opaque-child', label: 'Child' },
                { kind: 'policy', id: 'opaque-policy', label: 'Policy setting' }
            ] });
        }
    };
    const tree = loadAmd('js/components/tree-view/tree-view-list-data.js', {
        '../../locales/translations': { t: (key) => key },
        '../../util/API': API
    });
    const roots = tree.buildTreeViewList({
        gpo: { displayname: 'Policy' },
        preference_documents: [
            { scope: 'computer', kind: 'ini_files', label: 'INI Files', editable: true },
            { scope: 'user', kind: 'registry', label: 'Registry', editable: false }
        ]
    });
    const computerTemplates = roots[0].children[0].children[0];
    assert.equal(childCalls.length, 0);
    const children = await computerTemplates.loadChildren();
    assert.deepEqual(childCalls, [['computer', null]]);
    assert.equal(children[0].categoryId, 'opaque-child');
    assert.equal(children[1].policyId, 'opaque-policy');
    const computerPreferences = roots[0].children[0].children[1].children;
    const userPreferences = roots[0].children[1].children[1].children;
    assert.equal(computerPreferences[0].preferenceKind, 'ini_files');
    assert.equal(userPreferences[0].readOnly, true);
});

test('left tree renders folders only while keeping leaf documents navigable from folder views', async () => {
    const treeList = loadAmd('js/components/tree-view/tree-view-list.js', {
        '../../util/element-creator': { createElement: createTestElement }
    }, { document: new TestDocument(), Element: TestElement });
    const policy = {
        title: 'Cursor Size',
        type: 'file',
        icon: 'ico-file',
        template: 'admx'
    };
    const nestedCategory = {
        title: 'Vision',
        type: 'folder',
        icon: 'ico-folder',
        opened: false,
        children: [policy]
    };
    const preference = {
        title: 'INI Files',
        type: 'file',
        icon: 'ico-file',
        template: 'preferences'
    };
    const preferencesCategory = {
        title: 'Preferences',
        type: 'folder',
        icon: 'ico-folder',
        opened: false,
        children: [preference]
    };
    const parents = new Map();
    const state = {
        setWorkspace() {},
        setTreeData() {},
        registerTreeNode(item, options) {
            if (options.parentItem) parents.set(item, options.parentItem);
        },
        navigateToNode() {}
    };

    const rendered = treeList.renderTreeViewList(
        [nestedCategory, preferencesCategory],
        {},
        state
    ).getElement();
    const titles = rendered.querySelectorAll('.tree-item__title')
        .map((element) => element.textContent);

    assert.deepEqual(titles, ['Vision', 'Preferences']);
    assert.equal(rendered.querySelectorAll('li.file').length, 0);
    assert.equal(parents.get(policy), nestedCategory);
    assert.equal(parents.get(preference), preferencesCategory);
});

test('lazy tree loading adds only returned categories to the left tree', async () => {
    const treeList = loadAmd('js/components/tree-view/tree-view-list.js', {
        '../../util/element-creator': { createElement: createTestElement }
    }, { document: new TestDocument(), Element: TestElement });
    const policy = { title: 'Policy setting', type: 'file', icon: 'ico-file' };
    const category = {
        title: 'Child category', type: 'folder', icon: 'ico-folder', opened: false, children: []
    };
    const lazyFolder = {
        title: 'Administrative Templates',
        type: 'folder',
        icon: 'ico-folder',
        opened: false,
        lazy: true,
        loaded: false,
        children: [],
        loadChildren() { return Promise.resolve([category, policy]); }
    };
    const parents = new Map();
    const state = {
        setWorkspace() {},
        setTreeData() {},
        registerTreeNode(item, options) {
            if (options.parentItem) parents.set(item, options.parentItem);
        },
        navigateToNode() {}
    };
    const rendered = treeList.renderTreeViewList([lazyFolder], {}, state).getElement();
    const lazyListItem = rendered.querySelector('li.folder');

    const loaded = await treeList.ensureLazyChildren(lazyFolder, lazyListItem, state);
    const titles = rendered.querySelectorAll('.tree-item__title')
        .map((element) => element.textContent);

    assert.deepEqual(plain(loaded), [category, policy]);
    assert.deepEqual(titles, ['Administrative Templates', 'Child category']);
    assert.equal(rendered.querySelectorAll('li.file').length, 0);
    assert.equal(parents.get(policy), lazyFolder);
});

test('right-pane navigation loads a lazy folder before replacing the workspace view', async () => {
    const renderedChildren = [];
    let loadCount = 0;
    const loadedPolicy = { type: 'file', template: 'admx', policyId: 'opaque-policy' };
    const nestedFolder = {
        type: 'folder', lazy: true, loaded: false, opened: false,
        categoryId: 'opaque-nested', children: []
    };
    const app = loadAmd('js/app.js', {
        './components/header/header': {},
        './components/main/main': {},
        './components/footer/footer': {},
        './util/resizable': {},
        './components/templates/default-template': {},
        './components/templates/admx-template': {},
        './components/templates/folder-template': {
            renderFolderTemplate(options) {
                renderedChildren.push(options.children.slice());
                return {};
            },
            renderHelpBlock() { return null; }
        },
        './components/templates/preference/preferences-view-template': {},
        './components/tree-view/tree-view-list': {
            setTreeItemActive() { return null; },
            setFolderOpenedState(listItem, item, opened) {
                item.opened = Boolean(opened);
                return item.opened;
            },
            ensureLazyChildren(item) {
                if (item.loadingPromise) return item.loadingPromise;
                loadCount += 1;
                item.loadingPromise = Promise.resolve().then(function() {
                    item.children = item === nestedFolder ? [loadedPolicy] : [nestedFolder];
                    item.loaded = true;
                    item.loadingPromise = null;
                    return item.children;
                });
                return item.loadingPromise;
            }
        },
        './util/element-creator': {},
        './components/editor-status': {},
        './locales/translations': { t: (key) => key },
        './util/API': {}
    });
    const state = app._test.createTreeViewState();
    const lazyFolder = {
        type: 'folder', lazy: true, loaded: false, opened: false, children: []
    };
    state.treeListItemElements.set(lazyFolder, {});
    state.treeListItemElements.set(nestedFolder, {});

    const firstOpen = state.navigateToNode(lazyFolder, { openPath: true, openCurrentFolder: true });
    const concurrentOpen = state.navigateToNode(lazyFolder, { openPath: true, openCurrentFolder: true });
    await Promise.all([firstOpen, concurrentOpen]);
    await state.navigateToNode(lazyFolder, { openPath: true, openCurrentFolder: true });
    await state.navigateToNode(nestedFolder, { openPath: true, openCurrentFolder: true });

    assert.equal(loadCount, 2);
    assert.equal(lazyFolder.opened, true);
    assert.equal(nestedFolder.opened, true);
    assert.equal(state.selectedItem.item, nestedFolder);
    assert.equal(nestedFolder.categoryId, 'opaque-nested');
    assert.deepEqual(plain(renderedChildren), [
        [nestedFolder], [nestedFolder], [loadedPolicy]
    ]);
});

test('an older lazy completion cannot replace a newer navigation', async () => {
    const rendered = [];
    const resolvers = new Map();
    const app = loadAmd('js/app.js', {
        './components/header/header': {},
        './components/main/main': {},
        './components/footer/footer': {},
        './util/resizable': {},
        './components/templates/default-template': {},
        './components/templates/admx-template': {},
        './components/templates/folder-template': {
            renderFolderTemplate(options) {
                rendered.push(options.children[0].policyId);
                return {};
            },
            renderHelpBlock() { return null; }
        },
        './components/templates/preference/preferences-view-template': {},
        './components/tree-view/tree-view-list': {
            setTreeItemActive() { return null; },
            setFolderOpenedState(listItem, item, opened) {
                item.opened = Boolean(opened);
                return item.opened;
            },
            ensureLazyChildren(item) {
                if (item.loadingPromise) return item.loadingPromise;
                item.loadingPromise = new Promise((resolve) => {
                    resolvers.set(item, function() {
                        item.children = [{ type: 'file', policyId: item.categoryId + '-policy' }];
                        item.loaded = true;
                        item.loadingPromise = null;
                        resolve(item.children);
                    });
                });
                return item.loadingPromise;
            }
        },
        './util/element-creator': {},
        './components/editor-status': {},
        './locales/translations': { t: (key) => key },
        './util/API': {}
    });
    const state = app._test.createTreeViewState();
    const older = { type: 'folder', lazy: true, loaded: false, categoryId: 'older', children: [] };
    const newer = { type: 'folder', lazy: true, loaded: false, categoryId: 'newer', children: [] };
    state.treeListItemElements.set(older, {});
    state.treeListItemElements.set(newer, {});

    const olderNavigation = state.navigateToNode(older, { openCurrentFolder: true });
    const newerNavigation = state.navigateToNode(newer, { openCurrentFolder: true });
    resolvers.get(newer)();
    await newerNavigation;
    resolvers.get(older)();
    assert.equal(await olderNavigation, false);

    assert.equal(state.selectedItem.item, newer);
    assert.deepEqual(rendered, ['newer-policy']);
});

test('lazy completion rechecks a draft created while the request was loading', async () => {
    let resolveLoad;
    let dirty = false;
    let renderCount = 0;
    const app = loadAmd('js/app.js', {
        './components/header/header': {},
        './components/main/main': {},
        './components/footer/footer': {},
        './util/resizable': {},
        './components/templates/default-template': {},
        './components/templates/admx-template': {},
        './components/templates/folder-template': {
            renderFolderTemplate() {
                renderCount += 1;
                return {};
            },
            renderHelpBlock() { return null; }
        },
        './components/templates/preference/preferences-view-template': {},
        './components/tree-view/tree-view-list': {
            setTreeItemActive() { return null; },
            setFolderOpenedState() { return true; },
            ensureLazyChildren(item) {
                return new Promise((resolve) => {
                    resolveLoad = function() {
                        item.children = [{ type: 'file', policyId: 'loaded-policy' }];
                        item.loaded = true;
                        resolve(item.children);
                    };
                });
            }
        },
        './util/element-creator': {},
        './components/editor-status': {},
        './locales/translations': { t: (key) => key },
        './util/API': {}
    });
    const state = app._test.createTreeViewState();
    const current = { type: 'folder', children: [] };
    const target = { type: 'folder', lazy: true, loaded: false, children: [] };
    state.selectedItem = { item: current, element: null };
    state.selectedPath = [current];
    state.currentView = {
        hasUnsavedChanges() { return dirty; },
        cancelChanges() { dirty = false; }
    };
    state.treeListItemElements.set(target, {});

    const navigation = state.navigateToNode(target, { openCurrentFolder: true });
    dirty = true;
    resolveLoad();
    assert.equal(await navigation, false);
    assert.equal(state.selectedItem.item, current);
    assert.equal(state.pendingNavigation.item, target);
    assert.equal(renderCount, 0);

    await state.handlePolicyChangedNo();
    assert.equal(state.selectedItem.item, target);
    assert.equal(renderCount, 1);
});

test('discard navigation stops when the current view refuses cancellation', () => {
    const app = loadAmd('js/app.js', {
        './components/header/header': {},
        './components/main/main': {},
        './components/footer/footer': {},
        './util/resizable': {},
        './components/templates/default-template': {},
        './components/templates/admx-template': {},
        './components/templates/folder-template': {},
        './components/templates/preference/preferences-view-template': {},
        './components/tree-view/tree-view-list': {},
        './util/element-creator': {},
        './components/editor-status': {},
        './locales/translations': { t: (key) => key },
        './util/API': {}
    });
    const state = app._test.createTreeViewState();
    const target = { type: 'folder', children: [] };
    let cancelCalls = 0;
    let navigationCalls = 0;
    state.currentView = {
        cancelChanges() {
            cancelCalls += 1;
            return false;
        }
    };
    state.pendingNavigation = { item: target, options: { openCurrentFolder: true } };
    state.guardNavigation = function() {
        navigationCalls += 1;
        return true;
    };

    assert.equal(state.handlePolicyChangedNo(), false);
    assert.equal(cancelCalls, 1);
    assert.equal(navigationCalls, 0);
    assert.equal(state.pendingNavigation, null);
});

test('failed lazy navigation preserves the current workspace selection for retry', async () => {
    let renderCount = 0;
    let loadCount = 0;
    const app = loadAmd('js/app.js', {
        './components/header/header': {},
        './components/main/main': {},
        './components/footer/footer': {},
        './util/resizable': {},
        './components/templates/default-template': {},
        './components/templates/admx-template': {},
        './components/templates/folder-template': {
            renderFolderTemplate() {
                renderCount += 1;
                return {};
            },
            renderHelpBlock() { return null; }
        },
        './components/templates/preference/preferences-view-template': {},
        './components/tree-view/tree-view-list': {
            setTreeItemActive() { return null; },
            setFolderOpenedState() { return false; },
            ensureLazyChildren(item) {
                loadCount += 1;
                if (loadCount === 1) return Promise.reject(new Error('load failed'));
                item.children = [{ type: 'file', policyId: 'retry-result' }];
                item.loaded = true;
                return Promise.resolve(item.children);
            }
        },
        './util/element-creator': {},
        './components/editor-status': {},
        './locales/translations': { t: (key) => key },
        './util/API': {}
    });
    const state = app._test.createTreeViewState();
    const currentFolder = { type: 'folder', children: [{ type: 'file' }] };
    const lazyFolder = { type: 'folder', lazy: true, loaded: false, children: [] };
    state.selectedItem = { item: currentFolder, element: null };
    state.selectedPath = [currentFolder];
    state.currentView = { hasUnsavedChanges() { return false; } };
    state.treeListItemElements.set(lazyFolder, {});

    const navigated = await state.navigateToNode(lazyFolder, { openCurrentFolder: true });

    assert.equal(navigated, false);
    assert.equal(state.selectedItem.item, currentFolder);
    assert.deepEqual(plain(state.selectedPath), [currentFolder]);
    assert.equal(renderCount, 0);
    assert.equal(lazyFolder.loaded, false);

    await state.navigateToNode(lazyFolder, { openCurrentFolder: true });
    assert.equal(loadCount, 2);
    assert.equal(renderCount, 1);
    assert.equal(state.selectedItem.item, lazyFolder);
});
