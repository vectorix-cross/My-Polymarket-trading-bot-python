/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Shadow Portfolios
   Paper-trades a whale's actions in parallel for validation before copy.
   Tracks shadow positions, shadow PnL, drawdown, max-drawdown.
   LIVE COPY IS HARD DISABLED BY DEFAULT.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type { WhaleTrackingConfig, ShadowPosition, WhaleTrade } from './whale_types';

export class ShadowPortfolioManager {
  private db: WhaleDB;
  private config: WhaleTrackingConfig;

  constructor(db: WhaleDB, config: WhaleTrackingConfig) {
    this.db = db;
    this.config = config;
  }

  /* ━━━━━━━━━━━━━━ Process a whale trade into shadow portfolio ━━━━━━━━━━━━━━ */

  processTradeForShadow(whaleId: number, trade: WhaleTrade): void {
    const whale = this.db.getWhale(whaleId);
    if (!whale || whale.copyMode === 'ALERTS_ONLY') return;

    // HARD SAFETY CHECK: live copy is always disabled
    if (whale.copyMode === 'LIVE_COPY') {
      logger.error({ whaleId }, 'LIVE copy mode attempted — HARD DISABLED. Falling back to PAPER_SHADOW.');
      this.db.updateWhale(whaleId, { copyMode: 'PAPER_SHADOW' });
    }

    // Only proceed for SHADOW_PAPER mode
    let sp = this.db.getShadowPortfolio(whaleId);
    if (!sp) {
      this.db.upsertShadowPortfolio({
        whaleId,
        mode: 'paper',
        positions: [],
        pnlSeries: [],
        totalPnl: 0,
        drawdown: 0,
        lastUpdated: new Date().toISOString(),
      });
      sp = this.db.getShadowPortfolio(whaleId)!;
    }

    // Apply guardrails before shadowing
    if (!this.passesGuardrails(whaleId, trade)) {
      logger.debug({ whaleId, tradeId: trade.tradeId }, 'Trade rejected by shadow guardrails');
      return;
    }

    // Update shadow positions
    const positions = [...sp.positions];
    this.applyShadowTrade(positions, trade);

    // Calculate shadow PnL
    const totalPnl = this.calculateShadowPnl(positions);
    const pnlSeries = [...sp.pnlSeries, totalPnl];
    const peak = Math.max(0, ...pnlSeries);
    const drawdown = peak > 0 ? (peak - totalPnl) / peak : 0;

    // Check drawdown stop
    if (drawdown >= this.config.copy.stopCopyDrawdownPct) {
      logger.warn({ whaleId, drawdown }, 'Shadow portfolio drawdown limit hit — pausing shadow');
      this.db.updateWhale(whaleId, { copyMode: 'ALERTS_ONLY' });
    }

    this.db.upsertShadowPortfolio({
      whaleId,
      mode: 'paper',
      positions,
      pnlSeries,
      totalPnl,
      drawdown,
      lastUpdated: new Date().toISOString(),
    });
  }

  /* ━━━━━━━━━━━━━━ Mark-to-market shadow positions ━━━━━━━━━━━━━━ */

  markToMarket(whaleId: number, currentPrices: Map<string, number>): void {
    const sp = this.db.getShadowPortfolio(whaleId);
    if (!sp) return;

    const positions = sp.positions.map((pos) => {
      const key = `${pos.marketId}:${pos.outcome}`;
      const currentPrice = currentPrices.get(key);
      return { ...pos, currentPrice };
    });

    const totalPnl = positions.reduce((sum, pos) => {
      const current = pos.currentPrice ?? pos.entryPrice;
      const pnl = pos.side === 'BUY'
        ? (current - pos.entryPrice) * pos.shares
        : (pos.entryPrice - current) * pos.shares;
      return sum + pnl;
    }, 0);

    const pnlSeries = [...sp.pnlSeries, totalPnl];
    const peak = Math.max(0, ...pnlSeries);
    const drawdown = peak > 0 ? (peak - totalPnl) / peak : 0;

    this.db.upsertShadowPortfolio({
      whaleId,
      mode: 'paper',
      positions: sp.positions,
      pnlSeries,
      totalPnl,
      drawdown,
      lastUpdated: new Date().toISOString(),
    });
  }

  /* ━━━━━━━━━━━━━━ Guardrail checks ━━━━━━━━━━━━━━ */

  private passesGuardrails(whaleId: number, trade: WhaleTrade): boolean {
    const g = this.config.copy;

    // 1. Trade age check (delay freshness)
    const tradeAgeSeconds = (Date.now() - new Date(trade.ts).getTime()) / 1000;
    if (tradeAgeSeconds > g.maxCopyDelaySeconds) {
      logger.debug({ whaleId, tradeAgeSeconds }, 'Trade too old for shadow copy');
      return false;
    }

    // 2. Size per trade limit
    if (trade.notionalUsd > g.maxSizePerTradeUsd) {
      logger.debug({ whaleId, notional: trade.notionalUsd, limit: g.maxSizePerTradeUsd }, 'Trade exceeds per-trade size limit');
      return false;
    }

    // 3. Slippage check (entry drift)
    if (trade.slippageBps !== null && Math.abs(trade.slippageBps) > g.maxEntryDriftBps) {
      logger.debug({ whaleId, slippageBps: trade.slippageBps, limit: g.maxEntryDriftBps }, 'Trade exceeds entry drift limit');
      return false;
    }

    // 4. Whale score check
    const metrics = this.db.getDailyMetrics(whaleId, {});
    if (metrics.length > 0) {
      const latestScore = metrics[metrics.length - 1].score;
      if (latestScore < g.stopCopyMinScore) {
        logger.debug({ whaleId, score: latestScore, minScore: g.stopCopyMinScore }, 'Whale score below copy threshold');
        return false;
      }
    }

    // 5. Shadow window check
    const whale = this.db.getWhale(whaleId);
    if (whale?.createdAt) {
      const daysTracked = (Date.now() - new Date(whale.createdAt).getTime()) / 86_400_000;
      if (daysTracked < g.minShadowWindowDays) {
        logger.debug({ whaleId, daysTracked, required: g.minShadowWindowDays }, 'Whale not tracked long enough for shadow copy');
        return false;
      }
    }

    return true;
  }

  /* ━━━━━━━━━━━━━━ Apply trade to shadow positions ━━━━━━━━━━━━━━ */

  private applyShadowTrade(positions: ShadowPosition[], trade: WhaleTrade): void {
    const existingIdx = positions.findIndex(
      (p) => p.marketId === trade.marketId && p.outcome === trade.outcome && p.side === trade.side,
    );

    if (trade.side === 'BUY') {
      if (existingIdx >= 0) {
        // Scale into existing position (weighted avg entry)
        const existing = positions[existingIdx];
        const totalShares = existing.shares + trade.size;
        const avgEntry = (existing.entryPrice * existing.shares + trade.price * trade.size) / totalShares;
        positions[existingIdx] = { ...existing, shares: totalShares, entryPrice: avgEntry };
      } else {
        // New position
        positions.push({
          marketId: trade.marketId,
          outcome: trade.outcome,
          side: 'BUY',
          shares: trade.size,
          entryPrice: trade.price,
          entryTs: trade.ts,
        });
      }
    } else {
      // SELL: reduce existing BUY position
      const buyIdx = positions.findIndex(
        (p) => p.marketId === trade.marketId && p.outcome === trade.outcome && p.side === 'BUY',
      );
      if (buyIdx >= 0) {
        const pos = positions[buyIdx];
        pos.shares -= trade.size;
        if (pos.shares <= 0.0001) {
          positions.splice(buyIdx, 1);
        }
      }
    }
  }

  /* ━━━━━━━━━━━━━━ PnL calculation ━━━━━━━━━━━━━━ */

  private calculateShadowPnl(positions: ShadowPosition[]): number {
    // For paper positions we can only track entry-based cost basis
    // True PnL requires mark-to-market which happens in markToMarket()
    return positions.reduce((sum, _pos) => {
      // Unrealized PnL from entry — will be 0 until marked
      return sum + 0;
    }, 0);
  }
}
