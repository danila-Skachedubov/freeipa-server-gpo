define(['../util/element-creator', '../util/editor-dto', '../locales/translations'], function(elementCreator, dto, translations) {
    "use strict";

    var createElement = elementCreator.createElement;
    var DETAILS = {
        'Security policy actions must be a list': 'securityActionsList',
        'Security element actions must be a list': 'securityElementActionsList',
        'Keyed-row actions must be a list': 'securityRowActionsList',
        'At least one non-empty list entry is required': 'listRequiresEntry',
        'Invalid collection entries': 'collectionInvalidEntry'
    };
    function text(key) { return translations.t('editorStatus.' + key); }

    function messageForError(error) {
        var category = dto.errorCategory(error).replace(/-/g, '_');
        var key = 'editorStatus.errors.' + category;
        var prefix = translations.t(key);
        if (prefix === key) prefix = text('errors.operational');
        var message = error && error.message ? String(error.message) : '';
        // RPC diagnostics are not localized UI strings. Append only translated
        // details, retaining the original error object for diagnostic callers.
        var detail = DETAILS[message.replace(/[.]$/, '')];
        return detail ? prefix + ' ' + text('details.' + detail) : prefix;
    }

    function renderError(error, options) {
        var config = options || {};
        var category = dto.errorCategory(error).replace(/-/g, '_');
        var actions = [];
        if (typeof config.onRefresh === 'function') {
            actions.push(createElement('button', {
                className: ['button', 'gpo-editor-status__action'],
                attrs: { type: 'button' },
                text: text('refresh'),
                events: { click: config.onRefresh }
            }));
        }
        if ((category.indexOf('publication') !== -1 || error && error.pendingPublication)
                && typeof config.onReconcile === 'function') {
            actions.push(createElement('button', {
                className: ['button', 'gpo-editor-status__action'],
                attrs: { type: 'button' },
                text: text('reconcile'),
                events: { click: config.onReconcile }
            }));
        }
        return createElement('div', {
            className: ['gpo-editor-status', 'gpo-editor-status--error', 'gpo-editor-status--' + category],
            attrs: { role: 'alert', 'data-error-category': category },
            children: [
                createElement('div', { className: 'gpo-editor-status__message', text: messageForError(error) }),
                error && error.field ? createElement('div', {
                    className: 'gpo-editor-status__field',
                    text: text('field') + ': ' + error.field
                }) : null,
                actions.length ? createElement('div', {
                    className: 'gpo-editor-status__actions',
                    children: actions
                }) : null
            ]
        });
    }

    function renderPending(pending, onReconcile) {
        if (!pending) return null;
        return createElement('div', {
            className: ['gpo-editor-status', 'gpo-editor-status--pending'],
            attrs: { role: 'status' },
            children: [
                createElement('div', {
                    className: 'gpo-editor-status__message',
                    text: text('pending')
                }),
                typeof onReconcile === 'function' ? createElement('button', {
                    className: ['button', 'gpo-editor-status__action'],
                    attrs: { type: 'button' },
                    text: text('reconcile'),
                    events: { click: onReconcile }
                }) : null
            ]
        });
    }

    function renderDiagnostics(diagnostics) {
        return createElement('details', {
            className: 'gpo-editor-status__diagnostics',
            children: [createElement('summary', { text: text('technicalDetails') })].concat(
                (diagnostics || []).map(function(diagnostic) {
                    return createElement('pre', {
                        text: [diagnostic.code, diagnostic.message].filter(Boolean).join(': ')
                    });
                })
            )
        });
    }

    return {
        messageForError: messageForError,
        renderError: renderError,
        renderPending: renderPending,
        renderDiagnostics: renderDiagnostics
    };
});
