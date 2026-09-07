from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _num(value: str | None, fallback: float) -> float:
    if value is None:
        return fallback
    try:
        parsed = float(value)
    except ValueError:
        return fallback
    return parsed if parsed == parsed else fallback


def _int(value: str | None, fallback: int) -> int:
    return int(_num(value, float(fallback)))


PAPER = (os.getenv("PAPER") or "true").lower() != "false"
GAMMA_API = os.getenv("GAMMA_API") or "https://gamma-api.polymarket.com"
CLOB_API = os.getenv("CLOB_API") or "https://clob.polymarket.com"
MAX_NOTIONAL_USDC = _num(os.getenv("MAX_NOTIONAL_USDC"), 100.0)
MAX_OPEN_MARKETS = _int(os.getenv("MAX_OPEN_MARKETS"), 5)
MIN_EDGE = _num(os.getenv("MIN_EDGE"), 0.04)
MIN_LIQUIDITY = _num(os.getenv("MIN_LIQUIDITY"), 500.0)
SCAN_LIMIT = _int(os.getenv("SCAN_LIMIT"), 25)
