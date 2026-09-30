"""Send the example reminder for a given slot.

ILLUSTRATIVE TEMPLATE — not working code. `apps.example_app` and
`send_example_reminder` do not exist in this repo; they stand in for the app and
the `utils.py` function your command will actually call. Rename everything here
before use, and do not cite any identifier in this file as existing code.
"""

import logging

from django.core.management.base import BaseCommand

from apps.example_app.utils import send_example_reminder

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    """Send the example reminder for the slot given on the command line."""

    def add_arguments(self, parser):
        """Register the --slot option on the parser.

        :param parser: argparse parser
        """
        parser.add_argument("--slot", type=int, required=True)

    def handle(self, *args, **options):
        """Send the reminder for the requested slot, logging any failure.

        :param args: tuple
        :param options: dict
        """
        try:
            send_example_reminder(options["slot"])
        except Exception:
            logger.exception("Error while sending the example reminder.")
