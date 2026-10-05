define(['../util/element-creator', '../locales/translations'], function(elements, translations) {
    'use strict';

    var create = elements.createElement;
    var nextId = 0;

    function open(host, options) {
        var config = options || {};
        var container = host && host.getElement ? host.getElement() : host;
        if (!container || typeof container.appendChild !== 'function') {
            throw new TypeError('A confirmation dialog host is required.');
        }

        var previous = document.activeElement;
        var id = 'gpo-confirmation-' + (++nextId);
        var closed = false;
        var no = create('button', {
            className: ['btn', 'btn-no'],
            attrs: { type: 'button' },
            text: config.cancelLabel || translations.t('policyChangedModal.no')
        });
        var yes = create('button', {
            className: ['btn', 'btn-yes'],
            attrs: { type: 'button' },
            text: config.confirmLabel || translations.t('policyChangedModal.yes')
        });
        var content = create('div', {
            id: id + '-message', className: 'policy-changed__modal-content',
            text: config.message || ''
        });
        if (config.content) {
            content.getElement().appendChild(config.content.getElement
                ? config.content.getElement() : config.content);
        }
        var modal = create('div', {
            className: ['policy-changed__modal', 'policy-changed__modal--discard'],
            attrs: {
                role: 'alertdialog',
                'aria-modal': 'true',
                'aria-labelledby': id + '-title',
                'aria-describedby': id + '-message'
            },
            children: [create('div', {
                className: 'policy-changed__modal-wrapper',
                children: [
                    create('div', {
                        className: 'policy-changed__modal-header',
                        children: [create('div', {
                            id: id + '-title', className: 'title',
                            text: config.title || translations.t('confirmModal.title')
                        })]
                    }),
                    content,
                    create('div', {
                        className: 'policy-changed__modal-footer',
                        children: [no, yes]
                    })
                ]
            })]
        });

        function close() {
            if (closed) return;
            closed = true;
            modal.getElement().remove();
            if (previous && previous.isConnected && previous.focus) previous.focus();
        }

        function choose(confirmed) {
            if (closed) return;
            close();
            var callback = confirmed ? config.onConfirm : config.onCancel;
            if (typeof callback === 'function') callback();
        }

        no.on('click', function() { choose(false); });
        yes.on('click', function() { choose(true); });
        modal.on('keydown', function(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                choose(false);
            } else if (event.key === 'Tab') {
                if (event.shiftKey && document.activeElement === no.getElement()) {
                    event.preventDefault();
                    yes.getElement().focus();
                } else if (!event.shiftKey && document.activeElement === yes.getElement()) {
                    event.preventDefault();
                    no.getElement().focus();
                }
            }
        });

        container.appendChild(modal.getElement());
        void modal.getElement().offsetHeight;
        modal.getElement().classList.add('active');
        no.getElement().focus();
        return { close: close, root: modal.getElement() };
    }

    return { open: open };
});
