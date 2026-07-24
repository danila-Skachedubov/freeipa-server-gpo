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
 * Универсальный класс для создания DOM элементов
 * Поддерживает создание элементов с атрибутами, классами, событиями и вложенными элементами
 */
class ElementCreator {
    /**
     * Создает новый экземпляр ElementCreator
     * @param {string} tagName - Тег элемента (div, span, button и т.д.)
     * @param {Object} options - Опции для создания элемента
     * @param {string|string[]} options.className - CSS класс(ы)
     * @param {string} options.id - ID элемента
     * @param {Object} options.attrs - Дополнительные атрибуты (data-*, aria-*, и т.д.)
     * @param {string} options.text - Текстовое содержимое
     * @param {string} options.html - HTML содержимое (взаимоисключающе с text)
     * @param {Object} options.style - Инлайн стили
     * @param {Object} options.events - Объект с обработчиками событий {click: handler, mouseover: handler}
     * @param {ElementCreator[]|Element[]|string[]} options.children - Дочерние элементы
     */
    constructor(tagName = 'div', options = {}) {
        this.element = document.createElement(tagName);
        this.applyOptions(options);
    }

    /**
     * Применяет опции к элементу
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

        // Применение ID
        if (id) {
            this.element.id = id;
        }

        // Применение классов
        const classes = classTokens(className);
        if (classes.length > 0) {
            this.element.classList.add(...classes);
        }

        // Применение дополнительных атрибутов
        Object.entries(attrs).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
                this.element.setAttribute(key, value);
            }
        });

        // Применение инлайн стилей
        Object.entries(style).forEach(([key, value]) => {
            this.element.style[key] = value;
        });

        // Применение текстового содержимого
        if (text !== undefined && text !== null) {
            this.element.textContent = text;
        }

        // Применение HTML содержимого (имеет приоритет над text)
        if (html !== undefined && html !== null) {
            this.element.innerHTML = html;
        }

        // Применение обработчиков событий
        Object.entries(events).forEach(([eventName, handler]) => {
            if (typeof handler === 'function') {
                this.element.addEventListener(eventName, handler);
            }
        });

        // Добавление дочерних элементов
        if (Array.isArray(children) && children.length > 0) {
            children.forEach(child => {
                this.append(child);
            });
        }
    }

    /**
     * Добавляет класс(ы) к элементу
     * @param {string|string[]} className - Класс(ы) для добавления
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    addClass(className) {
        const classes = classTokens(className);
        if (classes.length > 0) this.element.classList.add(...classes);
        return this;
    }

    /**
     * Удаляет класс(ы) из элемента
     * @param {string|string[]} className - Класс(ы) для удаления
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    removeClass(className) {
        const classes = classTokens(className);
        if (classes.length > 0) this.element.classList.remove(...classes);
        return this;
    }

    /**
     * Переключает класс элемента
     * @param {string} className - Класс для переключения
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    toggleClass(className) {
        this.element.classList.toggle(className);
        return this;
    }

    /**
     * Устанавливает атрибут элемента
     * @param {string} name - Имя атрибута
     * @param {string} value - Значение атрибута
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    setAttr(name, value) {
        if (value !== null && value !== undefined) {
            this.element.setAttribute(name, value);
        }
        return this;
    }

    /**
     * Удаляет атрибут элемента
     * @param {string} name - Имя атрибута
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    removeAttr(name) {
        this.element.removeAttribute(name);
        return this;
    }

    /**
     * Устанавливает текстовое содержимое
     * @param {string} text - Текст
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    setText(text) {
        this.element.textContent = text;
        return this;
    }

    /**
     * Устанавливает HTML содержимое
     * @param {string} html - HTML строка
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    setHTML(html) {
        this.element.innerHTML = html;
        return this;
    }

    /**
     * Устанавливает инлайн стили
     * @param {Object|string} style - Объект со стилями или CSS строка
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
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
     * Добавляет обработчик события
     * @param {string} eventName - Имя события
     * @param {Function} handler - Обработчик события
     * @param {Object} options - Опции addEventListener
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    on(eventName, handler, options) {
        if (typeof handler === 'function') {
            this.element.addEventListener(eventName, handler, options);
        }
        return this;
    }

    /**
     * Удаляет обработчик события
     * @param {string} eventName - Имя события
     * @param {Function} handler - Обработчик события
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    off(eventName, handler) {
        if (typeof handler === 'function') {
            this.element.removeEventListener(eventName, handler);
        }
        return this;
    }

    /**
     * Добавляет дочерний элемент
     * @param {ElementCreator|Element|string} child - Дочерний элемент или текст
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
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
     * Добавляет дочерний элемент в начало
     * @param {ElementCreator|Element|string} child - Дочерний элемент или текст
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
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
     * Очищает содержимое элемента
     * @returns {ElementCreator} - Возвращает this для цепочки вызовов
     */
    clear() {
        this.element.innerHTML = '';
        return this;
    }

    /**
     * Возвращает созданный DOM элемент
     * @returns {Element} - DOM элемент
     */
    getElement() {
        return this.element;
    }

    /**
     * Статический метод для быстрого создания элемента
     * @param {string} tagName - Тег элемента
     * @param {Object} options - Опции для создания элемента
     * @returns {ElementCreator} - Экземпляр ElementCreator
     */
    static create(tagName = 'div', options = {}) {
        return new ElementCreator(tagName, options);
    }

    /**
     * Статический метод для создания элемента из HTML строки
     * @param {string} html - HTML строка
     * @returns {Element} - DOM элемент
     */
    static fromHTML(html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstChild;
    }
}

/**
 * Функция-хелпер для быстрого создания элементов
 * @param {string} tagName - Тег элемента
 * @param {Object} options - Опции для создания элемента
 * @returns {ElementCreator} - Экземпляр ElementCreator
 */
function createElement(tagName = 'div', options = {}) {
    return new ElementCreator(tagName, options);
}

/**
 * Функция-хелпер для создания элемента из HTML
 * @param {string} html - HTML строка
 * @returns {Element} - DOM элемент
 */
function fromHTML(html) {
    return ElementCreator.fromHTML(html);
}

// Делаем createElement доступным глобально при загрузке модуля
if (typeof window !== 'undefined') {
    window.createElement = createElement;
}
    return { createElement, fromHTML, ElementCreator, default: ElementCreator };
});
