'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceRoot = path.resolve(__dirname, '../../plugin/ui/grouppolicy/js');
const cache = new Map();
function load(file) {
    file = path.posix.normalize(file);
    if (cache.has(file)) return cache.get(file);
    let exported;
    vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), {
        define: (dependencies, factory) => {
            exported = factory(...dependencies.map(name => load(
                path.posix.join(path.posix.dirname(file), name + '.js')
            )));
        }
    }, { filename: file });
    cache.set(file, exported);
    return exported;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
const targeting = load('util/targeting-tree-draft.js');

function field(value = '', extra = {}) {
    return { id: 'operand', editable: true, required: false, value: { kind: 'text', value }, ...extra };
}
function condition(value, children = [], kind = 'condition') {
    return { kind, value, children };
}
function collection(value, children = []) { return condition(value, children, 'collection'); }
function snapshot(roots = []) {
    const result = {
        filters: [], filter_fields: [],
        filter_kinds: [
            { kind: 'condition', label: 'Condition', supports_children: false, fields: [field()] },
            { kind: 'collection', label: 'Collection', supports_children: true, fields: [field()] },
            { kind: 'required', label: 'Required operand', supports_children: false, fields: [field('', { required: true })] }
        ]
    };
    function visit(nodes, parentPath) {
        nodes.forEach((node, index) => {
            const filterPath = parentPath.concat(index);
            result.filters.push({
                path: filterPath, kind: node.kind, label: node.value,
                element_name: node.kind || 'VendorFilter', detail: 'Detail: ' + node.value,
                supports_children: node.kind === 'collection',
                combine: 'and', negate: false, hidden: null
            });
            result.filter_fields.push({
                path: filterPath, available: node.kind !== null,
                fields: node.kind === null ? [] : [field(node.value)]
            });
            visit(node.children, filterPath);
        });
    }
    visit(roots, []);
    return result;
}
function named(model, value) {
    return model.flatten().find(entry => entry.node.label === value).node;
}
function update(model, node, value) {
    return model.updateFields(node.id, [{ id: 'operand', value: { kind: 'text', value } }]);
}
function shape(model) {
    function visit(nodes) {
        return nodes.map(node => ({
            kind: node.kind,
            value: node.available ? node.fields.find(item => item.id === 'operand').value.value : node.label,
            children: visit(node.children)
        }));
    }
    return plain(visit(model.roots));
}

test('specialized validation precedes compilation and cannot discard valid conditional operations or structural errors', () => {
    const model = targeting.create(snapshot());
    const node = model.add('required', null, 0);
    assert.equal(model.compile().errors[0].code, 'required');
    const compiled = plain(model.compile({ validateNode: () => [] }));
    assert.deepEqual(compiled.errors, []);
    assert.equal(compiled.operations[0].op, 'insert');
    assert.deepEqual(compiled.operations[0].fields[0].value, { kind: 'text', value: '' });
    const rejected = plain(model.compile({ validateNode: () => [{ fieldId: 'operand', code: 'invalid_range' }] }));
    assert.deepEqual(rejected.operations, []);
    assert.equal(rejected.errors[0].code, 'invalid_range');
    node.fields.push(field());
    assert.equal(model.compile({ validateNode: () => [] }).errors[0].code, 'duplicate_descriptor');
});

/** Simulate the public move contract, asserting every operation's intermediate depth. */
function apply(roots, operations) {
    roots = plain(roots);
    function at(filterPath) {
        let siblings = roots;
        let node;
        filterPath.forEach((index, depth) => {
            node = siblings[index];
            assert.ok(node, 'operation path must address the evolving tree: ' + JSON.stringify(filterPath));
            if (depth < filterPath.length - 1) siblings = node.children;
        });
        return node;
    }
    function owner(filterPath) { return filterPath.length ? at(filterPath).children : roots; }
    function checkDepth(nodes, depth = 0) {
        nodes.forEach(node => {
            const collectionDepth = depth + (node.kind === 'collection' ? 1 : 0);
            assert.ok(collectionDepth <= 64, 'every intermediate tree must fit the native collection-depth limit');
            checkDepth(node.children, collectionDepth);
        });
    }
    operations.forEach(operation => {
        if (operation.op === 'insert') {
            const value = operation.fields.find(item => item.id === 'operand').value.value;
            owner(operation.collection_path).splice(operation.index, 0, condition(value, [], operation.filter_kind));
        } else if (operation.op === 'remove') {
            owner(operation.path.slice(0, -1)).splice(operation.path.at(-1), 1);
        } else if (operation.op === 'move') {
            // Resolve the destination before removing the source, exactly like
            // native pre-move paths; the sibling index is post-removal.
            const destination = owner(operation.collection_path);
            const source = owner(operation.source_path.slice(0, -1));
            const moved = source.splice(operation.source_path.at(-1), 1)[0];
            destination.splice(operation.index, 0, moved);
        } else if (operation.op === 'edit') {
            at(operation.path).value = operation.fields.find(item => item.id === 'operand').value.value;
        } else {
            assert.fail('unexpected operation ' + operation.op);
        }
        checkDepth(roots);
    });
    return roots;
}

test('snapshot paths build a nested tree with stable identities and no publication operation', () => {
    const original = [collection('A', [condition('B'), collection('C', [condition('D')])]), condition('E')];
    const data = snapshot(original);
    data.filters.reverse(); // Paths, not incidental DTO ordering, determine nesting.
    const model = targeting.create(data);
    assert.deepEqual(shape(model), original);
    assert.deepEqual(plain(model.flatten().map(entry => [entry.path, entry.depth])), [
        [[0], 0], [[0, 0], 1], [[0, 1], 1], [[0, 1, 0], 2], [[1], 0]
    ]);
    assert.deepEqual(plain(model.compile()), { operations: [], errors: [] });
    const ids = model.flatten().map(entry => entry.node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(plain(named(model, 'D').originalPath), [0, 1, 0]);
    data.filter_fields[0].fields[0].value.value = 'outside mutation';
    assert.equal(named(model, 'A').fields[0].value.value, 'A');
});

test('multiple new nodes and arbitrarily nested collections are inserted using final values in one ordered batch', () => {
    const model = targeting.create(snapshot());
    const a = model.add('collection', null);
    const b = model.add('collection', a.id);
    const c = model.add('condition', b.id);
    const d = model.add('condition', null);
    update(model, a, 'A'); update(model, b, 'B'); update(model, c, 'C'); update(model, d, 'D');
    assert.equal(model.move(d.id, b.id, 0), true);
    assert.deepEqual(plain(model.compile()).errors, []);
    const operations = plain(model.compile()).operations;
    assert.deepEqual(operations.map(operation => [operation.op, operation.collection_path, operation.index]), [
        ['insert', [], 0], ['insert', [0], 0], ['insert', [0, 0], 0], ['insert', [0, 0], 1]
    ]);
    assert.deepEqual(apply([], operations), shape(model));
});

test('new nodes added and later deleted compile to no-op without validating abandoned drafts', () => {
    const model = targeting.create(snapshot([condition('existing')]));
    const discarded = model.add('required', null);
    const discardedId = discarded.id;
    assert.equal(model.remove(discardedId), true);
    assert.deepEqual(plain(model.compile()), { operations: [], errors: [] });
    const next = model.add('condition', null);
    assert.notEqual(next.id, discardedId, 'identities cannot be reused during a draft');
});

test('moves are lossless, retain identity and edit only final paths after insertion/removal/reparenting', () => {
    const original = [condition('remove'), collection('A', [condition('B')]), collection('C')];
    const model = targeting.create(snapshot(original));
    const b = named(model, 'B');
    const c = named(model, 'C');
    const id = b.id;
    model.remove(named(model, 'remove').id);
    assert.equal(model.move(b.id, c.id, 0), true);
    assert.equal(model.move(c.id, null, 0), true);
    update(model, b, 'B edited');
    const operations = plain(model.compile()).operations;
    assert.equal(model.find(id), b);
    assert.deepEqual(plain(b.originalPath), [1, 0]);
    assert.deepEqual(operations.filter(operation => operation.op === 'edit'), [{
        op: 'edit', path: [0, 0], fields: [{ id: 'operand', value: { kind: 'text', value: 'B edited' } }]
    }]);
    assert.equal(operations.some(operation => operation.op === 'insert'), false);
    assert.deepEqual(apply(original, operations), shape(model));
});

test('destination collection path addresses the pre-move tree even when removal shifts that path', () => {
    const original = [condition('A'), collection('B', [condition('C')]), condition('D')];
    const model = targeting.create(snapshot(original));
    model.move(named(model, 'A').id, named(model, 'B').id, 1);
    const operations = plain(model.compile()).operations;
    assert.deepEqual(apply(original, operations), shape(model));
    // Reconciliation may first position B at root index 0; the subsequent
    // destination must still be resolved before removing its earlier sibling.
    const aMove = operations.find(operation => operation.op === 'move' && operation.collection_path.length);
    assert.ok(aMove);
    assert.deepEqual(aMove.collection_path, [0]);
});

test('sibling destination indexes are after removal and rejected moves change nothing', () => {
    const model = targeting.create(snapshot([
        collection('A', [collection('B', [condition('C')])]), condition('D'), condition('E')
    ]));
    const a = named(model, 'A'), b = named(model, 'B'), c = named(model, 'C'), d = named(model, 'D');
    const before = shape(model);
    assert.equal(model.move(a.id, a.id, 0), false);
    assert.equal(model.move(a.id, b.id, 0), false);
    assert.equal(model.move(a.id, c.id, 0), false);
    assert.equal(model.move(d.id, c.id, 0), false);
    assert.equal(model.move('missing', null, 0), false);
    assert.equal(model.move(d.id, 'missing', 0), false);
    assert.equal(model.move(d.id, null, 9), false);
    assert.equal(model.move(d.id, null, 0.5), false);
    assert.equal(model.move(d.id, null, 1), false);
    assert.deepEqual(shape(model), before);
    assert.equal(model.move(d.id, null, 2), true);
    assert.deepEqual(plain(model.roots.map(node => node.label)), ['A', 'E', 'D']);
});

test('collections may be moved out and then inverted without a simulated cycle', () => {
    const original = [collection('A', [collection('B', [condition('C')])])];
    const model = targeting.create(snapshot(original));
    const a = named(model, 'A'), b = named(model, 'B');
    assert.equal(model.move(b.id, null, 1), true);
    assert.equal(model.move(a.id, b.id, 1), true);
    assert.deepEqual(apply(original, plain(model.compile()).operations), shape(model));
});

test('a removed ancestor does not destroy surviving descendants moved elsewhere', () => {
    const original = [collection('discard', [collection('survivor', [condition('child')])]), collection('destination')];
    const model = targeting.create(snapshot(original));
    model.move(named(model, 'survivor').id, named(model, 'destination').id, 0);
    model.remove(named(model, 'discard').id);
    const operations = plain(model.compile()).operations;
    const removed = operations.findIndex(operation => operation.op === 'remove');
    assert.ok(removed > operations.findIndex(operation => operation.op === 'move' && operation.source_path.length > 1));
    assert.deepEqual(apply(original, operations), shape(model));
});

test('replace produces a new node, drops former children and does not recreate already moved survivors', () => {
    const original = [collection('A', [condition('B'), condition('discard')]), collection('C')];
    const model = targeting.create(snapshot(original));
    const a = named(model, 'A'), b = named(model, 'B');
    model.move(b.id, named(model, 'C').id, 0);
    const replacement = model.replace(a.id, 'condition');
    assert.ok(replacement);
    assert.notEqual(replacement.id, a.id);
    assert.equal(model.find(a.id), null);
    assert.equal(model.find(named(model, 'C').id).children[0].id, b.id);
    update(model, replacement, 'replacement');
    const operations = plain(model.compile()).operations;
    assert.equal(operations.filter(operation => operation.op === 'insert').length, 1);
    assert.deepEqual(apply(original, operations), shape(model));
});

test('opaque filters remain read-only and are moved without insertion or field serialization', () => {
    const original = [condition('vendor', [condition('vendor child', [], null)], null), collection('A')];
    const model = targeting.create(snapshot(original));
    const vendor = named(model, 'vendor');
    assert.equal(vendor.available, false);
    assert.equal(model.updateFields(vendor.id, [{ id: 'operand', value: { kind: 'text', value: 'rewrite' } }]), false);
    assert.equal(model.add('condition', vendor.id), null);
    assert.equal(model.move(vendor.id, named(model, 'A').id, 0), true);
    const operations = plain(model.compile()).operations;
    assert.equal(operations.every(operation => operation.op === 'move'), true);
    const opaque = { ...original[0], vendorAttributes: { untouched: 'yes' } };
    const result = apply([opaque, original[1]], operations);
    assert.deepEqual(result[0].children[0].vendorAttributes, opaque.vendorAttributes);
    assert.deepEqual(result[0].children[0].children, opaque.children);
    assert.deepEqual(result.map(node => ({ ...node, children: node.children.map(child => {
        const { vendorAttributes, ...rest } = child;
        return rest;
    }) })), shape(model));
});

test('modal clone is isolated but compiles all previously accepted parent draft changes', () => {
    const parent = targeting.create(snapshot([condition('original')]));
    const first = parent.clone();
    update(first, named(first, 'original'), 'accepted');
    first.add('collection', null);
    assert.equal(named(parent, 'original').fields[0].value.value, 'original');
    assert.deepEqual(plain(parent.compile()).operations, []);
    const reopened = first.clone();
    assert.deepEqual(plain(reopened.compile()), plain(first.compile()));
    update(reopened, named(reopened, 'original'), 'cancelled');
    reopened.remove(reopened.roots[1].id);
    assert.equal(named(first, 'original').fields[0].value.value, 'accepted');
    assert.equal(first.roots.length, 2);
    const acceptedAgain = first.clone();
    assert.notEqual(acceptedAgain.roots, first.roots);
    assert.notEqual(acceptedAgain.roots[0].fields, first.roots[0].fields);
    assert.deepEqual(plain(acceptedAgain.compile()), plain(first.compile()));
});

test('required fields and duplicate descriptors report stable row and field IDs before accepting', () => {
    const model = targeting.create(snapshot());
    const required = model.add('required', null);
    assert.deepEqual(plain(model.compile()), {
        operations: [], errors: [{ id: required.id, fieldId: 'operand', code: 'required' }]
    });
    update(model, required, 'configured');
    assert.deepEqual(plain(model.compile()).errors, []);
    required.fields.push(plain(required.fields[0]));
    assert.deepEqual(plain(model.compile()).errors, [{
        id: required.id, fieldId: 'operand', code: 'duplicate_descriptor'
    }]);
});

test('field edits retain descriptors, ignore read-only fields and use final validation types', () => {
    const data = snapshot([condition('A')]);
    data.filter_fields[0].fields.push(field('immutable', { id: 'readonly', editable: false }));
    const model = targeting.create(data);
    const node = named(model, 'A');
    assert.equal(model.updateFields(node.id, [
        { id: 'operand', value: { kind: 'text', value: 'edited' } },
        { id: 'readonly', value: { kind: 'text', value: 'changed' } },
        { id: 'foreign', value: { kind: 'text', value: 'ignored' } }
    ]), true);
    assert.equal(node.fields[1].value.value, 'immutable');
    assert.equal(node.fields.length, 2);
    assert.equal(node.fields[0].editable, true);
    assert.deepEqual(plain(model.compile()).operations, [{
        op: 'edit', path: [0], fields: [{ id: 'operand', value: { kind: 'text', value: 'edited' } }]
    }]);
});

test('compiled trees never briefly exceed native depth when moved children have final parents elsewhere', () => {
    const bottom = collection('departing');
    let tall = bottom;
    for (let index = 0; index < 60; index++) tall = collection('source ' + index, [tall]);
    const original = [tall];
    const model = targeting.create(snapshot(original));
    const source = model.roots[0];
    // The final source is shallow, but the server snapshot still owns a tall
    // chain under it until reconciliation extracts the departing descendants.
    const departing = source.children[0];
    model.move(departing.id, null, 1);
    let parent = model.add('collection', null, 0);
    update(model, parent, 'new 0');
    for (let index = 1; index < 10; index++) {
        parent = model.add('collection', parent.id);
        update(model, parent, 'new ' + index);
    }
    assert.equal(model.move(source.id, parent.id, 0), true);
    const operations = plain(model.compile()).operations;
    assert.deepEqual(apply(original, operations), shape(model));
    assert.ok(operations.some(operation => operation.op === 'move' && operation.collection_path.length === 0
        && operation.source_path.length > 1), 'departing subtree is staged safely before the deep source move');
});

test('local add/move enforce supported parents, positions and maximum native tree depth', () => {
    const model = targeting.create(snapshot());
    assert.equal(model.add('missing', null), null);
    assert.equal(model.add('condition', 'missing'), null);
    assert.equal(model.add('condition', null, -1), null);
    assert.equal(model.add('condition', null, 0.5), null);
    const leaf = model.add('condition', null);
    assert.equal(model.add('collection', leaf.id), null);
    let parent = model.add('collection', null);
    for (let index = 1; index < 64; index++) parent = model.add('collection', parent.id);
    assert.ok(parent);
    assert.equal(model.add('collection', parent.id), null);
    const deepestLeaf = model.add('condition', parent.id);
    assert.ok(deepestLeaf, 'leaf under64 collections is legal in the native model');
    assert.equal(model.move(leaf.id, parent.id, 0), true);
    assert.equal(model.flatten().at(-1).path.length, 65);
    assert.deepEqual(plain(model.compile()).errors, []);
});

test('existing leaf paths beneath64 collections remain valid without a false depth error', () => {
    let root = condition('leaf');
    for (let index = 0; index < 64; index++) root = collection('level ' + index, [root]);
    const model = targeting.create(snapshot([root]));
    assert.equal(named(model, 'leaf').originalPath.length, 65);
    assert.deepEqual(plain(model.compile()), { operations: [], errors: [] });
});

test('malformed server paths cannot silently be reconstructed into a different targeting tree', () => {
    const malformed = snapshot([condition('A')]);
    malformed.filters[0].path = [1];
    assert.throws(() => targeting.create(malformed), /Invalid targeting filter snapshot/);
});

test('field inventory compatibility and new-kind default overrides retain structured typed values', () => {
    const data = snapshot([condition('A')]);
    data.filter_fields = { '[0]': [field('from legacy map')] };
    data.new_filter_fields = [{ kind: 'condition', fields: [field('from explicit default')] }];
    const model = targeting.create(data);
    assert.equal(model.roots[0].fields[0].value.value, 'from legacy map');
    const node = model.add('condition', null);
    assert.equal(node.fields[0].value.value, 'from explicit default');
    const compiled = model.compile();
    compiled.operations[0].fields[0].value.value = 'external mutation';
    assert.equal(node.fields[0].value.value, 'from explicit default');
});

test('mixed draft sessions reconcile deterministically across repeated add/edit/remove/replace/reparent actions', () => {
    for (let seed = 1; seed <= 100; seed++) {
        let state = seed;
        function random(length) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % length;
        }
        const original = [
            collection('A', [condition('B'), collection('C', [condition('D')])]),
            collection('E', [condition('F')]), condition('G')
        ];
        const model = targeting.create(snapshot(original));
        for (let turn = 0; turn < 40; turn++) {
            const nodes = model.flatten().map(entry => entry.node);
            const selected = nodes.length ? nodes[random(nodes.length)] : null;
            const parents = [null, ...nodes.filter(node => node.supports_children)];
            const parent = parents[random(parents.length)];
            switch (random(5)) {
                case 0: {
                    const siblings = parent ? parent.children : model.roots;
                    const added = model.add(random(2) ? 'condition' : 'collection', parent && parent.id, random(siblings.length + 1));
                    if (added) update(model, added, 'added ' + seed + '/' + turn);
                    break;
                }
                case 1:
                    if (selected) model.remove(selected.id);
                    break;
                case 2: {
                    const siblings = parent ? parent.children : model.roots;
                    if (selected) model.move(selected.id, parent && parent.id, random(siblings.length + 1));
                    break;
                }
                case 3:
                    if (selected) update(model, selected, 'edited ' + seed + '/' + turn);
                    break;
                case 4:
                    if (selected) {
                        const replaced = model.replace(selected.id, random(2) ? 'condition' : 'collection');
                        if (replaced) update(model, replaced, 'replacement ' + seed + '/' + turn);
                    }
                    break;
            }
        }
        const compiled = plain(model.compile());
        assert.deepEqual(compiled.errors, [], 'seed ' + seed + ' must remain valid');
        assert.deepEqual(plain(model.compile()), compiled, 'compile must not consume or mutate the draft');
        assert.deepEqual(apply(original, compiled.operations), shape(model), 'seed ' + seed + ' must reproduce the final tree');
    }
});
