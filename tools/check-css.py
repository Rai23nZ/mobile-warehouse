#!/usr/bin/env python3
"""
Проверка: все ли utility-классы из разметки и кода описаны в css/app.css.

Зачем это нужно. Tailwind-компилятора в проекте нет — css/app.css написан
вручную. Поэтому класс, добавленный в разметку, но не описанный в CSS,
просто ничего не делает, и ошибка проявляется не сразу, а как «поехавшая
вёрстка» в каком-то одном состоянии интерфейса.

Так, например, слой сканирования с классом `z-[110]` оказался ПОД
модальным окном: у окна z-index 100 из CSS, а у слоя — ничего, потому
что правила для z-[110] в файле не было.

Запуск из корня проекта:

    python tools/check-css.py

Код возврата 1, если найдены неописанные классы, — годится для хука
перед коммитом.
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Классы-крючки: используются только как селекторы для querySelector
# и намеренно не имеют оформления.
HOOKS_WITHOUT_STYLES = {'zone-item'}

JS_FILES = ['js/app.js', 'js/ui.js', 'js/scanner.js', 'js/catalog.js', 'js/store.js', 'js/csv.js']

# Селектор может содержать экранированные символы: .hover\:bg-x, .z-\[100\], .p-1\.5
SELECTOR_RE = re.compile(r'\.((?:\\.|[^\s{},:>+~()\[\]".])+)')


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        return fh.read()


def defined_classes():
    css = read('css/app.css')
    return {m.group(1).replace('\\', '') for m in SELECTOR_RE.finditer(css)}


def used_classes():
    used = {}

    def add(chunk, src):
        for name in chunk.split():
            # пропускаем куски шаблонных строк и подстановки
            if not name or '$' in name or '{' in name or '}' in name or name == '?':
                continue
            used.setdefault(name, set()).add(src)

    for m in re.finditer(r'class="([^"]*)"', read('index.html')):
        add(m.group(1), 'index.html')

    for rel in JS_FILES:
        if not os.path.exists(os.path.join(ROOT, rel)):
            continue
        text = read(rel)
        for m in re.finditer(r'className\s*=\s*[`\'"]([^`\'"]*)', text):
            add(m.group(1), rel)
        for m in re.finditer(r'classList\.(add|remove|toggle)\(([^)]*)\)', text):
            method, args = m.group(1), m.group(2)
            # у toggle() второй аргумент — условие, а не класс:
            #   classList.toggle('hidden', name !== 'work')
            # без этого 'work' из сравнения принималось за имя класса
            if method == 'toggle':
                args = args.split(',', 1)[0]
            for s in re.findall(r'[\'"]([^\'"]+)[\'"]', args):
                add(s, rel)
        for m in re.finditer(r'setAttribute\(\s*[\'"]class[\'"]\s*,\s*[`\'"]([^`\'"]*)', text):
            add(m.group(1), rel)
        # строковые литералы, похожие на набор утилит
        for m in re.finditer(r'[\'"`]([a-z0-9\-\[\]/.: ]{6,})[\'"`]', text):
            s = m.group(1)
            if ' ' in s and re.search(r'(bg|text|border|rounded|flex|grid|gap|shadow|p|m|w|h)-', s):
                add(s, rel)

    return used


def main():
    defined = defined_classes()
    used = used_classes()

    missing = sorted(
        name for name in used
        if name.replace('\\', '') not in defined and name not in HOOKS_WITHOUT_STYLES
    )

    print('классов в разметке и коде: %d' % len(used))
    print('правил в css/app.css:      %d' % len(defined))

    if not missing:
        print('\nOK: все классы описаны')
        return 0

    print('\nНЕ ОПИСАНО В CSS: %d' % len(missing))
    for name in missing:
        print('  %-28s <- %s' % (name, ', '.join(sorted(used[name]))))
    print('\nДопишите правила в css/app.css и поднимите SHELL_VERSION в sw.js.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
