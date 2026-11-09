# ONESHOT-GENERATED hrdb/local_settings.py — written by scripts/provision-seed.cjs
# from config/erp/local_settings.template.py. Edit the template or the env file
# (DB_*, REDIS_URL, ODOO_*, ONESHOT_APP_ALLOWED_HOSTS) and re-run provision-seed; a hand
# edit here is overwritten. Delete the first line to make this file yours, and
# provision-seed will leave it alone from then on.
#
# hrdb/config.py star-imports this module at its end, so every name below
# overrides config.py's default. No /etc/hrdb/settings.ini is involved: the
# tracked settings only read it through a deployed local_settings.py, and this
# one carries its values directly.
#
# Every value is a plain literal on purpose: src/lib/rundb.cjs reads NAME, HOST,
# PORT, USER and CELERY_BROKER_URL out of this file and re-points a worktree's
# copy at its own oneshot_run_<iid>_<hex> database and Redis DB.

DEBUG = False
PROD = False

ALLOWED_HOSTS = {{ALLOWED_HOSTS}}
INTERNAL_IPS = ["127.0.0.1"]

DATABASE_NAME = {{DB_NAME}}
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql_psycopg2",
        "NAME": {{DB_NAME}},
        "USER": {{DB_USER}},
        "PASSWORD": {{DB_PASSWORD}},
        "HOST": {{DB_HOST}},
        "PORT": {{DB_PORT}},
    }
}

CELERY_BROKER_URL = {{REDIS_URL}}

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
SEND_MAIL = False
MAIL_TO_ALL = False

USE_ODOO = {{USE_ODOO}}
ODOO_URL = {{ODOO_URL}}
ODOO_DB = {{ODOO_DB}}
ODOO_USERNAME = {{ODOO_USERNAME}}
ODOO_PASSWORD = {{ODOO_PASSWORD}}
USE_HIRESTREAM = False
USE_GOOGLE = False
USE_HELPDESK = False
USE_MERCHANDISE_STORE = False
USE_CHECKIN_DB = False
USE_ZOOM = False
USE_ADOBESIGN = False
USE_IRIS = False
USE_HUBSPOT = False
USE_SOPHIA = False
USE_CLAIM_VERIFICATION = False
AUDIT_LLM_ENABLED = False
LLM_ENABLED = False
SENTRY_DSN = ""
