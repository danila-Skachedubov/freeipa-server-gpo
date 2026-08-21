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
        Array,
        Boolean,
        Error,
        Number,
        Object,
        String,
        decodeURIComponent,
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

function pluginEnvironment() {
    const calls = {
        actions: [],
        commands: [],
        entities: [],
        executions: 0,
        formatters: [],
        menuAdds: [],
        notifications: [],
        phases: []
    };
    const IPA = {
        api_version: '2.0',
        action: (spec) => Object.assign({}, spec),
        formatter: (spec) => Object.assign({}, spec),
        notify(message, level) {
            calls.notifications.push(['notify', message, level]);
        },
        notify_success(message) {
            calls.notifications.push(['success', message]);
        }
    };
    const rpc = {
        command(spec) {
            calls.commands.push(spec);
            return {
                execute() {
                    calls.executions += 1;
                }
            };
        }
    };
    const reg = {
        action: {
            register(name, factory) {
                calls.actions.push([name, factory]);
            }
        },
        entity: {
            register(spec) {
                calls.entities.push(spec);
            }
        },
        formatter: {
            register(name, factory) {
                calls.formatters.push([name, factory]);
            }
        }
    };
    const phases = {
        on(name, callback, priority) {
            calls.phases.push([name, callback, priority]);
        }
    };
    const menu = {
        matches: [],
        query() {
            return this.matches;
        },
        add_item(spec, parent) {
            calls.menuAdds.push([spec, parent]);
        }
    };
    return { calls, IPA, menu, phases, reg, rpc };
}

function loadChain(environment, windowValue = { location: { hash: '' } }) {
    return loadAmd('chain.js', {
        'freeipa/ipa': environment.IPA,
        'freeipa/menu': environment.menu,
        'freeipa/phases': environment.phases,
        'freeipa/reg': environment.reg,
        'freeipa/rpc': environment.rpc,
        './gpo': {}
    }, { window: windowValue });
}

function loadGpo(environment, options = {}) {
    const links = [];
    const document = {
        createElement() {
            return {};
        },
        head: {
            appendChild(link) {
                links.push(link);
            }
        }
    };
    const exported = loadAmd('gpo.js', {
        require: options.require || function() {},
        'freeipa/ipa': environment.IPA,
        'freeipa/phases': environment.phases,
        'freeipa/reg': environment.reg,
        'freeipa/navigation': {},
        'freeipa/rpc': environment.rpc
    }, {
        document,
        window: { location: { hash: '' }, console },
        $: options.$ || function() {
            throw new Error('jQuery must not be used while loading the module');
        }
    });
    return { exported, links };
}

function jqueryModalHarness() {
    function control() {
        return {
            handlers: {},
            on(event, handler) {
                this.handlers[event] = handler;
                return this;
            },
            text(value) {
                this.textValue = value;
                return this;
            },
            trigger(event) {
                if (this.handlers[event]) this.handlers[event]();
            }
        };
    }

    function node(kind) {
        const controls = {
            '.close': control(),
            '.modal-title': control()
        };
        return {
            kind,
            removed: 0,
            children: [],
            remove() {
                this.removed += 1;
                return this;
            },
            find(selector) {
                return controls[selector] || control();
            },
            append(child) {
                this.children.push(child);
                return this;
            },
            controls
        };
    }

    const state = {
        backdrop: null,
        modal: null,
        body: node('body')
    };
    state.$ = function(value) {
        if (value === 'body') return state.body;
        if (String(value).includes('modal-backdrop')) {
            state.backdrop = node('backdrop');
            state.backdrop.on = control().on.bind(state.backdrop);
            state.backdrop.handlers = {};
            state.backdrop.trigger = control().trigger.bind(state.backdrop);
            return state.backdrop;
        }
        if (String(value).includes('modal-gpui')) {
            state.modal = node('modal');
            return state.modal;
        }
        throw new Error(`Unexpected jQuery input: ${value}`);
    };
    return state;
}

test('chain plugin registers its public actions, formatter, entity and menu phase', () => {
    const environment = pluginEnvironment();
    const chain = loadChain(environment);

    assert.deepEqual(
        environment.calls.phases.map(([name, , priority]) => [name, priority]),
        [['registration', undefined], ['profile', 20]]
    );

    chain.register();

    assert.deepEqual(
        environment.calls.actions.map(([name]) => name),
        ['enable', 'disable', 'move_up', 'move_down', 'move_gpc_up', 'move_gpc_down']
    );
    assert.deepEqual(
        environment.calls.formatters.map(([name]) => name),
        ['boolean_status_formatter']
    );
    assert.equal(environment.calls.entities.length, 1);
    assert.equal(environment.calls.entities[0].type, 'chain');
    assert.equal(environment.calls.entities[0].spec.name, 'chain');

    chain.add_menu_items();
    assert.deepEqual(environment.calls.menuAdds, []);
    environment.menu.matches = [{ name: 'policy' }];
    chain.add_menu_items();
    assert.equal(environment.calls.menuAdds.length, 1);
    assert.equal(environment.calls.menuAdds[0][1], 'policy');
});

test('chain boolean formatter handles LDAP scalar and list forms', () => {
    const chain = loadChain(pluginEnvironment());
    const formatter = chain.boolean_status_formatter();

    assert.equal(formatter.format(true), 'Active');
    assert.equal(formatter.format('YES'), 'Active');
    assert.equal(formatter.format(['0']), 'Inactive');
    assert.equal(formatter.format(null), 'Unknown');
    assert.equal(formatter.format('unexpected'), 'Unknown');
});

for (const operation of [
    { factory: 'enable_action', method: 'enable', success: 'enabled successfully' },
    { factory: 'disable_action', method: 'disable', success: 'disabled successfully' }
]) {
    test(`chain ${operation.method} action validates selection and dispatches RPC`, () => {
        const environment = pluginEnvironment();
        const chain = loadChain(environment);
        const action = chain[operation.factory]();
        const facet = {
            selected: [],
            refreshes: 0,
            get_selected_values() {
                return this.selected;
            },
            refresh() {
                this.refreshes += 1;
            }
        };

        action.execute_action(facet);
        assert.equal(environment.calls.commands.length, 0);
        assert.match(environment.calls.notifications[0][1], /exactly one chain/);

        facet.selected = ['primary'];
        let successValue;
        action.execute_action(facet, (value) => { successValue = value; });

        assert.equal(environment.calls.executions, 1);
        const command = environment.calls.commands[0];
        assert.deepEqual(plain({
            entity: command.entity,
            method: command.method,
            args: command.args,
            options: command.options
        }), {
            entity: 'chain',
            method: operation.method,
            args: ['primary'],
            options: { version: '2.0' }
        });
        command.on_success({ ok: true });
        assert.deepEqual(successValue, { ok: true });
        assert.equal(facet.refreshes, 1);
        assert.match(environment.calls.notifications.at(-1)[1], new RegExp(operation.success));
    });
}

for (const operation of [
    { factory: 'move_up_action', option: 'moveup_chain', direction: 'up' },
    { factory: 'move_down_action', option: 'movedown_chain', direction: 'down' }
]) {
    test(`chain move ${operation.direction} handles RPC success and missing error details`, () => {
        const environment = pluginEnvironment();
        const chain = loadChain(environment);
        const action = chain[operation.factory]();
        const facet = {
            selected: [],
            refreshes: 0,
            get_selected_values() {
                return this.selected;
            },
            refresh() {
                this.refreshes += 1;
            }
        };

        action.execute_action(facet);
        assert.equal(environment.calls.commands.length, 0);
        assert.match(environment.calls.notifications[0][1], /exactly one chain/);

        facet.selected = ['primary'];
        let successValue;
        let errorValue;
        action.execute_action(
            facet,
            (value) => { successValue = value; },
            (...args) => { errorValue = args; }
        );

        const command = environment.calls.commands[0];
        assert.equal(environment.calls.executions, 1);
        assert.deepEqual(plain({
            entity: command.entity,
            method: command.method,
            options: command.options
        }), {
            entity: 'gpmaster',
            method: 'mod',
            options: { [operation.option]: 'primary', version: '2.0' }
        });

        command.on_success({ moved: true });
        assert.deepEqual(successValue, { moved: true });
        assert.equal(facet.refreshes, 1);

        assert.doesNotThrow(() => command.on_error('xhr', 'timeout', undefined));
        assert.deepEqual(errorValue, ['xhr', 'timeout', undefined]);
        assert.deepEqual(environment.calls.notifications.at(-1), [
            'notify', `Failed to move chain ${operation.direction}: timeout`, 'error'
        ]);
    });
}

test('GPO plugin loads styles and registers entity and actions', () => {
    const environment = pluginEnvironment();
    const { exported: gpo, links } = loadGpo(environment);

    assert.deepEqual(links.map((link) => link.href), [
        'js/plugins/chain/css/main.css',
        'js/plugins/chain/css/other.css'
    ]);
    assert.deepEqual(environment.calls.phases.map(([name]) => name), ['registration']);

    gpo.register();

    assert.deepEqual(
        environment.calls.actions.map(([name]) => name),
        ['gpo_save', 'gpui']
    );
    assert.equal(environment.calls.entities.length, 1);
    assert.equal(environment.calls.entities[0].type, 'gpo');
    assert.equal(environment.calls.entities[0].spec.name, 'gpo');
});

test('GPO save action skips no-op and sends one canonical modification', () => {
    const environment = pluginEnvironment();
    const { exported: gpo } = loadGpo(environment);
    const action = gpo.save_action();
    const facet = {
        values: { displayname: 'Policy-One', flags: '1' },
        original: { displayname: 'Policy-One', flags: 1 },
        refreshes: 0,
        entity: {
            get_primary_key(values) {
                return values.displayname;
            }
        },
        get_values() {
            return this.values;
        },
        get_original_values() {
            return this.original;
        },
        refresh() {
            this.refreshes += 1;
        }
    };
    let noOpSucceeded = false;

    action.execute_action(facet, () => { noOpSucceeded = true; });

    assert.equal(noOpSucceeded, true);
    assert.equal(environment.calls.commands.length, 0);
    assert.deepEqual(environment.calls.notifications.at(-1), [
        'notify', 'No changes made', 'info'
    ]);

    facet.values = { displayname: 'Policy-Two', flags: '2' };
    let response;
    action.execute_action(facet, (value) => { response = value; });

    assert.equal(environment.calls.executions, 1);
    const command = environment.calls.commands[0];
    assert.deepEqual(plain({
        entity: command.entity,
        method: command.method,
        args: command.args,
        options: command.options
    }), {
        entity: 'gpo',
        method: 'mod',
        args: ['Policy-One'],
        options: { rename: 'Policy-Two', flags: 2 }
    });
    command.on_success({ updated: true });
    assert.deepEqual(response, { updated: true });
    assert.equal(facet.refreshes, 1);
    assert.match(environment.calls.notifications.at(-1)[1], /renamed from/);
});

test('GPUI modal close destroys the initialized app lifecycle exactly once', () => {
    const environment = pluginEnvironment();
    const jquery = jqueryModalHarness();
    let initCalls = 0;
    let destroyCalls = 0;
    let refreshes = 0;
    const app = {
        init() {
            initCalls += 1;
            return { destroy() { destroyCalls += 1; } };
        }
    };
    const { exported: gpo } = loadGpo(environment, {
        $: jquery.$,
        require(_modules, onLoad) { onLoad(app); }
    });
    const action = gpo.gpui_action();
    const facet = {
        get_selected_values: () => ['Policy One'],
        refresh() { refreshes += 1; }
    };

    action.execute_action(facet);
    assert.equal(initCalls, 1);
    jquery.modal.controls['.close'].trigger('click');
    jquery.backdrop.trigger('click');

    assert.equal(destroyCalls, 1);
    assert.equal(jquery.modal.removed, 1);
    assert.equal(jquery.backdrop.removed, 1);
    assert.equal(refreshes, 1);
});

test('GPUI modal closed before app load never initializes the late module', () => {
    const environment = pluginEnvironment();
    const jquery = jqueryModalHarness();
    let finishLoading;
    let initCalls = 0;
    const { exported: gpo } = loadGpo(environment, {
        $: jquery.$,
        require(_modules, onLoad) { finishLoading = onLoad; }
    });
    const action = gpo.gpui_action();
    const facet = {
        get_selected_values: () => ['Policy One'],
        refresh() {}
    };

    action.execute_action(facet);
    jquery.backdrop.trigger('click');
    finishLoading({ init() { initCalls += 1; } });

    assert.equal(initCalls, 0);
});
