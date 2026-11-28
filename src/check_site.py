"""Статическая проверка собранных страниц: id из JS существуют в разметке,
нет мусорных плейсхолдеров. Запуск: python3 check_site.py <папка_сборки>"""
import re
import sys
from pathlib import Path

PAGES = ['index.html', 'cabinet.html', 'panel.html', 'admin.html', 'staff.html']
root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/home/z/my-project/github_repo')
fail = False
for name in PAGES:
    p = root / name
    if not p.exists():
        print(f'{name}: ФАЙЛА НЕТ')
        fail = True
        continue
    html = p.read_text(encoding='utf-8')
    blocks = re.findall(r'<script>(.*?)</script>', html, re.S)
    alljs = '\n'.join(blocks)
    ids_used = set(re.findall(r"\$\('#([A-Za-z0-9_-]+)'\)", alljs))
    ids_def = set(re.findall(r'id="([A-Za-z0-9_-]+)"', html))
    # эти id в JS обращаются с проверкой if($('#x'))/if(hs) и могут отсутствовать на странице
    optional = {'heroStats', 'pnlLink', 'svcGrid', 'btnAddBook', 'btnCsv'}
    missing = sorted(ids_used - ids_def - optional)
    leftovers = {pat: len(re.findall(re.escape(pat), html))
                 for pat in ['TODO', 'NaN', '【', '{{']}
    leftovers = {k: v for k, v in leftovers.items() if v}
    status = 'OK' if not missing and not leftovers else 'ПРОБЛЕМЫ'
    print(f'{name}: scripts={len(blocks)} ids={len(ids_used)} '
          f'missing={missing or "none"} leftovers={leftovers or "none"} {status}')
    if missing or leftovers:
        fail = True
raise SystemExit(1 if fail else 0)
