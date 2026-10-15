"""Send the example reminder to everyone who is due one.

ILLUSTRATIVE TEMPLATE — not working code. `apps.example_app` and
`send_example_reminder` do not exist in this repo; they stand in for the app and
the `utils.py` function your command will actually call. Rename everything here
before use, and do not cite any identifier in this file as existing code.

Note the shape of the one argument. The crontab calls this command bare, and the
command decides whether today is a day it should act on — `--for-date` exists
only so a human can re-run it for a past date. A flag never tells the command
which slot of a schedule it is; see the SKILL's `add_arguments` section for why.
"""

import logging
from datetime import date

from django.core.management.base import BaseCommand

from apps.example_app.utils import send_example_reminder

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    """Send the example reminder for today, or for an explicitly given date."""

    def add_arguments(self, parser):
        """Register the --for-date override on the parser.

        :param parser: argparse parser
        """
        parser.add_argument("--for-date", type=date.fromisoformat, default=None)

    def handle(self, *args, **options):
        """Send the reminder for the target date, logging any failure.

        :param args: tuple
        :param options: dict
        """
        try:
            send_example_reminder(options["for_date"] or date.today())
        except Exception:
            logger.exception("Error while sending the example reminder.")
