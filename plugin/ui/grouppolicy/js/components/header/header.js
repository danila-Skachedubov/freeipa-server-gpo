define(['../../util/element-creator', '../../locales/translations'], function(__dep0, __dep1) {
var { createElement } = __dep0;
var { t } = __dep1;


function renderHeader(container) {
    const element = createElement('div', {
        className: 'gp__header',
        children: [
            createElement('div', {
                className: 'gp__header-left',
                children: [
                    createElement('div', {
                        className: 'gp__search'
                    }),
                    createElement('div', {
                        className: 'gp__nav'
                    }),
                    createElement('div', {
                        className: 'gp__control',
                        children: [
                            createElement('button', {
                                className: ['button', 'preferences__btn-create'],
                                text: t('header.create')
                            }),
                            createElement('button', {
                                className: ['button', 'preferences__btn-edit'],
                                text: t('header.edit')
                            }),
                            createElement('button', {
                                className: ['button', 'preferences__btn-delete'],
                                text: t('header.delete')
                            })
                        ]
                    })
                ]
            }),
            createElement('div', {
                className: 'gp__control-actions',
                children: [
                    createElement('div', {
                        className: 'gp__control-admx',
                        children: [
                            createElement('button', {
                                className: ['button', 'admx__btn-apply'],
                                text: t('header.apply')
                            }),
                            createElement('button', {
                                className: ['button', 'admx__btn-cancel'],
                                text: t('header.cancel')
                            })
                        ]
                    }),
                    createElement('div', {
                        className: 'gp__control-separator'
                    }),
                    createElement('div', {
                        className: 'gp__control-help',
                        children: [
                            createElement('button', {
                                className: ['button', 'btn-information'],
                                text: t('header.information')
                            })
                        ]
                    })
                ]
            })
        ]
    });
    container.appendChild(element.getElement());
    return element; // Return ElementCreator so callers can use its methods.
}
    return { renderHeader };
});
