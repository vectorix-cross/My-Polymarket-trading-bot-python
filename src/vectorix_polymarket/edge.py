from __future__ import annotations

from vectorix_polymarket import config
from vectorix_polymarket.types import EdgeIdea, MarketCard, OrderBook


def score_book(market: MarketCard, outcome: str, book: OrderBook) -> EdgeIdea | None:
    """Flag wide two-sided books in the tradable mid band. Not a guaranteed bet."""
    if book.mid is None or book.spread is None:
        return None
    if not book.bids or not book.asks:
        return None

    mid = book.mid
    spread = book.spread
    bid_depth = sum(level.size for level in book.bids[:3])
    ask_depth = sum(level.size for level in book.asks[:3])

    if mid < 0.08 or mid > 0.92:
        return None
    if spread < config.MIN_EDGE:
        return None
    if min(bid_depth, ask_depth) < 10:
        return None

    side = "SELL" if mid > 0.5 else "BUY"
    return EdgeIdea(
        market=market,
        token_id=book.token_id,
        outcome=outcome,
        mid=mid,
        edge=spread,
        side=side,
        reason=f"spread {spread:.3f} prob, depth bid/ask {bid_depth:.0f}/{ask_depth:.0f}",
    )


def rank_ideas(ideas: list[EdgeIdea]) -> list[EdgeIdea]:
    return sorted(ideas, key=lambda idea: idea.edge, reverse=True)
