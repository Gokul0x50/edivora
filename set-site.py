"""Fill in your GitHub username (and optionally your name) everywhere in the site.

Usage (run once, inside this folder):
    python set-site.py your-github-username "Your Name"

It replaces YOUR-USERNAME and YOUR-NAME in every page, the sitemap, robots.txt,
the README and the LICENSE. If you renamed the repository from "edivora",
pass it as a third argument:  python set-site.py your-github-username "Your Name" my-repo
"""
import os, sys

if len(sys.argv) < 2:
    sys.exit(__doc__)
user = sys.argv[1].strip().lower()
name = sys.argv[2] if len(sys.argv) > 2 else user
repo = sys.argv[3] if len(sys.argv) > 3 else 'edivora'
root = os.path.dirname(os.path.abspath(__file__))
changed = 0
for dirpath, dirs, files in os.walk(root):
    if any(p in dirpath for p in (os.sep + 'lib', os.sep + 'fonts', os.sep + '.git')):
        continue
    for f in files:
        if not f.endswith(('.html', '.xml', '.txt', '.md', '.webmanifest', '.js')) and f != 'LICENSE':
            continue
        p = os.path.join(dirpath, f)
        s = open(p, encoding='utf-8').read()
        t = s.replace('YOUR-USERNAME', user).replace('YOUR-NAME', name)
        if repo != 'edivora':
            t = t.replace('github.io/edivora/', f'github.io/{repo}/').replace('github.com/' + user + '/edivora', f'github.com/{user}/{repo}').replace('/edivora/', f'/{repo}/')
        if t != s:
            open(p, 'w', encoding='utf-8').write(t)
            changed += 1
print(f'Updated {changed} files for https://{user}.github.io/{repo}/')
