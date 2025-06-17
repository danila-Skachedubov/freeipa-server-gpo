#!/bin/bash

# Скрипт для обновления файлов локализации
# Запускать из корня проекта

set -e  # Остановиться при ошибке

PROJECT_NAME="ipa-gpo-install"
VERSION="0.0.1"
BUGS_EMAIL="skachedubov@altlinux.org"

echo "Updating localization files for $PROJECT_NAME..."

mkdir -p locale

echo "Extracting translatable strings..."
find ipa_gpo_install -name "*.py" -exec xgettext \
    --language=Python \
    --keyword=_ \
    --output=locale/$PROJECT_NAME.pot \
    --package-name="$PROJECT_NAME" \
    --package-version="$VERSION" \
    --msgid-bugs-address="$BUGS_EMAIL" \
    --from-code=UTF-8 \
    --add-comments=TRANSLATORS: \
    {} +

echo "Generated locale/$PROJECT_NAME.pot"

echo "Updating existing translation files..."
for po_file in locale/*/LC_MESSAGES/*.po; do
    if [ -f "$po_file" ]; then
        echo "  Updating $po_file"
        msgmerge --update --backup=off "$po_file" "locale/$PROJECT_NAME.pot"
    fi
done

echo ""
echo "Localization update complete!"
echo ""
echo "Next steps:"
echo "1. Edit locale/ru/LC_MESSAGES/$PROJECT_NAME.po to translate new strings"
echo "2. Run 'make compile-po' to compile translations"
echo "3. Test with: LANG=ru_RU.UTF-8 ipa-gpo-install --check-only"