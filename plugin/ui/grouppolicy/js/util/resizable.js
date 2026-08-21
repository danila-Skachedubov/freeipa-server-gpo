define([], function() {
function resizable(divider, panel, container, options = {}) {
    if (!divider || !panel || !container) {
        return () => {};
    }

    const minWidth = options.minWidth || 50;
    const hasExplicitMaxWidth = options.maxWidth !== undefined
        && options.maxWidth !== null;
    const maxWidth = hasExplicitMaxWidth ? options.maxWidth : null;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const handleMouseDown = (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    };

    const handleMouseMove = (e) => {
        if (!isResizing) return;

        const newWidth = startWidth + (e.clientX - startX);
        const calculatedMaxWidth = hasExplicitMaxWidth
            ? maxWidth
            : container.offsetWidth - 50;

        if (newWidth >= minWidth && newWidth <= calculatedMaxWidth) {
            panel.style.width = `${newWidth}px`;
        }
    };

    const stopResizing = () => {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    divider.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);

    return () => {
        divider.removeEventListener('mousedown', handleMouseDown);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
        stopResizing();
    };
}
    return { resizable };
});
