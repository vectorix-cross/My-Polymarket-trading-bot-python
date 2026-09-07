from __future__ import annotations

from datetime import datetime, timezone

from vectorix_polymarket import config
from vectorix_polymarket.types import EdgeIdea, PaperFill


class PaperBroker:
    def __init__(self) -> None:
        self.fills: list[PaperFill] = []
        self._open_markets: set[str] = set()
        self._spent = 0.0

    def can_take(self, idea: EdgeIdea, size: float = 10.0) -> bool:
        if not config.PAPER:
            return False
        notional = idea.mid * size
        if self._spent + notional > config.MAX_NOTIONAL_USDC:
            return False
        if idea.market.id not in self._open_markets and len(self._open_markets) >= config.MAX_OPEN_MARKETS:
            return False
        return True

    def take(self, idea: EdgeIdea, size: float = 10.0) -> PaperFill | None:
        if not self.can_take(idea, size):
            return None
        notional = idea.mid * size
        self._spent += notional
        self._open_markets.add(idea.market.id)
        fill = PaperFill(
            at=datetime.now(timezone.utc).isoformat(),
            market_id=idea.market.id,
            token_id=idea.token_id,
            side=idea.side,
            price=idea.mid,
            size=size,
            notional=notional,
        )
        self.fills.append(fill)
        return fill

    def summary(self) -> dict[str, float | int]:
        return {
            "fills": len(self.fills),
            "spent": self._spent,
            "markets": len(self._open_markets),
        }
