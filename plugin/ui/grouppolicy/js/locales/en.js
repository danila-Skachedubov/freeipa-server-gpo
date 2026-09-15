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

    // Menu
    menu: {
      groupPolicy: 'GROUP Policy',
      chains: 'Chains',
      groupPolicyObjects: 'Group Policy Objects'
    },

    // Group Policy Chains
    chain: {
      enable: 'Enable',
      disable: 'Disable',
      moveUp: 'Move Up',
      moveDown: 'Move Down',
      title: 'Group Policy Chain',
      titlePlural: 'Group Policy Chains',
      gpoTab: 'Group Policy Objects',
      statusActive: 'Active',
      statusInactive: 'Inactive',
      statusUnknown: 'Unknown',
      fields: {
        cn: 'Chain name',
        usergroup: 'User group',
        computergroup: 'Computer group',
        active: 'Active'
      }
    },

    // Политики
    policies: {
      localGroupPolicy: '[Local Group Policy]',
      machine: 'Machine',
      machineLevelPolicies: 'Machine level policies',
      user: 'User',
      userLevelPolicies: 'User level policies',
      adminTemplates: 'Administrative Templates',
      machineAdminTemplates: 'Machine administrative templates',
      userAdminTemplates: 'User administrative templates',
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
        applyOnce: 'Apply only once',
        itemSelection: 'Item selection',
        filtersHeading: 'Item-level targeting',
        tabBasic: 'Basic settings',
        tabGeneral: 'General',
        targettingButton: 'Targetting',
        targettingTitle: 'Targetting',
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
        reconcileSucceededRefresh: 'Publication recovery succeeded. Refresh the item before editing it again.',
        settingsTitle: 'Settings:',
        descriptionTitle: 'Description:',
        noDescription: 'No description',
        settingBypassErrors: 'Ignore errors',
        settingRemovePolicy: 'Remove policy',
        settingDisabled: 'Disabled',
        columnName: 'Name',
        columnOrder: 'Order',
        columnAction: 'Action',
        columnTarget: 'Target',
        columnPath: 'Path',
        columnSourcePath: 'Source path',
        columnTargetPath: 'Target path',
        columnShortcutPath: 'Shortcut path',
        columnHive: 'Hive',
        columnKey: 'Key',
        columnUserLimit: 'User limit',
        columnAbe: 'Access-based enumeration',
        columnSection: 'Section',
        columnProperty: 'Property',
        columnValue: 'Value',
        columnLetter: 'Letter',
        columnDriver: 'Driver',
        columnServer: 'Server',
        columnDatabase: 'Database',
        columnDeviceClass: 'Device class',
        columnDeviceId: 'Device ID',
        columnLocation: 'Location',
        columnStartupType: 'Startup type',
        columnServiceAction: 'Service action',
        columnApplication: 'Application',
        columnUserName: 'User name',
        columnIpAddress: 'IP address',
        columnSystemLocale: 'System locale',
        actionCreate: 'Create',
        actionReplace: 'Replace',
        actionUpdate: 'Update',
        actionDelete: 'Delete'
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
      scripts: 'Scripts',
      startupScript: 'Startup script',
      shutdownScript: 'Shutdown script',
      dialogTitle: 'Settings dialog',
      tabScript: 'Script',
      tabPowershell: 'PowerShell scripts',
      scriptsForStartup: 'Scripts: “Startup” for Local Group Policy',
      scriptsForShutdown: 'Scripts: “Shutdown” for Local Group Policy',
      columnName: 'Script name',
      columnArguments: 'Arguments',
      up: 'Up',
      down: 'Down',
      add: 'Add',
      edit: 'Edit',
      remove: 'Remove',
      scriptsPathLabel: 'The script files stored in this Group Policy object are located at the following path: -',
      psOrderLabel: 'Run scripts for this object in the following order:',
      psOrderNotConfigured: 'Not configured',
      psRequirement: 'PowerShell scripts require Windows 7 or Windows Server 2008 R2 at a minimum',
      addTitle: 'Add script',
      editTitle: 'Edit script',
      nameLabel: 'Script name:',
      argumentsLabel: 'Script arguments:',
      nameRequired: 'Enter a script name.',
      ok: 'OK'
    },

    policyChangedModal: {
      title: 'Save settings dialog',
      message: 'Policy settings were modified do you want to save them?',
      no: 'No',
      yes: 'Yes'
    },

    confirmModal: {
      title: 'Confirmation'
    },

  };
});
