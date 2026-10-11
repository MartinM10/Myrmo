"""Acme's structured logging (internal package, from the company's package index)."""

__version__ = "2.1.0"
SOURCE = "acme-private-index"


def log(event: str, **fields) -> dict:
    return {"event": event, **fields}
