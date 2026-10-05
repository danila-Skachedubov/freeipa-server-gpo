define(['../util/element-creator', '../locales/translations'], function(elements, translations) {
    'use strict';
    var create = elements.createElement;

    function render(segments, onNavigate) {
        var parts = (segments || []).filter(function(segment) { return segment && segment.title; });
        var list = create('ol', { className: 'gpo-category-path__list' });
        var focused = Math.max(0, parts.length - 1);
        function syncFocus() {
            var buttons = list.getElement().querySelectorAll('button');
            Array.from(buttons).forEach(function(button, index) { button.tabIndex = index === focused ? 0 : -1; });
        }
        parts.forEach(function(segment, index) {
            var last = index === parts.length - 1;
            var label = create(segment.item && onNavigate ? 'button' : 'span', {
                className: 'gpo-category-path__segment',
                attrs: { type: segment.item && onNavigate ? 'button' : null,
                    title: segment.title, 'aria-current': last ? 'page' : null },
                text: segment.title
            });
            if (segment.item && onNavigate) {
                label.on('click', function() { onNavigate(segment.item); });
                label.on('focus', function() { focused = index; syncFocus(); });
            }
            list.append(create('li', { children: [
                index ? create('span', { className: 'gpo-category-path__separator',
                    attrs: { 'aria-hidden': 'true' }, text: ' / ' }) : null,
                label
            ] }));
        });
        list.on('keydown', function(event) {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            var buttons = Array.from(list.getElement().querySelectorAll('button'));
            var index = buttons.indexOf(event.target);
            if (index < 0) return;
            var next = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1
                : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            focused = Math.max(0, Math.min(buttons.length - 1, next));
            syncFocus(); buttons[focused].focus({ preventScroll: true });
        });
        syncFocus();
        return create('nav', { className: 'gpo-category-path', attrs: {
            'data-category-path': '', 'aria-label': translations.t('navigation.path')
        }, children: [list] });
    }

    function attachFilter(header, view) {
        if (!header || !view) return;
        var input = Array.from(view.querySelectorAll('[data-policy-filter]')).find(function(candidate) {
            var owner = candidate.closest('[role="dialog"]');
            // The entire editor lives in FreeIPA's outer dialog. Exclude
            // only dialogs nested inside this view, not that outer shell.
            return !owner || !view.contains(owner);
        });
        if (!input) return;
        var toolbar = input.parentElement;
        input.classList.add('gpo-category-path__filter');
        header.appendChild(input);
        if (toolbar && toolbar.classList.contains('gpo-security-workbench__toolbar')
                && !toolbar.children.length) toolbar.remove();
    }

    return { render: render, attachFilter: attachFilter };
});
