define(['../util/element-creator', '../util/collection-value', '../locales/translations', './collection-dialog'], function(elements, collections, translations, collectionDialog) {
    'use strict';
    var create = elements.createElement;
    function tr(key, values) {
        var text = translations.t('collections.' + key);
        Object.keys(values || {}).forEach(function(name) { text = text.replace('{' + name + '}', values[name]); });
        return text;
    }
    function createControl(parameter, initial, editable) {
        var value = initial ? JSON.parse(JSON.stringify(initial)) : collections.empty(parameter, initial);
        var canEdit = Boolean(editable);
        var modal = null;
        var button = create('button', { className: ['button', 'gpo-collection-control__button'], attrs: { type: 'button' } });
        var count = create('span', { className: 'gpo-collection-control__count' });
        var preview = create('span', { className: 'gpo-collection-control__preview', attrs: { 'aria-hidden': 'true' } });
        var host = create('div', { className: 'gpo-collection-control__dialog-host' });
        var root = create('div', { className: 'gpo-collection-control', children: [
            create('div', { className: 'gpo-collection-control__summary', children: [count, preview] }),
            button,
            host
        ] });
        function refresh() {
            var summary = collections.summary(parameter, value);
            button.getElement().textContent = tr('edit');
            button.getElement().setAttribute('aria-label', tr('editLabel', { label: parameter.label || parameter.id }));
            button.getElement().disabled = !canEdit;
            count.getElement().textContent = summary.count ? tr(summary.mode === 'key_value' ? 'pairsCount' : 'itemsCount', { count: summary.count }) : tr('empty');
            preview.getElement().textContent = summary.preview.map(function(text) { return text || tr('emptyValue'); }).join(', ') + (summary.more ? ', …' : '');
        }
        button.on('click', function() {
            if (modal || !canEdit) return;
            modal = collectionDialog.open(host, {
                parameter: parameter,
                value: value,
                readOnly: false,
                onAccept: function(next) {
                    value = JSON.parse(JSON.stringify(next));
                    refresh();
                    root.getElement().dispatchEvent(new Event('change', { bubbles: true }));
                },
                onClose: function() { modal = null; }
            });
        });
        refresh();
        return {
            element: root,
            button: button.getElement(),
            read: function() { return JSON.parse(JSON.stringify(value)); },
            hasOpenDialog: function() { return Boolean(modal); },
            hasUnsavedChanges: function() { return Boolean(modal && modal.isDirty()); },
            setEditable: function(enabled) { canEdit = Boolean(enabled); refresh(); },
            destroy: function() { if (modal) modal.close(); }
        };
    }
    return { createControl: createControl };
});
