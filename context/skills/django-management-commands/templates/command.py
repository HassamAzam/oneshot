"""One-line docstring: what this command does and who or what triggers it."""

import logging

from django.core.management.base import BaseCommand

from apps.project_logs.utils import send_weekly_project_logs_reminder

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    """Send the weekly project-log reminder for the given reminder slot."""

    def add_arguments(self, parser):
        parser.add_argument("--reminder", type=int, choices=[1, 2, 3], required=True)

    def handle(self, *args, **options):
        try:
            send_weekly_project_logs_reminder(options["reminder"])
        except Exception:
            logger.exception("Error while sending weekly project logs reminder.")
