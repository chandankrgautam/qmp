#!/usr/bin/env python3
"""
Conformance matrices — runner.

Four matrices, run in order against a CLEAN database. Ticket history is
append-only and cannot be cleared, which is correct and deliberate, so a
database that has served traffic cannot be reused for these:

    npm run db:reset && python sql/04_conformance_matrix.py

Each part is a separate file so it can also be run on its own, immediately
after a reset.
"""
import subprocess, sys, pathlib, os

# The matrices print ✓ and ·. On Windows a piped Python writes cp1252,
# which cannot encode them, and every part crashed mid-table. UTF-8 both ways.
sys.stdout.reconfigure(encoding='utf-8')
CHILD_ENV = dict(os.environ, PYTHONIOENCODING='utf-8')

HERE = pathlib.Path(__file__).parent
PARTS = ['matrix_test.py', 'matrix2.py', 'matrix3.py', 'matrix4.py']

failed = 0
for part in PARTS:
    path = HERE / part
    if not path.exists():
        print(f"  {part}: not found next to this runner")
        failed += 1
        continue
    r = subprocess.run([sys.executable, str(path)], capture_output=True,
                       text=True, encoding='utf-8', env=CHILD_ENV)
    print(r.stdout.rstrip())
    # every part now exits non-zero on a mismatch, so the exit code alone
    # decides; matching on printed text could let a failing part pass
    if r.returncode != 0:
        failed += 1
        if r.stderr:
            print(r.stderr.strip()[:400])

sys.exit(1 if failed else 0)
