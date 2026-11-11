# ONESHOT-GENERATED hrdb/test_settings_oneshot.py — written into every worktree by
# src/lib/worktrees.ts (seedWorktree) from config/erp/test_settings.template.py, and
# kept out of git by .git/info/exclude. Edit the template; a hand edit here is
# overwritten the next time the worktree is seeded.
#
# Run Django tests with it:
#
#     python manage.py test <labels> --settings=hrdb.test_settings_oneshot --noinput
#
# It is hrdb.test_settings with the database connection this checkout already runs
# the app on (hrdb/local_settings.py), the same way hrdb/test_settings_ci.py is
# hrdb.test_settings with CI's database host. hrdb.test_settings itself hardcodes a
# `postgres` superuser on localhost, which a desk or server that provisions its own
# role does not have: there, every `manage.py test --settings=hrdb.test_settings`
# stops at "password authentication failed for user postgres" before a test runs.
#
# NAME comes across too, on purpose. Django builds its test database as test_<NAME>,
# and a run worktree's local_settings.py names that run's own database, so two runs
# testing at once each get their own test database instead of destroying one
# another's. The connecting role needs CREATEDB, which a role that copies the per-run
# databases already has.
#
# pylint: disable=wildcard-import,unused-wildcard-import,invalid-name
from hrdb import local_settings as _oneshot_local
from hrdb.test_settings import *  # noqa: F401,F403

_oneshot_db = _oneshot_local.DATABASES["default"]
for _oneshot_key in ("NAME", "USER", "PASSWORD", "HOST", "PORT"):
    if _oneshot_key in _oneshot_db:
        DATABASES["default"][_oneshot_key] = _oneshot_db[_oneshot_key]
