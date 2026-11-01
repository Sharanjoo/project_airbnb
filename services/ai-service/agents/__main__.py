"""Run one agent: python -m agents <parser|matching|risk|fairness|chair|explainer>"""
import sys

from .base import main
from .roles import AGENTS

if len(sys.argv) != 2 or sys.argv[1] not in AGENTS:
    sys.exit(f"usage: python -m agents <{'|'.join(AGENTS)}>")
main(AGENTS[sys.argv[1]])
