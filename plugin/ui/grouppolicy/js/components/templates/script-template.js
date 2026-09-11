define(['../../util/element-creator', '../../locales/translations'], function(__dep0, __dep1) {
var { createElement } = __dep0;
var { t } = __dep1;


function renderScriptButton(className, labelKey, onClick) {
    return createElement('button', {
        className: ['button', className],
        attrs: {
            type: 'button'
        },
        text: t(labelKey),
        events: {
            click: typeof onClick === 'function' ? onClick : function() {}
        }
    });
}

/**
 * Рендерит статический шаблон раздела «Скрипты»
 * @param {Object} options - Опции шаблона (item - выбранный элемент дерева)
 * @returns {ElementCreator} - Элемент шаблона с кнопками сценариев запуска и завершения работы
 */
function renderScriptsTemplate(options) {
    var root = createElement('div', {
        className: 'gp__scripts-template',
        children: [
            createElement('div', {
                className: 'scripts-template__title',
                text: t('systemSettings.scripts')
            }),
            createElement('div', {
                className: 'scripts-template__buttons',
                children: [
                    renderScriptButton('scripts__btn-startup', 'systemSettings.startupScript', function() {}),
                    renderScriptButton('scripts__btn-shutdown', 'systemSettings.shutdownScript', function() {})
                ]
            })
        ]
    });

    root.cleanup = function() {};

    return root;
}
    return { renderScriptsTemplate: renderScriptsTemplate };
});
