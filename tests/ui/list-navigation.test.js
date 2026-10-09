'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
let navigation;
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,
    '../../plugin/ui/grouppolicy/js/components/list-navigation.js'), 'utf8'), {
    define: (dependencies, factory) => { assert.equal(dependencies.length, 0); navigation = factory(); }
});

test('Deletion neighbors prefer a previous visible survivor, then the following survivor', () => {
    assert.equal(navigation.neighbor(['a', 'b', 'c'], ['b'], ['a', 'c']), 'a');
    assert.equal(navigation.neighbor(['a', 'b', 'c'], ['a'], ['b', 'c']), 'b');
    assert.equal(navigation.neighbor(['a', 'b', 'c'], ['c'], ['a', 'b']), 'b');
    assert.equal(navigation.neighbor(['a', 'b', 'c'], ['b'], ['c']), 'c');
    assert.equal(navigation.neighbor(['a'], ['a'], []), null);
    assert.equal(navigation.neighbor(['a'], ['missing'], ['a']), null);
});

test('Bulk neighbors use the first removed position and skip removed or filtered rows', () => {
    assert.equal(navigation.neighbor(['a', 'b', 'c', 'd', 'e'], ['d', 'c'], ['a', 'b', 'e']), 'b');
    assert.equal(navigation.neighbor(['a', 'b', 'c', 'd', 'e'], ['a', 'c'], ['b', 'd', 'e']), 'b');
    assert.equal(navigation.neighbor(['a', 'b', 'c', 'd', 'e'], ['d', 'e'], ['a']), 'a');
    assert.equal(navigation.neighbor([], [], []), null);
});

function fixture(options = {}) {
    const listeners = new Map();
    const document = { activeElement: null, defaultView: {} };
    const container = { ownerDocument: document, tabIndex: null, attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name] ?? null; },
        removeAttribute(name) { delete this.attrs[name]; },
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name),
        focus: () => { document.activeElement = container; } };
    const element = id => ({ id, attrs: {}, tabIndex: null,
        contains: node => node === current.find(row => row.id === id),
        setAttribute(name, value) { this.attrs[name] = value; },
        focus() { document.activeElement = this; },
        closest: () => null,
        scrollIntoView() { this.scrolled = true; },
        getBoundingClientRect: () => ({ height: 20 }) });
    let current = ['a', 'b', 'c'].map(element);
    let chosen = null;
    const actions = [];
    const binding = navigation.bind(container, {
        rows: () => current,
        selected: () => chosen,
        select: row => { actions.push('select:' + row.id); chosen = row;
            if (options.rerender) { current = current.map(row => element(row.id)); chosen = current.find(row => row.id === chosen.id); } },
        activate: row => actions.push('activate:' + row.id),
        remove: row => actions.push('remove:' + row.id),
        canActivate: () => !options.readonly,
        canRemove: () => !options.readonly,
        busy: () => options.busy,
        isSelected: options.multiple ? row => row.id === 'a' || row.id === 'c' : undefined
    });
    return { binding, actions, container, document, options,
        rows: () => current, selected: () => chosen,
        empty: () => { current = []; chosen = null; binding.sync(); },
        key(key, extra = {}) {
            const event = { key, target: chosen || current[0] || container, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
            if (listeners.has('keydown')) listeners.get('keydown')(event);
            return event;
        },
        focus(index) { const row = current[index]; if (listeners.has('focusin')) listeners.get('focusin')({ target: row }); }
    };
}

test('One row is tabbable without auto-selecting; focus and keyboard movement synchronize selection', () => {
    const list = fixture();
    assert.deepEqual(list.rows().map(row => row.tabIndex), [0, -1, -1]);
    assert.equal(list.container.tabIndex, -1);
    assert.deepEqual(list.actions, []);
    list.focus(0);
    list.key('ArrowDown');
    assert.equal(list.selected().id, 'b');
    assert.equal(list.document.activeElement, list.selected());
    assert.deepEqual(list.rows().map(row => row.tabIndex), [-1, 0, -1]);
    list.key('End'); assert.equal(list.selected().id, 'c');
    list.key('Home'); assert.equal(list.selected().id, 'a');
    list.key('PageDown'); assert.equal(list.selected().id, 'c');
    list.key('PageUp'); assert.equal(list.selected().id, 'a');
    assert.equal(list.selected().scrolled, true);
});

test('Enter/F2 edit, Space only selects and Delete delegates the existing delete action', () => {
    const list = fixture();
    list.key(' '); list.key('Enter'); list.key('F2'); list.key('Delete');
    assert.deepEqual(list.actions, ['select:a', 'activate:a', 'activate:a', 'remove:a']);
    assert.equal(list.key('Tab').prevented, undefined);
});

test('Typing controls, toolbar buttons, modified keys, busy and readonly mutations are excluded', () => {
    const list = fixture();
    for (const key of ['Delete', 'Enter', 'ArrowDown']) {
        assert.equal(list.key(key, { target: { closest: () => ({}) } }).prevented, undefined);
        for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
            assert.equal(list.key(key, { [modifier]: true }).prevented, undefined);
        }
    }
    list.options.busy = true;
    list.key('ArrowDown'); list.key('Enter'); list.key('Delete');
    assert.deepEqual(list.actions, []);
    list.options.busy = false; list.options.readonly = true;
    list.key('Enter'); list.key('Delete');
    assert.deepEqual(list.actions, []);
    list.key('ArrowDown'); assert.equal(list.selected().id, 'b');
});

test('Focus resolves replacement rows, empty lists and cleanup without leaking listeners', () => {
    const list = fixture({ rerender: true });
    list.binding.focusSelected();
    assert.equal(list.selected().id, 'a');
    assert.equal(list.document.activeElement, list.selected());
    list.key('ArrowDown'); assert.equal(list.document.activeElement, list.selected());
    list.empty(); list.binding.focusSelected();
    assert.equal(list.document.activeElement, list.container);
    assert.equal(list.container.tabIndex, 0);
    list.binding.cleanup(); list.key('Enter');
    assert.equal(list.actions.filter(action => action.startsWith('activate')).length, 0);
});

test('Multiselection aria flags survive while the primary row remains the single Tab stop', () => {
    const list = fixture({ multiple: true });
    list.binding.sync();
    assert.deepEqual(list.rows().map(row => row.attrs['aria-selected']), ['true', 'false', 'true']);
    assert.deepEqual(list.rows().map(row => row.tabIndex), [0, -1, -1]);
});
