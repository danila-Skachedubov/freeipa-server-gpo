define(['../../util/element-creator'], function(__dep0) {
var { createElement } = __dep0;


/**
 * Renders the fallback template when no template is defined.
 * @returns {ElementCreator} Element containing a template-not-defined message.
 */
function renderDefaultTemplate() {
    const defaultTemplate = createElement('div', {
        className: 'gp__default-template',
        children: [
            createElement('div', {
                className: 'default-template__message',
                text: 'Шаблон не определен'
            })
        ]
    });

    return defaultTemplate;
}
    return { renderDefaultTemplate };
});
