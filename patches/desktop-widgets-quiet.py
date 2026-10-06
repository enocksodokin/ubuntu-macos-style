#!/usr/bin/env python3
"""Coupe le log de debug de desktop-widgets (~180 lignes/min dans le journal)."""
import sys, pathlib, re

p = pathlib.Path(sys.argv[1]) / "extension.js"
s = p.read_text()
pat = re.compile(r"(?m)^(\s*)console\.log\((`\[desktop-widgets\] _checkFullscreen: hasFullscreen[^\n]*)$")
if not pat.search(s):
    print("widgets: rien a faire"); sys.exit(0)
p.write_text(pat.sub(r"\1// (silenced) console.log(\2", s))
print("widgets: log de debug coupe")
