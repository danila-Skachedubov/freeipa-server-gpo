define(['../util/element-creator', '../locales/translations', './confirmation-dialog', './editor-status'], function(elements, translations, confirmationDialog, editorStatus) {
    'use strict';
    var create = elements.createElement;
    var sequence = 0;

    function trapTab(event, modal) {
        if (event.key !== 'Tab' || event.defaultPrevented
                || event.target.closest('[role="dialog"], [role="alertdialog"]') !== modal) return;
        var focusable = Array.from(modal.querySelectorAll('button, input, select, textarea, summary, a[href], [contenteditable="true"], [tabindex]')).filter(function(element) {
            var style = element.ownerDocument.defaultView.getComputedStyle(element);
            return element.tabIndex >= 0 && !element.disabled && !element.hidden
                && element.getClientRects().length && !element.closest('[hidden], [inert]')
                && style.visibility !== 'hidden' && style.visibility !== 'collapse'
                && element.closest('[role="dialog"], [role="alertdialog"]') === modal;
        });
        if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (focusable.indexOf(document.activeElement) === -1) {
            event.preventDefault(); (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
        }
    }

    function open(host, options) {
        var previous = document.activeElement;
        var titleId = 'editor-dialog-' + (++sequence);
        var busy = false;
        var closed = false;
        var applyDisabled = Boolean(options.applyDisabled);
        var confirmation = null;
        var body = create('div', { className: ['preference__modal-content', 'gpo-editor-dialog__body', options.bodyClassName], children: [options.content] });
        var failure = create('div', { className: ['gpo-editor-dialog__error', options.errorClassName], attrs: { role: 'alert' } });
        body.getElement().prepend(failure.getElement());
        var cancel = create('button', { className: ['button', 'btn-cancel'], attrs: { type: 'button' }, text: options.cancelLabel || translations.t('collections.cancel') });
        var apply = create('button', { className: ['button', 'btn-ok', 'gpo-editor-dialog__apply', options.applyClassName], attrs: { type: 'button' }, text: options.applyLabel || translations.t('collections.ok') });
        apply.getElement().disabled = applyDisabled;
        var closeButton = create('button', { className: ['close', 'gpo-editor-dialog__close', options.closeClassName], attrs: { type: 'button', 'aria-label': options.closeLabel || translations.t('collections.close') } });
        var modal = create('div', { className: ['preference__modal', 'active', 'gpo-editor-dialog'].concat(options.className || []), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, children: [
            create('div', { className: 'preference__modal-wrapper', children: [
                create('div', { className: 'preference__modal-header', children: [create('div', { id: titleId, className: 'title', text: options.title }), closeButton] }),
                body,
                create('div', { className: 'preference__modal-footer', children: [cancel, options.readOnly ? null : apply] })
            ] })
        ] });
        var backdrop = create('div', { className: ['gp__preference', 'gpo-editor-preferences__modal-host', 'active', 'gpo-editor-dialog-host'].concat(options.hostClassName || []), children: [modal] });
        function close() {
            if (closed) return;
            closed = true;
            if (confirmation) { confirmation.close(); confirmation = null; }
            backdrop.getElement().remove();
            if (options.onClose) options.onClose();
            var restored = previous && previous.isConnected ? previous
                : options.restoreFocus && options.restoreFocus();
            if (restored && restored.isConnected && restored.focus) restored.focus({ preventScroll: true });
        }
        function requestClose() {
            if (busy || confirmation) return false;
            if (options.canClose && options.canClose() === false) return false;
            if (!options.isDirty || !options.isDirty()) { close(); return true; }
            modal.getElement().inert = true;
            modal.getElement().classList.add('gpo-editor-dialog--confirming');
            confirmation = confirmationDialog.open(backdrop, {
                message: options.discardMessage || translations.t('collections.discardQuestion'),
                onConfirm: close,
                onCancel: function() {
                    confirmation = null;
                    modal.getElement().inert = false;
                    modal.getElement().classList.remove('gpo-editor-dialog--confirming');
                    cancel.getElement().focus();
                }
            });
            return false;
        }
        // Keep a growing inline editor from moving the button between
        // mousedown (blur) and click. The action itself owns draft completion.
        [cancel, apply, closeButton].forEach(function(button) {
            button.on('mousedown', function(event) { if (event.button === 0) event.preventDefault(); });
        });
        cancel.on('click', requestClose);
        closeButton.on('click', requestClose);
        apply.on('click', async function() {
            if (busy || applyDisabled || options.readOnly) return;
            busy = true;
            apply.getElement().disabled = true;
            cancel.getElement().disabled = true;
            closeButton.getElement().disabled = true;
            body.getElement().inert = true;
            modal.getElement().setAttribute('aria-busy', 'true');
            try {
                if (!options.onApply || await options.onApply() !== false) close();
            } catch (error) {
                failure.getElement().replaceChildren();
                failure.append(editorStatus.renderError(error));
            } finally {
                busy = false;
                apply.getElement().disabled = applyDisabled;
                cancel.getElement().disabled = false;
                closeButton.getElement().disabled = false;
                body.getElement().inert = false;
                modal.getElement().setAttribute('aria-busy', 'false');
                if (!closed && (!document.activeElement || document.activeElement === document.body)) apply.getElement().focus();
            }
        });
        modal.on('keydown', function(event) {
            if (event.defaultPrevented) return;
            // A collection workbench can open its existing row dialog above us.
            // Only the uppermost editor owns its keyboard events and focus trap.
            if (event.target.closest('[role="dialog"], [role="alertdialog"]') !== modal.getElement()) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestClose(); }
            trapTab(event, modal.getElement());
        });
        host.append(backdrop);
        Promise.resolve().then(function() {
            if (closed) return;
            var initial = options.initialFocus && options.initialFocus();
            (initial || modal.getElement()).focus();
        });
        return {
            close: close,
            requestClose: requestClose,
            root: modal,
            isBusy: function() { return busy; },
            setApplyDisabled: function(disabled) {
                applyDisabled = Boolean(disabled);
                apply.getElement().disabled = busy || applyDisabled;
            }
        };
    }
    return { open: open, trapTab: trapTab };
});
