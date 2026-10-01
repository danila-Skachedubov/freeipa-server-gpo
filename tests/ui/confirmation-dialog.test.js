'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const document = { activeElement: null };

    class FakeElement {
        constructor(tag, options = {}) {
            this.tag = tag;
            this.textContent = options.text || '';
            this.children = [];
            this.parentNode = null;
            this.isConnected = false;
            this.listeners = {};
            this.attrs = { ...(options.attrs || {}) };
            const classes = new Set((Array.isArray(options.className)
                ? options.className : [options.className]).filter(Boolean));
            this.classList = {
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name)
            };
            (options.children || []).forEach(child => this.appendChild(child.getElement()));
        }
        appendChild(child) {
            child.parentNode = this;
            child.isConnected = true;
            this.children.push(child);
        }
        remove() {
            if (this.parentNode) {
                this.parentNode.children = this.parentNode.children.filter(child => child !== this);
                this.parentNode = null;
            }
            this.isConnected = false;
        }
        focus() { document.activeElement = this; }
        addEventListener(name, callback) {
            (this.listeners[name] ||= []).push(callback);
        }
        fire(name, event = {}) {
            const value = { type: name, preventDefault() {}, stopPropagation() {}, ...event };
            (this.listeners[name] || []).forEach(callback => callback(value));
        }
        get offsetHeight() { return 20; }
    }

    function createElement(tag, options) {
        const element = new FakeElement(tag, options);
        return {
            getElement: () => element,
            on: (name, callback) => { element.addEventListener(name, callback); }
        };
    }

    let dialog;
    const filename = path.resolve(__dirname,
        '../../plugin/ui/grouppolicy/js/components/confirmation-dialog.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        document,
        define: (names, factory) => {
            dialog = factory({ createElement }, { t: key => key });
        }
    });
    const host = new FakeElement('div');
    const opener = new FakeElement('button');
    opener.isConnected = true;
    opener.focus();
    return { dialog, document, host, opener, createElement };
}

test('shared contextual confirmation cancels, confirms, and restores focus', () => {
    const { dialog, document, host, opener } = harness();
    let result = null;
    const prompt = dialog.open(host, {
        message: 'Discard?',
        onCancel: () => { result = 'cancel'; },
        onConfirm: () => { result = 'confirm'; }
    });
    assert.equal(prompt.root.classList.contains('active'), true);
    assert.equal(document.activeElement, prompt.root.children[0].children[2].children[0]);
    const footer = prompt.root.children[0].children[2];
    footer.children[0].fire('click');
    assert.equal(result, 'cancel');
    assert.equal(host.children.length, 0);
    assert.equal(document.activeElement, opener);

    const next = dialog.open(host, { message: 'Discard?', onConfirm: () => { result = 'confirm'; } });
    next.root.children[0].children[2].children[1].fire('click');
    assert.equal(result, 'confirm');
    assert.equal(host.children.length, 0);
    assert.equal(document.activeElement, opener);
});

test('Escape cancels the shared prompt and Tab remains inside it', () => {
    const { dialog, document, host, opener } = harness();
    let cancelled = 0;
    const prompt = dialog.open(host, {
        message: 'Discard?', onCancel: () => { cancelled += 1; }
    });
    const footer = prompt.root.children[0].children[2];
    const no = footer.children[0], yes = footer.children[1];
    prompt.root.fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(document.activeElement, yes);
    prompt.root.fire('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(document.activeElement, no);
    prompt.root.fire('keydown', { key: 'Escape' });
    assert.equal(cancelled, 1);
    assert.equal(host.children.length, 0);
    assert.equal(document.activeElement, opener);
});

test('shared confirmation accepts structured content without replacing text or callbacks', () => {
    const { dialog, host, createElement } = harness();
    const table = createElement('table', { children: [createElement('tr', { text: 'Minimum password age: 0' })] });
    let confirmed = false;
    const prompt = dialog.open(host, {
        title: 'Related settings', message: 'Apply these values:', content: table,
        cancelLabel: 'Cancel', confirmLabel: 'Apply changes',
        onConfirm: () => { confirmed = true; }
    });
    const content = prompt.root.children[0].children[1];
    assert.equal(content.textContent, 'Apply these values:');
    assert.equal(content.children[0], table.getElement());
    const footer = prompt.root.children[0].children[2];
    assert.equal(footer.children[0].textContent, 'Cancel');
    assert.equal(footer.children[1].textContent, 'Apply changes');
    footer.children[1].fire('click');
    assert.equal(confirmed, true);
    const rawContent = createElement('p', { text: 'Native DOM content' }).getElement();
    const rawPrompt = dialog.open(host, { content: rawContent });
    assert.equal(rawPrompt.root.children[0].children[1].children[0], rawContent);
    rawPrompt.close();
});
