define([], function() {
  return {
    // Common texts
    common: {
      help: 'Help:',
      description: 'Description:',
      options: 'Options:',
      comment: 'Comment:',
      edit: 'Edit'
    },

    // Политики
    policies: {
      localGroupPolicy: '[Local Group Policy]',
      machine: 'Machine',
      machineLevelPolicies: 'Machine level policies',
      user: 'User',
      userLevelPolicies: 'User level policies',
      adminTemplates: 'Administrative Templates',
      adminTemplatesHelp: 'Registry-based settings that extend Group Policy capabilities of the operating system.',
      machineAdminTemplates: 'Machine administrative templates',
      localGroupPolicies: 'Local group policies templates',
      policy: 'Policy:',
      policyState: 'Policy State',
      notConfigured: 'Not Configured',
      enabled: 'Enabled',
      disabled: 'Disabled',
      supportedOn: 'Supported on:'
    },

    // Настройки (Preferences)
    preferences: {
      title: 'Preferences',
      description: 'Preferences policies.',
      systemSettings: 'System settings',
      systemSettingsDesc: 'Policies that set system settings.',
      shortcuts: 'Shortcuts',
      environment: 'Environment',
      folders: 'Folders',
      registry: 'Registry',
      driveMaps: 'Drive Maps',
      networkShares: 'Network Shares',
      files: 'Files',
      iniFiles: 'Ini File',
      editor: {
        documentEditable: 'This document can be edited',
        documentReadOnly: 'This document is read-only',
        emptyItems: 'This document does not contain any items.',
        itemColumn: 'Item',
        filtersColumn: 'Targeting',
        actionsColumn: 'Actions',
        statusColumn: 'Status',
        yes: 'Yes',
        no: 'No',
        createTitle: 'Create preference item',
        editTitle: 'Edit preference item',
        viewTitle: 'Preference item details',
        readonly: 'Read-only',
        specified: 'Specified',
        unspecified: 'Not specified',
        userContext: "Run in logged-on user's security context (user policy option)",
        filtersHeading: 'Item-level targeting',
        selectFilter: 'Select a filter to view its fields.',
        filterType: 'Filter type',
        addFilter: 'Add filter',
        replaceFilter: 'Replace type',
        removeFilter: 'Remove filter',
        saveNewCollectionFirst: 'Save the new collection before adding nested filters.',
        oneStructuralChangeLimit: 'Save the current structural filter change before making another one.',
        unsupportedFilterFields: 'This filter\'s fields are not supported. You can leave, replace, or remove the filter.',
        rename: 'Name',
        parent: 'Parent folder',
        validationRequired: 'This field is required.',
        validationInvalidNumber: 'Enter a valid number.',
        validationUnsignedByteRange: 'Enter a number from 0 through 255.',
        validationFixErrors: 'Fix the highlighted fields before saving.',
        save: 'Save',
        saving: 'Saving…',
        cancel: 'Cancel',
        close: 'Close',
        delete: 'Delete',
        refresh: 'Refresh',
        confirmSave: 'Save these changes?',
        confirmCancelDiscard: 'Cancel and discard unsaved changes?',
        confirmCloseDiscard: 'Close and discard unsaved changes?',
        confirmDelete: 'Delete the selected preference item?',
        confirmRefreshDiscard: 'Refresh from the server and discard the current draft?',
        confirmDiscardChanges: 'Discard unsaved changes?',
        reconcileSucceededRefresh: 'Publication recovery succeeded. Refresh the item before editing it again.'
      }
    },

    treeView: {
      loadingPolicies: 'Loading policies...',
      unableToLoadPolicies: 'Unable to load policies.'
    },

    header: {
      create: 'Create',
      edit: 'Edit',
      delete: 'Delete',
      apply: 'Apply',
      cancel: 'Cancel',
      information: 'Information'
    },

    systemSettings: {
      systemSettings:'System settings',
      scripts: 'Scripts'
    },

    policyChangedModal: {
      title: 'Save settings dialog',
      message: 'Policy settings were modified do you want to save them?',
      no: 'No',
      yes: 'Yes'
    },

  };
});
