"""
Connection settings for the conformance matrices.

Read from the environment, falling back to the project's .env file, so the
matrices connect the same way the application does. The matrices originally
hard-coded a Unix socket; Windows PostgreSQL listens on TCP only.

M / I   appconn — the role under test. Never the owner, or RLS would not apply.
SU/SUI  the superuser — used only to build fixtures around the test.
"""
import os, pathlib, sys

def _load_env():
    env_file = pathlib.Path(__file__).resolve().parent.parent / '.env'
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        os.environ.setdefault(key.strip(), value.strip())

_load_env()

HOST = os.environ.get('PGHOST') or ('localhost' if sys.platform == 'win32' else '/var/run/postgresql')
PORT = os.environ.get('PGPORT', '5432')
_app = dict(host=HOST, port=PORT, user='appconn',
            password=os.environ.get('APPCONN_PASSWORD'))
_su = dict(host=HOST, port=PORT, user=os.environ.get('PG_SUPERUSER', 'postgres'),
           password=os.environ.get('PG_SUPERUSER_PASSWORD'))

MAINT_DB = os.environ.get('MAINT_DB', 'ncl_maint')
IDENTITY_DB = os.environ.get('IDENTITY_DB', 'ncl_identity')
M   = dict(_app, dbname=MAINT_DB)
I   = dict(_app, dbname=IDENTITY_DB)
SU  = dict(_su,  dbname=MAINT_DB)
SUI = dict(_su,  dbname=IDENTITY_DB)
