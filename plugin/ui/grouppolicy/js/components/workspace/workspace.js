define(['../../util/element-creator'], function(__dep0) {
var { createElement } = __dep0;


function renderWorkspace() {
    const element = createElement('div', {
        className: 'workspace'
    });
    
    return element; // Return ElementCreator so callers can use its methods.
}
    return { renderWorkspace };
});
