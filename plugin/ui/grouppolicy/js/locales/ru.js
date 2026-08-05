define([], function() {
  return {
    // Общие тексты
    common: {
      help: 'Помощь:',
      description: 'Описание:',
      options: 'Опции:',
      comment: 'Комментарий:',
      edit: 'Редактировать'
    },

    // Политики
    policies: {
      localGroupPolicy: '[Локальная групповая политика]',
      machine: 'Компьютер',
      machineLevelPolicies: 'Политики настройки компьютера',
      user: 'Пользователь',
      userLevelPolicies: 'Политики настройки пользователей',
      adminTemplates: 'Административные шаблоны',
      machineAdminTemplates: 'Административные шаблоны компьютера',
      userAdminTemplates: 'Пользовательские административные шаблоны',
      localGroupPolicies: 'Шаблон локальных групповых политик',
      policy: 'Политика:',
      policyState: 'Состояние политики:',
      notConfigured: 'Не сконфигурировано',
      enabled: 'Включено',
      disabled: 'Отключено',
      supportedOn: 'Поддерживается на:',
    },

    // Настройки (Preferences)
    preferences: {
      title: 'Настройки',
      description: 'Политики настроек.',
      systemSettings: 'Настройки Системы',
      systemSettingsDesc: 'Политики устанавливающие настройки системы.',
      shortcuts: 'Значки',
      environment: 'Окружение',
      folders: 'Папки',
      registry: 'Реестр',
      driveMaps: 'Сетевые диски',
      networkShares: 'Сетевые папки',
      files: 'Файлы',
      iniFiles: 'Ini файлы',
      editor: {
        documentEditable: 'Документ доступен для изменения',
        documentReadOnly: 'Документ доступен только для чтения',
        emptyItems: 'В этом документе нет элементов.',
        itemColumn: 'Элемент',
        filtersColumn: 'Выбор элементов',
        actionsColumn: 'Действия',
        statusColumn: 'Состояние',
        yes: 'Да',
        no: 'Нет',
        createTitle: 'Создание элемента настройки',
        editTitle: 'Изменение элемента настройки',
        viewTitle: 'Сведения об элементе настройки',
        readonly: 'Только чтение',
        specified: 'Задано',
        unspecified: 'Не задано',
        userContext: 'Выполнять в контексте безопасности вошедшего пользователя (параметр политики пользователя)',
        filtersHeading: 'Выбор элементов',
        selectFilter: 'Выберите фильтр для просмотра его полей.',
        filterType: 'Тип фильтра',
        addFilter: 'Добавить фильтр',
        replaceFilter: 'Заменить тип',
        removeFilter: 'Удалить фильтр',
        saveNewCollectionFirst: 'Сохраните новую коллекцию, прежде чем добавлять вложенные фильтры.',
        oneStructuralChangeLimit: 'Сохраните текущее изменение структуры фильтров, прежде чем выполнять следующее.',
        unsupportedFilterFields: 'Поля этого фильтра не поддерживаются. Фильтр можно оставить, заменить или удалить.',
        rename: 'Имя',
        parent: 'Родительская папка',
        validationRequired: 'Это поле обязательно.',
        validationInvalidNumber: 'Введите корректное число.',
        validationUnsignedByteRange: 'Введите число от 0 до 255.',
        validationFixErrors: 'Исправьте выделенные поля перед сохранением.',
        save: 'Сохранить',
        saving: 'Сохранение…',
        cancel: 'Отмена',
        close: 'Закрыть',
        delete: 'Удалить',
        refresh: 'Обновить',
        confirmSave: 'Сохранить изменения?',
        confirmCancelDiscard: 'Отменить и отбросить несохранённые изменения?',
        confirmCloseDiscard: 'Закрыть и отбросить несохранённые изменения?',
        confirmDelete: 'Удалить выбранный элемент настройки?',
        confirmRefreshDiscard: 'Обновить данные с сервера и отбросить текущий черновик?',
        confirmDiscardChanges: 'Отбросить несохранённые изменения?',
        reconcileSucceededRefresh: 'Восстановление публикации завершено. Обновите элемент перед дальнейшим изменением.'
      }
    },

    treeView: {
      loadingPolicies: 'Loading policies...',
      unableToLoadPolicies: 'Не удалось загрузить политики.'
    },

    header: {
      create: 'Создать',
      edit: 'Изменить',
      delete: 'Удалить',
      apply: 'Применить',
      cancel: 'Отмена',
      information: 'Сведения'
    },

    systemSettings: {
      systemSettings:'Настройки Системы',
      scripts: 'Скрипты'
    },

    policyChangedModal: {
      title: 'Состояние настроек',
      message: 'Настройки политики были изменены, хотите сохранить их?',
      no: 'Нет',
      yes: 'Да'
    },
  };
});
