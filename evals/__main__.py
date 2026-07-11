"""Allows `python -m evals` as a shorthand for `python -m evals.run`."""

from __future__ import annotations

import sys

from evals.run import main

if __name__ == "__main__":
    sys.exit(main())
