from __future__ import annotations

import json
from typing import Any

import httpx

from vectorix_polymarket import config
from vectorix_polymarket.types import MarketCard


def _parse_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    return []


def _to_number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def list_active_markets(limit: int | None = None) -> list[MarketCard]:
    size = limit if limit is not None else config.SCAN_LIMIT
    url = f"{config.GAMMA_API.rstrip('/')}/markets"
    params = {"limit": size, "active": "true", "closed": "false"}
    with httpx.Client(timeout=20.0) as client:
        res = client.get(url, params=params)
        res.raise_for_status()
        body = res.json()

    markets: list[MarketCard] = []
    for row in body:
        token_ids = _parse_list(row.get("clobTokenIds"))
        market_id = str(row.get("id") or "")
        liquidity = _to_number(row.get("liquidity"))
        if not market_id or not token_ids or liquidity < config.MIN_LIQUIDITY:
            continue
        markets.append(
            MarketCard(
                id=market_id,
                question=str(row.get("question") or "Untitled market"),
                slug=str(row.get("slug") or ""),
                end_date=row.get("endDate"),
                volume=_to_number(row.get("volume")),
                liquidity=liquidity,
                outcomes=_parse_list(row.get("outcomes")),
                clob_token_ids=token_ids,
            )
        )
    return markets
