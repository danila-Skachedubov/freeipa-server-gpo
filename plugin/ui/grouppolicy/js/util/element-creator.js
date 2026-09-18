define([], function() {
function classTokens(className) {
    const values = Array.isArray(className) ? className : [className];
    const tokens = [];

    values.forEach(value => {
        if (typeof value !== 'string') return;
        value.split(/\s+/).forEach(token => {
            if (token) tokens.push(token);
        });
    });

    return tokens;
}

/**
 * General-purpose DOM element creation class.
 * Supports attributes, classes, events, and nested elements.
 */
class ElementCreator {
    /**
     * Creates an ElementCreator instance.
     * @param {string} tagName Element tag (div, span, button, etc.).
     * @param {Object} options Element creation options.
     * @param {string|string[]} options.className CSS class or classes.
     * @param {string} options.id Element ID.
     * @param {Object} options.attrs Additional attributes (data-*, aria-*, etc.).
     * @param {string} options.text Text content.
     * @param {string} options.html HTML content (mutually exclusive with text).
     * @param {Object} options.style Inline styles.
     * @param {Object} options.events Event handlers, for example {click: handler, mouseover: handler}.
     * @param {ElementCreator[]|Element[]|string[]} options.children Child elements.
     */
    constructor(tagName = 'div', options = {}) {
        this.element = document.createElement(tagName);
        this.applyOptions(options);
    }

    /**
     * Applies options to the element.
     * @private
     */
    applyOptions(options) {
        const {
            className,
            id,
            attrs = {},
            text,
            html,
            style = {},
            events = {},
            children = []
        } = options;

        // Apply the ID.
        if (id) {
            this.element.id = id;
        }

        // Apply classes.
        const classes = classTokens(className);
        if (classes.length > 0) {
            this.element.classList.add(...classes);
        }

        // Apply additional attributes.
        Object.entries(attrs).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
                this.element.setAttribute(key, value);
            }
        });

        // Apply inline styles.
        Object.entries(style).forEach(([key, value]) => {
            this.element.style[key] = value;
        });

        // Apply text content.
        if (text !== undefined && text !== null) {
            this.element.textContent = text;
        }

        // Apply HTML content, which takes precedence over text.
        if (html !== undefined && html !== null) {
            this.element.innerHTML = html;
        }

        // Apply event handlers.
        Object.entries(events).forEach(([eventName, handler]) => {
            if (typeof handler === 'function') {
                this.element.addEventListener(eventName, handler);
            }
        });

        // Append child elements.
        if (Array.isArray(children) && children.length > 0) {
            children.forEach(child => {
                this.append(child);
            });
        }
    }

    /**
     * Adds one or more classes to the element.
     * @param {string|string[]} className Class or classes to add.
     * @returns {ElementCreator} This instance for method chaining.
     */
    addClass(className) {
        const classes = classTokens(className);
        if (classes.length > 0) this.element.classList.add(...classes);
        return this;
    }

    /**
     * Removes one or more classes from the element.
     * @param {string|string[]} className Class or classes to remove.
     * @returns {ElementCreator} This instance for method chaining.
     */
    removeClass(className) {
        const classes = classTokens(className);
        if (classes.length > 0) this.element.classList.remove(...classes);
        return this;
    }

    /**
     * Toggles a class on the element.
     * @param {string} className Class to toggle.
     * @returns {ElementCreator} This instance for method chaining.
     */
    toggleClass(className) {
        this.element.classList.toggle(className);
        return this;
    }

    /**
     * Sets an element attribute.
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @returns {ElementCreator} This instance for method chaining.
     */
    setAttr(name, value) {
        if (value !== null && value !== undefined) {
            this.element.setAttribute(name, value);
        }
        return this;
    }

    /**
     * Removes an element attribute.
     * @param {string} name Attribute name.
     * @returns {ElementCreator} This instance for method chaining.
     */
    removeAttr(name) {
        this.element.removeAttribute(name);
        return this;
    }

    /**
     * Sets the text content.
     * @param {string} text Text content.
     * @returns {ElementCreator} This instance for method chaining.
     */
    setText(text) {
        this.element.textContent = text;
        return this;
    }

    /**
     * Sets the HTML content.
     * @param {string} html HTML string.
     * @returns {ElementCreator} This instance for method chaining.
     */
    setHTML(html) {
        this.element.innerHTML = html;
        return this;
    }

    /**
     * Sets inline styles.
     * @param {Object|string} style Style object or CSS string.
     * @returns {ElementCreator} This instance for method chaining.
     */
    setStyle(style) {
        if (typeof style === 'string') {
            this.element.style.cssText = style;
        } else {
            Object.entries(style).forEach(([key, value]) => {
                this.element.style[key] = value;
            });
        }
        return this;
    }

    /**
     * Adds an event listener.
     * @param {string} eventName Event name.
     * @param {Function} handler Event handler.
     * @param {Object} options addEventListener options.
     * @returns {ElementCreator} This instance for method chaining.
     */
    on(eventName, handler, options) {
        if (typeof handler === 'function') {
            this.element.addEventListener(eventName, handler, options);
        }
        return this;
    }

    /**
     * Removes an event listener.
     * @param {string} eventName Event name.
     * @param {Function} handler Event handler.
     * @returns {ElementCreator} This instance for method chaining.
     */
    off(eventName, handler) {
        if (typeof handler === 'function') {
            this.element.removeEventListener(eventName, handler);
        }
        return this;
    }

    /**
     * Appends a child.
     * @param {ElementCreator|Element|string} child Child element or text.
     * @returns {ElementCreator} This instance for method chaining.
     */
    append(child) {
        if (child instanceof ElementCreator) {
            this.element.appendChild(child.getElement());
        } else if (child instanceof Element) {
            this.element.appendChild(child);
        } else if (typeof child === 'string') {
            this.element.appendChild(document.createTextNode(child));
        }
        return this;
    }

    /**
     * Prepends a child.
     * @param {ElementCreator|Element|string} child Child element or text.
     * @returns {ElementCreator} This instance for method chaining.
     */
    prepend(child) {
        if (child instanceof ElementCreator) {
            this.element.insertBefore(child.getElement(), this.element.firstChild);
        } else if (child instanceof Element) {
            this.element.insertBefore(child, this.element.firstChild);
        } else if (typeof child === 'string') {
            this.element.insertBefore(document.createTextNode(child), this.element.firstChild);
        }
        return this;
    }

    /**
     * Clears the element content.
     * @returns {ElementCreator} This instance for method chaining.
     */
    clear() {
        this.element.innerHTML = '';
        return this;
    }

    /**
     * Returns the created DOM element.
     * @returns {Element} DOM element.
     */
    getElement() {
        return this.element;
    }

    /**
     * Creates an element.
     * @param {string} tagName Element tag.
     * @param {Object} options Element creation options.
     * @returns {ElementCreator} ElementCreator instance.
     */
    static create(tagName = 'div', options = {}) {
        return new ElementCreator(tagName, options);
    }

    /**
     * Creates an element from an HTML string.
     * @param {string} html HTML string.
     * @returns {Element} DOM element.
     */
    static fromHTML(html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstChild;
    }
}

/**
 * Convenience function for creating elements.
 * @param {string} tagName Element tag.
 * @param {Object} options Element creation options.
 * @returns {ElementCreator} ElementCreator instance.
 */
function createElement(tagName = 'div', options = {}) {
    return new ElementCreator(tagName, options);
}

/**
 * Convenience function for creating an element from HTML.
 * @param {string} html HTML string.
 * @returns {Element} DOM element.
 */
function fromHTML(html) {
    return ElementCreator.fromHTML(html);
}

// Expose createElement globally when the module loads.
if (typeof window !== 'undefined') {
    window.createElement = createElement;
}
    return { createElement, fromHTML, ElementCreator, default: ElementCreator };
});
