#!/usr/bin/env python3
"""
Ревизия фотографий товаров: сборка data/img-rev.json.

Зачем это нужно. Фото товаров лежат в кэше устройства и намеренно
переживают обновления приложения: их сотни мегабайт, перекачивать всё
из-за правки в css недопустимо. Но снимок иногда переснимают — и тогда
устройству надо сказать, какой именно артикул устарел.

Ключевое наблюдение: НОВОЕ фото объявлять не нужно. Его на устройстве
ещё нет, оно скачается само при первом показе или прогреве. Обновления
требует только ЗАМЕНА снимка у артикула, чьё фото уже закэшировано.
Замен на порядки меньше, чем добавлений, поэтому список замен остаётся
крошечным, а обновление стоит ровно столько, сколько весят переснятые
кадры, — вместо перекачки всего кэша при подъёме общей версии.

Разницу считает сам git, по статусу файла:

    A  добавлено   → пропускаем, инвалидировать нечего
    M  изменено    → в список
    D  удалено     → в список (в кэше лежит снимок, которого больше нет)
    R  переименовано → в список идёт СТАРОЕ имя

Порядок работы при выкладке фотографий:

    1. скопировать снимки в img/<Сеть>/
    2. git add img/ && git commit -m "photo update"
    3. python tools/img-rev.py
    4. git add data/img-rev.json && git commit -m "img-rev"

Шаг 3 обязательно ПОСЛЕ шага 2: скрипт сравнивает записанный в манифесте
коммит с HEAD, а незакоммиченные файлы в эту разницу не попадают.
Поднимать SHELL_VERSION в sw.js для обновления фотографий не требуется.

Первый запуск:

    python tools/img-rev.py --init
"""

import argparse
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR  = os.path.join(ROOT, 'img')
MANIFEST = os.path.join(ROOT, 'data', 'img-rev.json')

# Сколько ревизий держим в списке замен. Устройство, отставшее сильнее,
# обновит фото сети целиком: разобраться точечно уже нечем.
KEEP_REVS = 50

# Порог, за которым перечислять замены поимённо перестаёт окупаться.
# Список едет к устройству при каждом входе на рабочий экран, и запись в
# нём стоит около 24 байт: тысяча замен — 24 КБ, приемлемо; четырнадцать
# тысяч — треть мегабайта на каждом входе, и так до конца истории.
# Дешевле объявить ревизию без списка: устройство сбросит фотографии этой
# сети целиком и заново прогреет только те, что нужны текущему наряду, —
# а не весь свой кэш. Остальные сети при этом не трогаются.
BULK_LIMIT = 2000

# Приложение просит снимок строго как <Артикул>.jpg (см. photoUrl в
# js/images.js), поэтому файл с другим расширением в кэш попасть не может,
# и объявлять его бессмысленно.
PHOTO_EXT = '.jpg'


def die(message):
    sys.stderr.write('img-rev: ' + message + '\n')
    sys.exit(1)


def git(*args, **kwargs):
    """Возвращает (код возврата, stdout). core.quotepath=false — чтобы пути
       приходили как есть, а не в виде \\320\\236... для O'Stin."""
    check = kwargs.get('check', True)
    proc = subprocess.run(['git', '-c', 'core.quotepath=false'] + list(args),
                          cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode:
        die('git ' + ' '.join(args) + ':\n' + proc.stderr.decode('utf-8', 'replace').strip())
    return proc.returncode, proc.stdout.decode('utf-8', 'replace')


def networks_on_disk():
    if not os.path.isdir(IMG_DIR):
        return []
    return sorted(name for name in os.listdir(IMG_DIR)
                  if os.path.isdir(os.path.join(IMG_DIR, name)))


def parse_photo(path):
    """'img/FunDay/000EHQJ898.jpg' -> ('FunDay', '000EHQJ898').
       Всё, что не фото товара (img/empty.jpg, вложенные папки), — None."""
    parts = path.split('/')
    if len(parts) != 3 or parts[0] != 'img':
        return None
    stem, ext = os.path.splitext(parts[2])
    if ext.lower() != PHOTO_EXT or not stem:
        return None
    return parts[1], stem


def load_manifest():
    if not os.path.exists(MANIFEST):
        return {}
    try:
        with io.open(MANIFEST, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception as exc:
        die('не читается %s: %s' % (MANIFEST, exc))


def changes_since(prev):
    """Артикулы, чьи снимки перестали быть теми же, что были в коммите prev.
       None — если такого коммита в репозитории уже нет."""
    code, out = git('diff', '--name-status', '-M', prev, 'HEAD', '--', 'img/', check=False)
    if code:
        return None

    stale = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split('\t')
        status = parts[0]

        if status.startswith('R'):
            touched = [parts[1]]            # старое имя исчезло — запись в кэше устарела
        elif status.startswith('C'):
            touched = []                    # копия: то же, что добавление
        elif status[:1] in ('M', 'D', 'T'):
            touched = [parts[1]]
        else:
            touched = []                    # A и прочее — нового в кэше нет

        for path in touched:
            hit = parse_photo(path)
            if hit:
                stale.setdefault(hit[0], set()).add(hit[1])
    return stale


def main():
    ap = argparse.ArgumentParser(description='Сборка data/img-rev.json')
    ap.add_argument('--init', action='store_true',
                    help='собрать манифест заново, не разбирая историю')
    ap.add_argument('--dry-run', action='store_true',
                    help='показать, что получится, и ничего не записывать')
    ap.add_argument('--allow-dirty', action='store_true',
                    help='не требовать, чтобы фотографии были закоммичены')
    args = ap.parse_args()

    _, head = git('rev-parse', 'HEAD')
    head = head.strip()

    manifest = load_manifest()
    prev = None if args.init else manifest.get('commit')

    if prev:
        _, dirty = git('status', '--porcelain', '--', 'img/')
        if dirty.strip() and not args.allow_dirty:
            die('в img/ есть незакоммиченные изменения.\n'
                'Манифест собирается ПОСЛЕ коммита фотографий, иначе они в него не попадут:\n'
                '    git add img/ && git commit -m "photo update"\n'
                '    python tools/img-rev.py\n'
                '(осознанно пропустить проверку: --allow-dirty)')

    nets = manifest.get('networks') or {}
    for name in networks_on_disk():
        nets.setdefault(name, {'rev': 1, 'base': 1, 'changed': {}})
    if not nets:
        die('в img/ нет ни одной папки сети — собирать нечего')

    notes = []

    if not prev:
        for info in nets.values():
            info.setdefault('rev', 1)
            info.setdefault('base', 1)
            info.setdefault('changed', {})
        notes.append('манифест создан заново: замен не объявлено, устройства '
                     'считают своё содержимое кэша свежим')
    else:
        stale = changes_since(prev)

        if stale is None:
            # Коммита нет (история переписана или клон неполный). Точечно
            # вычислить нечего: объявляем ревизию без данных — base выше rev,
            # и устройство, отставшее от неё, обновит фото сети целиком.
            for info in nets.values():
                info['rev'] = int(info.get('rev', 1)) + 1
                info['changed'] = {}
                info['base'] = info['rev'] + 1
            notes.append('коммит %s в репозитории не найден: устройства перекачают '
                         'фотографии сетей целиком' % prev[:8])
        elif not stale:
            notes.append('замен не найдено — ревизии не тронуты')
        else:
            for name in sorted(stale):
                info = nets.setdefault(name, {'rev': 0, 'base': 1, 'changed': {}})
                rev = int(info.get('rev', 0)) + 1
                info['rev'] = rev
                count = len(stale[name])

                if count > BULK_LIMIT:
                    # base выше rev означает «точечных данных за эту ревизию
                    # нет»: устройство сбросит фото сети целиком.
                    info['changed'] = {}
                    info['base'] = rev + 1
                    notes.append('%s: ревизия %d, заменено %d — это уже не список, '
                                 'устройства обновят фотографии сети целиком'
                                 % (name, rev, count))
                else:
                    changed = dict(info.get('changed') or {})
                    for article in stale[name]:
                        changed[article] = rev
                    info['changed'] = changed
                    notes.append('%s: ревизия %d, переснято или удалено %d'
                                 % (name, rev, count))

    # Подрезка истории. base — самая ранняя ревизия, представленная в
    # списке полностью; поднимать его можно, опускать нельзя.
    for info in nets.values():
        rev = int(info.get('rev', 1))
        floor = max(1, rev - KEEP_REVS + 1)
        changed = {a: int(r) for a, r in (info.get('changed') or {}).items()
                   if int(r) >= floor}
        info['rev'] = rev
        info['changed'] = dict(sorted(changed.items()))
        info['base'] = max(int(info.get('base', 1) or 1), floor)

    result = {
        '_readme': 'Собирается tools/img-rev.py. Правка руками не нужна: '
                   'rev — номер ревизии фото сети, changed — артикулы, чьи снимки '
                   'заменили, и ревизия замены; base — самая ранняя ревизия, '
                   'ещё представленная в changed.',
        'commit': head,
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'networks': dict(sorted(nets.items()))
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'

    for note in notes:
        print('  ' + note)
    for name in sorted(nets):
        info = nets[name]
        print('  %-14s rev %-4d base %-4d в списке замен: %d'
              % (name, info['rev'], info['base'], len(info['changed'])))

    if args.dry_run:
        print('\n--dry-run: %s не записан (%d байт)' % (MANIFEST, len(text.encode('utf-8'))))
        return

    with io.open(MANIFEST, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print('\nЗаписано: data/img-rev.json (%d байт), коммит %s'
          % (len(text.encode('utf-8')), head[:8]))
    print('Не забыть: git add data/img-rev.json && git commit')


if __name__ == '__main__':
    main()
