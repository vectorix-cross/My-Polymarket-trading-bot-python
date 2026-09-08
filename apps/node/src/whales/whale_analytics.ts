/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Analytics Engine
   Settlement-aware PnL (FIFO/AVG), timing skill, slippage proxy,
   scoring (0-100) with breakdown, style classification.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type {
  WhaleTrackingConfig, WhaleScoreBreakdown, TimingWindow,
  WhaleMetricsDaily, WhaleTrade, CostBasisMethod,
  WhaleStyle,
} from './whale_types';

interface Lot {
  lotId: string;
  openTs: string;
  qty: number;
  entryPrice: number;
}

export class WhaleAnalytics {
  private db: WhaleDB;
  private config: WhaleTrackingConfig;

  constructor(db: WhaleDB, config: WhaleTrackingConfig) {
    this.db = db;
    this.config = config;
  }

  /* ━━━━━━━━━━━━━━ Full recalculation for a whale ━━━━━━━━━━━━━━ */

  computeAllMetrics(whaleId: number): void {
    this.buildSettlementLedger(whaleId);
    this.computeDailyMetrics(whaleId);
    const score = this.computeScore(whaleId);
    const style = this.classifyStyle(whaleId);
    this.db.updateWhale(whaleId, { style });
    logger.debug({ whaleId, score: score.overall, style }, 'Computed whale metrics');
  }

  /* ━━━━━━━━━━━━━━ Settlement Ledger (FIFO / AVG) ━━━━━━━━━━━━━━ */

  buildSettlementLedger(whaleId: number): void {
    // Get all trades ordered by timestamp
    const allTrades = this.getAllTradesSorted(whaleId);
    if (allTrades.length === 0) return;

    const method = this.config.costBasisMethod;

    // Group trades by (marketId, outcome)
    const groups = new Map<string, WhaleTrade[]>();
    for (const t of allTrades) {
      const key = `${t.marketId}:${t.outcome}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    for (const [, trades] of groups) {
      this.processLotGroup(whaleId, trades, method);
    }
  }

  private processLotGroup(
    whaleId: number,
    trades: WhaleTrade[],
    method: CostBasisMethod,
  ): void {
    const lots: Lot[] = [];
    let lotCounter = 0;

    for (const trade of trades) {
      const marketId = trade.marketId;
      const outcome = trade.outcome;

      if (trade.side === 'BUY') {
        // Open a new lot
        lots.push({
          lotId: `${whaleId}-${marketId}-${lotCounter++}`,
          openTs: trade.ts,
          qty: trade.size,
          entryPrice: trade.price,
        });
        // Record open entry
        this.db.insertSettlementEntry({
          whaleId,
          marketId,
          outcome,
          lotId: lots[lots.length - 1].lotId,
          openTs: trade.ts,
          closeTs: null,
          qty: trade.size,
          entryPrice: trade.price,
          exitPriceOrSettlement: null,
          realizedPnl: 0,
          feeUsd: trade.feeUsd / 2, // Split fees between open/close
          method,
          isEstimatedFee: trade.isFeeEstimated,
        });
      } else {
        // SELL: close lots using FIFO or AVG
        let remainingToClose = trade.size;

        if (method === 'FIFO') {
          while (remainingToClose > 0 && lots.length > 0) {
            const lot = lots[0];
            const closeQty = Math.min(remainingToClose, lot.qty);
            const realizedPnl = closeQty * (trade.price - lot.entryPrice);

            this.db.insertSettlementEntry({
              whaleId,
              marketId,
              outcome,
              lotId: lot.lotId,
              openTs: lot.openTs,
              closeTs: trade.ts,
              qty: closeQty,
              entryPrice: lot.entryPrice,
              exitPriceOrSettlement: trade.price,
              realizedPnl,
              feeUsd: (trade.feeUsd * closeQty) / trade.size,
              method: 'FIFO',
              isEstimatedFee: trade.isFeeEstimated,
            });

            lot.qty -= closeQty;
            remainingToClose -= closeQty;
            if (lot.qty <= 0.0001) lots.shift();
          }
        } else {
          // AVG method
          if (lots.length > 0) {
            const totalQty = lots.reduce((s, l) => s + l.qty, 0);
            const avgPrice = lots.reduce((s, l) => s + l.entryPrice * l.qty, 0) / totalQty;
            const closeQty = Math.min(remainingToClose, totalQty);
            const realizedPnl = closeQty * (trade.price - avgPrice);

            this.db.insertSettlementEntry({
              whaleId,
              marketId,
              outcome,
              lotId: `avg-${whaleId}-${marketId}`,
              openTs: lots[0].openTs,
              closeTs: trade.ts,
              qty: closeQty,
              entryPrice: avgPrice,
              exitPriceOrSettlement: trade.price,
              realizedPnl,
              feeUsd: (trade.feeUsd * closeQty) / trade.size,
              method: 'AVG',
              isEstimatedFee: trade.isFeeEstimated,
            });

            // Reduce lot quantities proportionally
            const factor = 1 - (closeQty / totalQty);
            for (const lot of lots) lot.qty *= factor;
            // Remove empty lots
            while (lots.length > 0 && lots[0].qty < 0.0001) lots.shift();
          }
        }
      }
    }

    // Remaining open lots have unrealised P&L — positions table handles that
    for (const lot of lots) {
      this.db.upsertPosition({
        whaleId,
        marketId: trades[0].marketId,
        outcome: trades[0].outcome,
        netShares: lot.qty,
        avgEntryPrice: lot.entryPrice,
        costBasis: lot.qty * lot.entryPrice,
        unrealizedPnl: 0, // Will be updated by mark-to-market
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /* ━━━━━━━━━━━━━━ Daily Metrics Aggregation ━━━━━━━━━━━━━━ */

  computeDailyMetrics(whaleId: number): void {
    const allTrades = this.getAllTradesSorted(whaleId);
    if (allTrades.length === 0) return;

    // Group trades by date
    const byDate = new Map<string, WhaleTrade[]>();
    for (const t of allTrades) {
      const date = t.ts.slice(0, 10); // YYYY-MM-DD
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(t);
    }

    const settlementEntries = this.db.getSettlementEntries(whaleId);

    for (const [date, trades] of byDate) {
      const volumeUsd = trades.reduce((s, t) => s + t.notionalUsd, 0);
      const tradesCount = trades.length;

      // Realized PnL for this date from settlement ledger
      const dateEntries = settlementEntries.filter(
        (e) => e.closeTs && e.closeTs.slice(0, 10) === date,
      );
      const realizedPnl = dateEntries.reduce((s, e) => s + e.realizedPnl, 0);
      const wins = dateEntries.filter((e) => e.realizedPnl > 0).length;
      const totalClosed = dateEntries.length;
      const winRate = totalClosed > 0 ? wins / totalClosed : 0;

      // Average slippage
      const slippageTrades = trades.filter((t) => t.slippageBps !== null);
      const avgSlippageBps = slippageTrades.length > 0
        ? slippageTrades.reduce((s, t) => s + Math.abs(t.slippageBps!), 0) / slippageTrades.length
        : 0;

      // Average hold time (rough: from settlement entries with both open & close)
      const holdMinutes = dateEntries
        .filter((e) => e.closeTs)
        .map((e) => (new Date(e.closeTs!).getTime() - new Date(e.openTs).getTime()) / 60_000);
      const avgHoldMinutes = holdMinutes.length > 0
        ? holdMinutes.reduce((s, m) => s + m, 0) / holdMinutes.length
        : 0;

      const metrics: WhaleMetricsDaily = {
        whaleId,
        date,
        realizedPnl,
        unrealizedPnl: 0,
        volumeUsd,
        tradesCount,
        winRate,
        avgSlippageBps,
        avgHoldMinutes,
        timingScore: 0,
        consistencyScore: 0,
        marketSelectionScore: 0,
        score: 0,
        scoreConfidence: 0,
        scoreVersion: this.config.scoreVersion,
      };

      this.db.upsertDailyMetrics(metrics);
    }
  }

  /* ━━━━━━━━━━━━━━ Timing Analysis ━━━━━━━━━━━━━━ */

  computeTimingAnalysis(whaleId: number): TimingWindow[] {
    const windows = this.config.timingWindows;
    const results: TimingWindow[] = [];

    // NOTE: True timing analysis requires price-history from CLOB.
    // For now we compute from available orderbook snapshots stored in trades.
    const allTrades = this.getAllTradesSorted(whaleId);
    if (allTrades.length < 5) {
      return windows.map((w) => ({
        windowMinutes: w,
        favorableMovesPct: 0,
        avgMoveSize: 0,
        sampleSize: 0,
      }));
    }

    for (const windowMinutes of windows) {
      // For each trade, check if a subsequent trade in the same market within the window
      // shows the price moved favorably
      let favorableMoves = 0;
      let totalMoveSizeBps = 0;
      let sampleSize = 0;

      for (let i = 0; i < allTrades.length; i++) {
        const trade = allTrades[i];
        const windowEnd = new Date(trade.ts).getTime() + windowMinutes * 60_000;

        // Find trades in same market within window
        const laterTrades = allTrades.filter(
          (t) =>
            t.marketId === trade.marketId &&
            new Date(t.ts).getTime() > new Date(trade.ts).getTime() &&
            new Date(t.ts).getTime() <= windowEnd,
        );

        if (laterTrades.length === 0) continue;
        sampleSize++;

        // Use the last trade in window as reference price
        const refPrice = laterTrades[laterTrades.length - 1].price;
        const moveBps = ((refPrice - trade.price) / trade.price) * 10_000;

        const favorable = trade.side === 'BUY' ? moveBps > 0 : moveBps < 0;
        if (favorable) favorableMoves++;
        totalMoveSizeBps += Math.abs(moveBps);
      }

      results.push({
        windowMinutes,
        favorableMovesPct: sampleSize > 0 ? favorableMoves / sampleSize : 0,
        avgMoveSize: sampleSize > 0 ? totalMoveSizeBps / sampleSize : 0,
        sampleSize,
      });
    }

    return results;
  }

  /* ━━━━━━━━━━━━━━ Score Computation (0-100) ━━━━━━━━━━━━━━ */

  computeScore(whaleId: number): WhaleScoreBreakdown {
    const tradeCount = this.db.getWhaleTradeCount(whaleId);
    const provisional = tradeCount < this.config.provisionalMinTrades;

    const winRate = this.db.getWinRate(whaleId);
    const totalVolume = this.db.getWhaleVolume(whaleId);
    const settledPnl = this.db.getSettledPnl(whaleId);
    const timingWindows = this.computeTimingAnalysis(whaleId);

    // 1) Profitability (0-100): win rate + ROI
    const roi = totalVolume > 0 ? settledPnl / totalVolume : 0;
    const profitability = Math.min(100, Math.max(0,
      (winRate * 60) + (Math.min(roi, 0.5) / 0.5 * 40),
    ));

    // 2) Timing skill (0-100): avg favorable move pct across all windows
    const avgTimingPct = timingWindows.length > 0
      ? timingWindows.reduce((s, w) => s + w.favorableMovesPct, 0) / timingWindows.length
      : 0;
    const timingSkill = Math.min(100, Math.max(0, avgTimingPct * 100));

    // 3) Low slippage (0-100): inverted average slippage
    const allTrades = this.getAllTradesSorted(whaleId);
    const slippageTrades = allTrades.filter((t) => t.slippageBps !== null);
    const avgSlippage = slippageTrades.length > 0
      ? slippageTrades.reduce((s, t) => s + Math.abs(t.slippageBps!), 0) / slippageTrades.length
      : 50; // default "average" if no data
    const lowSlippage = Math.min(100, Math.max(0, 100 - avgSlippage));

    // 4) Consistency (0-100): Sharpe-like ratio of daily returns
    const dailyMetrics = this.db.getDailyMetrics(whaleId);
    const dailyReturns = dailyMetrics.map((m) => m.realizedPnl);
    const consistency = this.computeConsistencyScore(dailyReturns);

    // 5) Market selection quality (0-100): diversity + win rate per market
    const distinctMarkets = this.db.getWhaleDistinctMarkets(whaleId);
    const marketQuality = Math.min(100, Math.max(0,
      Math.min(distinctMarkets, 20) / 20 * 50 + winRate * 50,
    ));

    // 6) Recency / activeness (0-100): recent trade frequency
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recentCount = this.db.getWhaleTradeCount(whaleId, thirtyDaysAgo);
    const recency = Math.min(100, Math.max(0, Math.min(recentCount, 100) / 100 * 100));

    // Weighted sum
    const w = this.config.scoreWeights;
    let overall =
      profitability * w.profitability +
      timingSkill * w.timingSkill +
      lowSlippage * w.lowSlippage +
      consistency * w.consistency +
      marketQuality * w.marketSelectionQuality +
      recency * w.recencyActiveness;

    // Data integrity modifier
    const whale = this.db.getWhale(whaleId);
    let dataIntegrityModifier = 1.0;
    if (whale?.dataIntegrity === 'BACKFILLING') dataIntegrityModifier = 0.7;
    else if (whale?.dataIntegrity === 'DEGRADED') dataIntegrityModifier = 0.85;
    overall *= dataIntegrityModifier;

    // Provisional cap
    if (provisional) overall = Math.min(overall, this.config.provisionalMaxScore);

    // Confidence: based on sample size
    const confidence = Math.min(1, tradeCount / (this.config.provisionalMinTrades * 3));

    const breakdown: WhaleScoreBreakdown = {
      overall: Math.round(overall * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      provisional,
      components: {
        profitability: Math.round(profitability * 100) / 100,
        timingSkill: Math.round(timingSkill * 100) / 100,
        lowSlippage: Math.round(lowSlippage * 100) / 100,
        consistency: Math.round(consistency * 100) / 100,
        marketSelectionQuality: Math.round(marketQuality * 100) / 100,
        recencyActiveness: Math.round(recency * 100) / 100,
      },
      weights: w,
      sampleSize: tradeCount,
      dataIntegrityModifier,
      computedAt: new Date().toISOString(),
      version: this.config.scoreVersion,
    };

    return breakdown;
  }

  private computeConsistencyScore(dailyReturns: number[]): number {
    if (dailyReturns.length < 3) return 0;
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return mean > 0 ? 100 : 0;
    const sharpe = mean / stdDev;
    // Map sharpe to 0-100 scale: sharpe of 2+ = 100
    return Math.min(100, Math.max(0, (sharpe + 0.5) / 2.5 * 100));
  }

  /* ━━━━━━━━━━━━━━ Style Classification ━━━━━━━━━━━━━━ */

  classifyStyle(whaleId: number): WhaleStyle {
    const dailyMetrics = this.db.getDailyMetrics(whaleId);
    if (dailyMetrics.length < 3) return 'UNKNOWN';

    const avgHold = dailyMetrics.reduce((s, m) => s + m.avgHoldMinutes, 0) / dailyMetrics.length;
    const avgVolume = dailyMetrics.reduce((s, m) => s + m.volumeUsd, 0) / dailyMetrics.length;
    const avgTrades = dailyMetrics.reduce((s, m) => s + m.tradesCount, 0) / dailyMetrics.length;

    // Scalper: many trades, short hold times
    if (avgHold < 30 && avgTrades > 10) return 'SCALPER';

    // Accumulator: few large trades, long hold
    if (avgHold > 1440 && avgTrades < 5 && avgVolume > 5000) return 'ACCUMULATOR';

    // Contrarian: positive PnL with many sells (hard to determine without more data)
    const winRate = this.db.getWinRate(whaleId);
    const netPnl = this.db.getSettledPnl(whaleId);
    if (winRate < 0.45 && netPnl > 0) return 'CONTRARIAN';

    // Momentum: wins on trending markets, short-medium holds
    if (avgHold >= 30 && avgHold <= 1440 && winRate > 0.5) return 'MOMENTUM';

    return 'UNKNOWN';
  }

  /* ━━━━━━━━━━━━━━ Mark-to-Market (update unrealized PnL) ━━━━━━━━━━━━━━ */

  markToMarket(whaleId: number, currentPrices: Map<string, number>): void {
    const positions = this.db.getPositions(whaleId);
    for (const pos of positions) {
      const key = `${pos.marketId}:${pos.outcome}`;
      const currentPrice = currentPrices.get(key);
      if (currentPrice !== undefined) {
        const unrealizedPnl = pos.netShares * (currentPrice - pos.avgEntryPrice);
        this.db.upsertPosition({
          ...pos,
          unrealizedPnl,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Equity curve ━━━━━━━━━━━━━━ */

  getEquityCurve(whaleId: number): { date: string; pnl: number }[] {
    const metrics = this.db.getDailyMetrics(whaleId);
    let cumulative = 0;
    return metrics.map((m) => {
      cumulative += m.realizedPnl;
      return { date: m.date, pnl: Math.round(cumulative * 100) / 100 };
    });
  }

  /* ━━━━━━━━━━━━━━ Helpers ━━━━━━━━━━━━━━ */

  private getAllTradesSorted(whaleId: number): WhaleTrade[] {
    // Fetch all trades (paginate via large limit) — DB returns DESC, we need ASC
    const trades = this.db.getWhaleTrades(whaleId, { limit: 100_000 });
    return trades.reverse();
  }
}
