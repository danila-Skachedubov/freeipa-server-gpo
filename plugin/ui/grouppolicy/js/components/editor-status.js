define(['../util/element-creator', '../util/editor-dto'], function(elementCreator, dto) {
    "use strict";

    var createElement = elementCreator.createElement;
    var LABELS = {
        authorization: 'Недостаточно прав для работы с этой групповой политикой.',
        validation: 'Проверьте значения отмеченных полей.',
        unsupported: 'Эти данные пока нельзя безопасно изменить.',
        unsupported_content: 'Эти данные пока нельзя безопасно изменить.',
        storage_conflict: 'Политика была изменена другим редактором. Обновите данные.',
        publication_conflict: 'Файлы политики сохранены, но публикация в каталоге конфликтует.',
        publication_recovery: 'Публикация политики требует восстановления.',
        publication_pending: 'Публикация политики не завершена.',
        recovery_operator_action: 'Для восстановления публикации требуется действие оператора.',
        not_found: 'Запрошенный объект больше не существует.',
        operational: 'Не удалось выполнить операцию редактора.'
    };

    function messageForError(error) {
        var category = dto.errorCategory(error).replace(/-/g, '_');
        var prefix = LABELS[category] || LABELS.operational;
        var message = error && error.message ? String(error.message) : '';
        return message && message !== prefix ? prefix + ' ' + message : prefix;
    }

    function renderError(error, options) {
        var config = options || {};
        var category = dto.errorCategory(error).replace(/-/g, '_');
        var actions = [];
        if (typeof config.onRefresh === 'function') {
            actions.push(createElement('button', {
                className: ['button', 'gpo-editor-status__action'],
                attrs: { type: 'button' },
                text: 'Обновить',
                events: { click: config.onRefresh }
            }));
        }
        if ((category.indexOf('publication') !== -1 || error && error.pendingPublication)
                && typeof config.onReconcile === 'function') {
            actions.push(createElement('button', {
                className: ['button', 'gpo-editor-status__action'],
                attrs: { type: 'button' },
                text: 'Согласовать публикацию',
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
                    text: 'Поле: ' + error.field
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
                    text: 'Предыдущая публикация политики не завершена.'
                }),
                typeof onReconcile === 'function' ? createElement('button', {
                    className: ['button', 'gpo-editor-status__action'],
                    attrs: { type: 'button' },
                    text: 'Согласовать публикацию',
                    events: { click: onReconcile }
                }) : null
            ]
        });
    }

    return {
        messageForError: messageForError,
        renderError: renderError,
        renderPending: renderPending
    };
});
