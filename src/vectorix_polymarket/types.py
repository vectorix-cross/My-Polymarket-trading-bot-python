from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class BookLevel:
    price: float
    size: float


@dataclass
class OrderBook:
    token_id: str
    bids: list[BookLevel]
    asks: list[BookLevel]
    mid: float | None
    spread: float | None


@dataclass(frozen=True)
class MarketCard:
    id: str
    question: str
    slug: str
    end_date: str | None
    volume: float
    liquidity: float
    outcomes: list[str]
    clob_token_ids: list[str]


@dataclass
class EdgeIdea:
    market: MarketCard
    token_id: str
    outcome: str
    mid: float
    edge: float
    side: Literal["BUY", "SELL"]
    reason: str


@dataclass
class PaperFill:
    at: str
    market_id: str
    token_id: str
    side: str
    price: float
    size: float
    notional: float
