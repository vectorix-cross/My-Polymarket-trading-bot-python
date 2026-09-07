from __future__ import annotations

import sys

from vectorix_polymarket.clob import fetch_book
from vectorix_polymarket.edge import rank_ideas, score_book
from vectorix_polymarket.gamma import list_active_markets
from vectorix_polymarket.paper import PaperBroker
from vectorix_polymarket.types import EdgeIdea


def collect_ideas(limit: int | None = None) -> list[EdgeIdea]:
    ideas: list[EdgeIdea] = []
    for market in list_active_markets(limit):
        for index, token_id in enumerate(market.clob_token_ids):
            outcome = market.outcomes[index] if index < len(market.outcomes) else f"outcome-{index}"
            try:
                book = fetch_book(token_id)
                idea = score_book(market, outcome, book)
                if idea:
                    ideas.append(idea)
            except Exception as err:  # noqa: BLE001 — skip one token, keep scanning
                print(f"skip {market.slug} {outcome}: {err}", file=sys.stderr)
    return rank_ideas(ideas)


def print_idea(idea: EdgeIdea) -> None:
    print(
        f"{idea.side.ljust(4)}  mid={idea.mid:.3f}  spread={idea.edge:.3f}  {idea.market.question}"
    )
    print(f"      {idea.outcome}  {idea.reason}")


def scan() -> int:
    ideas = collect_ideas()
    if not ideas:
        print("No candidates under current risk filters.")
        return 0
    print(f"Candidates: {len(ideas)}\n")
    for idea in ideas[:15]:
        print_idea(idea)
    return 0


def paper() -> int:
    ideas = collect_ideas()
    broker = PaperBroker()
    for idea in ideas:
        fill = broker.take(idea)
        if fill:
            print(
                f"PAPER {fill.side} {fill.size} @ {fill.price:.3f}  {idea.market.question}"
            )
    summary = broker.summary()
    print(
        f"\nPaper session: {summary['fills']} fills, "
        f"spent ~{summary['spent']:.2f} USDC across {summary['markets']} markets."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    cmd = args[0] if args else "scan"
    if cmd == "scan":
        return scan()
    if cmd == "paper":
        return paper()
    print("Usage: python -m vectorix_polymarket [scan|paper]", file=sys.stderr)
    return 1
