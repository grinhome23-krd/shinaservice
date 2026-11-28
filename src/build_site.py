#!/usr/bin/env python3
"""Сборка многостраничного сайта «ШинаСервис» из исходных частей.

Использование:
    python3 build_site.py <dir_с_частями> <выходная_папка>

Страницы:
    index.html   — главная: услуги, онлайн-запись (кабинета здесь больше нет)
    cabinet.html — личный кабинет клиента (отдельная страница)
    panel.html   — скрытая страница входа персонала (noindex)
    admin.html   — страница управления (noindex, требует сессию)
    staff.html   — панель сотрудника (noindex, требует сессию)

Общие части: head.html (CSS, плейсхолдеры), js_core.html (ядро данных и утилит).
"""
import sys
from pathlib import Path

NOINDEX = '<meta name="robots" content="noindex, nofollow">'

PAGES = [
    {
        'out': 'index.html',
        'title': 'ШинаСервис — онлайн-запись на шиномонтаж',
        'desc': 'Онлайн-запись на шиномонтаж: сезонная смена шин, балансировка, ремонт проколов. Выберите услуги и удобное время — без очередей.',
        'robots': '',
        'body': 'body_index.html',
        'js': ['js_core.html', 'js_booking.html', 'boot_index.html'],
    },
    {
        'out': 'cabinet.html',
        'title': 'ШинаСервис — личный кабинет клиента',
        'desc': 'Личный кабинет клиента: все записи за всё время, перенос и отмена, статистика обслуживания. Вход по номеру телефона с кодом.',
        'robots': '',
        'body': 'body_cabinet.html',
        'js': ['js_core.html', 'js_cabinet.html', 'boot_cabinet.html'],
    },
    {
        'out': 'panel.html',
        'title': 'ШинаСервис — вход для персонала',
        'desc': 'Вход для сотрудников и администратора.',
        'robots': NOINDEX,
        'body': 'body_panel.html',
        # boot раньше js_login: js_login биндит loginBack на showSite из boot
        'js': ['js_core.html', 'boot_panel.html', 'js_login.html'],
    },
    {
        'out': 'admin.html',
        'title': 'ШинаСервис — страница управления',
        'desc': 'Управление записями, услугами, сменами и настройками.',
        'robots': NOINDEX,
        'body': 'body_admin.html',
        'js': ['js_core.html', 'js_admin.html', 'js_edit_shared.html', 'boot_admin.html'],
    },
    {
        'out': 'staff.html',
        'title': 'ШинаСервис — панель сотрудника',
        'desc': 'Записи сотрудника на смене.',
        'robots': NOINDEX,
        'body': 'body_staff.html',
        'js': ['js_core.html', 'js_edit_shared.html', 'js_staff.html', 'boot_staff.html'],
    },
]


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    src_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    def read(name: str) -> str:
        p = src_dir / name
        if not p.exists():
            raise SystemExit(f'ОШИБКА: не найдена часть {p}')
        return p.read_text(encoding='utf-8')

    head = read('head.html')
    for pg in PAGES:
        js = '\n'.join('<script>\n\'use strict\';\n' + read(name) + '\n</script>' for name in pg['js'])
        html = (head
                .replace('{{TITLE}}', pg['title'])
                .replace('{{DESC}}', pg['desc'])
                .replace('{{ROBOTS}}', pg['robots'])
                + '\n' + read(pg['body']) + '\n' + js + '\n</body>\n</html>\n')
        out = out_dir / pg['out']
        out.write_text(html, encoding='utf-8')
        print(f'Собрано: {out} ({len(html.encode("utf-8"))} байт)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
