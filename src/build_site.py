#!/usr/bin/env python3
"""Сборка сайта «ШинаСервис» из исходных частей в один самодостаточный HTML.

Использование:
    python3 build_site.py <dir_с_частями> <выходной_файл>

Части склеиваются по порядку: head+css -> публичный HTML -> админка ->
публичный JS -> JS админки/сотрудников.
"""
import sys
from pathlib import Path

PARTS = [
    "part1_head_css.html",
    "part2_public.html",
    "part3_admin.html",
    "part4_js_public.html",
    "part5_js_admin.html",
]


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    src_dir = Path(sys.argv[1])
    out_file = Path(sys.argv[2])
    chunks = []
    for name in PARTS:
        path = src_dir / name
        if not path.exists():
            print(f"ОШИБКА: не найдена часть {path}")
            return 1
        chunks.append(path.read_text(encoding="utf-8"))
    html = "".join(chunks)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(html, encoding="utf-8")
    print(f"Собрано: {out_file} ({len(html.encode('utf-8'))} байт)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
