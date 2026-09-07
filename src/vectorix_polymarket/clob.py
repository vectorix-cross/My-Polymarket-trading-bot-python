from __future__ import annotations

import httpx

from vectorix_polymarket import config
from vectorix_polymarket.types import BookLevel, OrderBook


def _levels(rows: list[dict] | None) -> list[BookLevel]:
    out: list[BookLevel] = []
    for row in rows or []:
        try:
            price = float(row["price"])
            size = float(row["size"])
        except (KeyError, TypeError, ValueError):
            continue
        if size > 0:
            out.append(BookLevel(price=price, size=size))
    return out


def fetch_book(token_id: str) -> OrderBook:
    url = f"{config.CLOB_API.rstrip('/')}/book"
    with httpx.Client(timeout=20.0) as client:
        res = client.get(url, params={"token_id": token_id})
        res.raise_for_status()
        body = res.json()

    bids = sorted(_levels(body.get("bids")), key=lambda level: level.price, reverse=True)
    asks = sorted(_levels(body.get("asks")), key=lambda level: level.price)
    best_bid = bids[0].price if bids else None
    best_ask = asks[0].price if asks else None
    mid = None
    if best_bid is not None and best_ask is not None:
        mid = (best_bid + best_ask) / 2
    elif best_bid is not None:
        mid = best_bid
    elif best_ask is not None:
        mid = best_ask
    spread = (best_ask - best_bid) if best_bid is not None and best_ask is not None else None
    return OrderBook(token_id=token_id, bids=bids, asks=asks, mid=mid, spread=spread)
