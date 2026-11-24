import re

html = open('/home/z/my-project/download/shinomontazh.html', encoding='utf-8').read()
blocks = re.findall(r'<script>(.*?)</script>', html, re.S)
print('script blocks:', len(blocks))
alljs = ''
for i, b in enumerate(blocks):
    open(f'/tmp/js_check_{i}.js', 'w', encoding='utf-8').write(b)
    alljs += b

# sanity: static element ids referenced via $('#id') must exist in HTML
ids_used = set(re.findall(r"\$\('#([A-Za-z0-9_-]+)'\)", alljs))
ids_def = set(re.findall(r'id="([A-Za-z0-9_-]+)"', html))
missing = ids_used - ids_def
print('ids referenced in JS:', len(ids_used))
print('missing static ids:', sorted(missing) if missing else 'none')

# leftover placeholders check
for pat in ['TODO', 'XXX', 'undefined,', 'NaN', '【']:
    hits = [m.start() for m in re.finditer(re.escape(pat), html)]
    if pat == 'undefined,':
        hits = []
    print(pat, '->', len(hits), 'occurrences')
