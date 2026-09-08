import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { WhaleDB } from '../src/whales/whale_db';
import { WhaleAnalytics } from '../src/whales/whale_analytics';
import { DEFAULT_WHALE_CONFIG, type WhaleTrade } from '../src/whales/whale_types';

const TEST_DB_PATH = path.join(__dirname, '.test_whale_analytics.db');

let db: WhaleDB;
let analytics: WhaleAnalytics;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new WhaleDB(TEST_DB_PATH);
  analytics = new WhaleAnalytics(db, { ...DEFAULT_WHALE_CONFIG });
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SETTLEMENT LEDGER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Settlement Ledger', () => {
  it('builds FIFO settlement entries for buy-then-sell', () => {
    const whale = db.addWhale('0xfifo');

    // Buy 100 at 0.50, then sell 100 at 0.70
    db.insertTrade(makeTrade(whale.id, 'buy1', 'BUY', 0.50, 100, '2025-01-01T10:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'sell1', 'SELL', 0.70, 100, '2025-01-02T10:00:00Z'));

    analytics.buildSettlementLedger(whale.id);

    const entries = db.getSettlementEntries(whale.id);
    // Should have 2 entries: one open, one close
    const closedEntries = entries.filter(e => e.closeTs !== null);
    expect(closedEntries.length).toBeGreaterThanOrEqual(1);

    const totalPnl = closedEntries.reduce((s, e) => s + e.realizedPnl, 0);
    // PnL = 100 * (0.70 - 0.50) = 20
    expect(totalPnl).toBeCloseTo(20, 1);
  });

  it('handles partial closes with FIFO correctly', () => {
    const whale = db.addWhale('0xpartial');

    // Buy 200 at 0.40, sell 100 at 0.60, then sell 100 at 0.80
    db.insertTrade(makeTrade(whale.id, 'b1', 'BUY', 0.40, 200, '2025-01-01T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's1', 'SELL', 0.60, 100, '2025-01-02T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's2', 'SELL', 0.80, 100, '2025-01-03T00:00:00Z'));

    analytics.buildSettlementLedger(whale.id);

    const entries = db.getSettlementEntries(whale.id);
    const closed = entries.filter(e => e.closeTs !== null);
    const totalPnl = closed.reduce((s, e) => s + e.realizedPnl, 0);

    // First close: 100 * (0.60 - 0.40) = 20
    // Second close: 100 * (0.80 - 0.40) = 40
    // Total = 60
    expect(totalPnl).toBeCloseTo(60, 1);
  });

  it('handles multiple lots with FIFO (first lot closed first)', () => {
    const whale = db.addWhale('0xmultilot');

    // Buy 50 at 0.30, Buy 50 at 0.50, Sell 80
    db.insertTrade(makeTrade(whale.id, 'b1', 'BUY', 0.30, 50, '2025-01-01T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'b2', 'BUY', 0.50, 50, '2025-01-02T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's1', 'SELL', 0.70, 80, '2025-01-03T00:00:00Z'));

    analytics.buildSettlementLedger(whale.id);

    const closed = db.getSettlementEntries(whale.id).filter(e => e.closeTs !== null);
    // First 50 closed at entry=0.30: PnL = 50*(0.70-0.30) = 20
    // Next 30 closed at entry=0.50: PnL = 30*(0.70-0.50) = 6
    // Total = 26
    const totalPnl = closed.reduce((s, e) => s + e.realizedPnl, 0);
    expect(totalPnl).toBeCloseTo(26, 1);
  });

  it('builds AVG settlement entries', () => {
    const whale = db.addWhale('0xavg');
    const avgAnalytics = new WhaleAnalytics(db, {
      ...DEFAULT_WHALE_CONFIG,
      costBasisMethod: 'AVG',
    });

    // Buy 100 at 0.40, Buy 100 at 0.60 => avg = 0.50
    // Sell 100 at 0.80
    db.insertTrade(makeTrade(whale.id, 'b1', 'BUY', 0.40, 100, '2025-01-01T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'b2', 'BUY', 0.60, 100, '2025-01-02T00:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's1', 'SELL', 0.80, 100, '2025-01-03T00:00:00Z'));

    avgAnalytics.buildSettlementLedger(whale.id);

    const closed = db.getSettlementEntries(whale.id).filter(e => e.closeTs !== null);
    // AVG price = 0.50, close at 0.80 for 100 shares
    // PnL = 100 * (0.80 - 0.50) = 30
    const totalPnl = closed.reduce((s, e) => s + e.realizedPnl, 0);
    expect(totalPnl).toBeCloseTo(30, 1);
    expect(closed[0].method).toBe('AVG');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DAILY METRICS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Daily Metrics', () => {
  it('computes daily metrics from trades', () => {
    const whale = db.addWhale('0xdaily');

    // Day 1: Buy 100 at 0.50
    db.insertTrade(makeTrade(whale.id, 'b1', 'BUY', 0.50, 100, '2025-01-10T10:00:00Z'));
    // Day 2: Sell 100 at 0.70 (profit) + Buy 50 at 0.60
    db.insertTrade(makeTrade(whale.id, 's1', 'SELL', 0.70, 100, '2025-01-11T10:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'b2', 'BUY', 0.60, 50, '2025-01-11T14:00:00Z'));

    analytics.buildSettlementLedger(whale.id);
    analytics.computeDailyMetrics(whale.id);

    const metrics = db.getDailyMetrics(whale.id);
    expect(metrics.length).toBeGreaterThanOrEqual(1);

    // Day 1 should have 1 trade, Day 2 should have 2 trades
    const day1 = metrics.find(m => m.date === '2025-01-10');
    const day2 = metrics.find(m => m.date === '2025-01-11');
    expect(day1?.tradesCount).toBe(1);
    expect(day2?.tradesCount).toBe(2);
  });

  it('sums volume correctly per day', () => {
    const whale = db.addWhale('0xvolume');
    // Two trades on same day with different notionals
    db.insertTrade(makeTrade(whale.id, 't1', 'BUY', 0.50, 100, '2025-01-15T08:00:00Z', 'MKT-1', 50));
    db.insertTrade(makeTrade(whale.id, 't2', 'BUY', 0.60, 200, '2025-01-15T12:00:00Z', 'MKT-2', 120));

    analytics.computeDailyMetrics(whale.id);

    const metrics = db.getDailyMetrics(whale.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].volumeUsd).toBe(170); // 50 + 120
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SCORE COMPUTATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Scoring', () => {
  it('returns provisional score with low trade count', () => {
    const whale = db.addWhale('0xprov');
    // Insert only 5 trades (below provisional threshold of 30)
    for (let i = 0; i < 5; i++) {
      db.insertTrade(makeTrade(whale.id, `t${i}`, 'BUY', 0.50, 10, `2025-01-0${i + 1}T00:00:00Z`));
    }
    const score = analytics.computeScore(whale.id);
    expect(score.provisional).toBe(true);
    expect(score.overall).toBeLessThanOrEqual(DEFAULT_WHALE_CONFIG.provisionalMaxScore);
    expect(score.sampleSize).toBe(5);
    expect(score.confidence).toBeLessThan(1);
  });

  it('returns non-provisional score with sufficient trades', () => {
    const whale = db.addWhale('0xfull');
    // Insert 35 trades
    for (let i = 0; i < 35; i++) {
      db.insertTrade(makeTrade(whale.id, `t${i}`, 'BUY', 0.50, 10, `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
    }
    const score = analytics.computeScore(whale.id);
    expect(score.provisional).toBe(false);
    expect(score.sampleSize).toBe(35);
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);
  });

  it('applies data integrity modifier for BACKFILLING whales', () => {
    const whale = db.addWhale('0xbf');
    db.updateWhale(whale.id, { dataIntegrity: 'BACKFILLING' });

    for (let i = 0; i < 35; i++) {
      db.insertTrade(makeTrade(whale.id, `t${i}`, 'BUY', 0.50, 10, `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
    }

    const score = analytics.computeScore(whale.id);
    expect(score.dataIntegrityModifier).toBe(0.7);
  });

  it('score breakdown components are all between 0-100', () => {
    const whale = db.addWhale('0xcomponents');
    for (let i = 0; i < 40; i++) {
      const side = i % 3 === 0 ? 'SELL' : 'BUY';
      db.insertTrade(makeTrade(whale.id, `t${i}`, side as 'BUY' | 'SELL', 0.40 + (i % 5) * 0.05, 10 + i, `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
    }
    // Build settlement and daily metrics so score components work
    analytics.buildSettlementLedger(whale.id);
    analytics.computeDailyMetrics(whale.id);

    const score = analytics.computeScore(whale.id);
    const c = score.components;
    expect(c.profitability).toBeGreaterThanOrEqual(0);
    expect(c.profitability).toBeLessThanOrEqual(100);
    expect(c.timingSkill).toBeGreaterThanOrEqual(0);
    expect(c.timingSkill).toBeLessThanOrEqual(100);
    expect(c.lowSlippage).toBeGreaterThanOrEqual(0);
    expect(c.lowSlippage).toBeLessThanOrEqual(100);
    expect(c.consistency).toBeGreaterThanOrEqual(0);
    expect(c.consistency).toBeLessThanOrEqual(100);
    expect(c.marketSelectionQuality).toBeGreaterThanOrEqual(0);
    expect(c.marketSelectionQuality).toBeLessThanOrEqual(100);
    expect(c.recencyActiveness).toBeGreaterThanOrEqual(0);
    expect(c.recencyActiveness).toBeLessThanOrEqual(100);
  });

  it('weights sum to 1.0', () => {
    const w = DEFAULT_WHALE_CONFIG.scoreWeights;
    const sum = w.profitability + w.timingSkill + w.lowSlippage + w.consistency + w.marketSelectionQuality + w.recencyActiveness;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   STYLE CLASSIFICATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Style Classification', () => {
  it('returns UNKNOWN with insufficient data', () => {
    const whale = db.addWhale('0xunknown');
    expect(analytics.classifyStyle(whale.id)).toBe('UNKNOWN');
  });

  it('classifies scalper: many trades, short hold', () => {
    const whale = db.addWhale('0xscalper');
    // Insert daily metrics showing many trades and short hold times
    for (let d = 1; d <= 5; d++) {
      db.upsertDailyMetrics({
        whaleId: whale.id,
        date: `2025-01-${String(d).padStart(2, '0')}`,
        realizedPnl: 5,
        unrealizedPnl: 0,
        volumeUsd: 10000,
        tradesCount: 20, // many trades
        winRate: 0.55,
        avgSlippageBps: 5,
        avgHoldMinutes: 15, // short hold
        timingScore: 0,
        consistencyScore: 0,
        marketSelectionScore: 0,
        score: 0,
        scoreConfidence: 0,
        scoreVersion: '1.0.0',
      });
    }
    expect(analytics.classifyStyle(whale.id)).toBe('SCALPER');
  });

  it('classifies accumulator: few large trades, long hold', () => {
    const whale = db.addWhale('0xaccum');
    for (let d = 1; d <= 5; d++) {
      db.upsertDailyMetrics({
        whaleId: whale.id,
        date: `2025-01-${String(d).padStart(2, '0')}`,
        realizedPnl: 50,
        unrealizedPnl: 0,
        volumeUsd: 20000, // large volume
        tradesCount: 3,    // few trades
        winRate: 0.6,
        avgSlippageBps: 10,
        avgHoldMinutes: 2880, // 2 days
        timingScore: 0,
        consistencyScore: 0,
        marketSelectionScore: 0,
        score: 0,
        scoreConfidence: 0,
        scoreVersion: '1.0.0',
      });
    }
    expect(analytics.classifyStyle(whale.id)).toBe('ACCUMULATOR');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TIMING ANALYSIS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Timing Analysis', () => {
  it('returns empty windows for whale with few trades', () => {
    const whale = db.addWhale('0xtiming_empty');
    db.insertTrade(makeTrade(whale.id, 't1', 'BUY', 0.50, 10, '2025-01-01T00:00:00Z'));
    const windows = analytics.computeTimingAnalysis(whale.id);
    expect(windows).toHaveLength(DEFAULT_WHALE_CONFIG.timingWindows.length);
    expect(windows.every(w => w.sampleSize === 0)).toBe(true);
  });

  it('computes timing windows for trades in same market', () => {
    const whale = db.addWhale('0xtiming');
    const market = 'MKT-TIMING';

    // Sequence: Buy at 0.50, price rises to 0.60 within 5 minutes
    db.insertTrade(makeTrade(whale.id, 't1', 'BUY', 0.50, 100, '2025-01-01T10:00:00Z', market));
    db.insertTrade(makeTrade(whale.id, 't2', 'BUY', 0.55, 50, '2025-01-01T10:02:00Z', market));
    db.insertTrade(makeTrade(whale.id, 't3', 'SELL', 0.60, 50, '2025-01-01T10:04:00Z', market));
    db.insertTrade(makeTrade(whale.id, 't4', 'BUY', 0.58, 30, '2025-01-01T10:06:00Z', market));
    db.insertTrade(makeTrade(whale.id, 't5', 'SELL', 0.65, 30, '2025-01-01T10:10:00Z', market));

    const windows = analytics.computeTimingAnalysis(whale.id);
    // The 5-min window should show some favorable moves
    const shortWindow = windows.find(w => w.windowMinutes === 5);
    expect(shortWindow).toBeDefined();
    expect(shortWindow!.sampleSize).toBeGreaterThan(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EQUITY CURVE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — Equity Curve', () => {
  it('computes cumulative equity curve', () => {
    const whale = db.addWhale('0xequity');
    const dailyPnls = [10, -5, 20, 15, -8];
    for (let i = 0; i < dailyPnls.length; i++) {
      db.upsertDailyMetrics({
        whaleId: whale.id,
        date: `2025-01-${String(i + 10).padStart(2, '0')}`,
        realizedPnl: dailyPnls[i],
        unrealizedPnl: 0,
        volumeUsd: 100,
        tradesCount: 1,
        winRate: 0.5,
        avgSlippageBps: 0,
        avgHoldMinutes: 60,
        timingScore: 0,
        consistencyScore: 0,
        marketSelectionScore: 0,
        score: 0,
        scoreConfidence: 0,
        scoreVersion: '1.0.0',
      });
    }

    const curve = analytics.getEquityCurve(whale.id);
    expect(curve).toHaveLength(5);
    expect(curve[0].pnl).toBe(10);
    expect(curve[1].pnl).toBe(5);  // 10 + (-5)
    expect(curve[2].pnl).toBe(25); // 5 + 20
    expect(curve[3].pnl).toBe(40); // 25 + 15
    expect(curve[4].pnl).toBe(32); // 40 + (-8)
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   FULL computeAllMetrics INTEGRATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleAnalytics — computeAllMetrics', () => {
  it('runs full metrics pipeline without error', () => {
    const whale = db.addWhale('0xfull_pipeline');

    // Insert a realistic trade sequence
    db.insertTrade(makeTrade(whale.id, 'b1', 'BUY', 0.45, 200, '2025-01-01T08:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'b2', 'BUY', 0.50, 100, '2025-01-02T10:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's1', 'SELL', 0.65, 150, '2025-01-03T12:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 's2', 'SELL', 0.70, 100, '2025-01-04T09:00:00Z'));
    db.insertTrade(makeTrade(whale.id, 'b3', 'BUY', 0.55, 80, '2025-01-05T11:00:00Z'));

    // Should not throw
    expect(() => analytics.computeAllMetrics(whale.id)).not.toThrow();

    // Whale should have metrics now
    const metrics = db.getDailyMetrics(whale.id);
    expect(metrics.length).toBeGreaterThan(0);

    // Settlement entries should exist
    const entries = db.getSettlementEntries(whale.id);
    expect(entries.length).toBeGreaterThan(0);

    // Whale style should be updated
    const updatedWhale = db.getWhale(whale.id);
    expect(updatedWhale).toBeDefined();
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   HELPERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function makeTrade(
  whaleId: number,
  tradeId: string,
  side: 'BUY' | 'SELL',
  price: number,
  size: number,
  ts: string,
  marketId = 'MKT-DEFAULT',
  notionalUsd?: number,
): Omit<WhaleTrade, 'id'> {
  return {
    whaleId,
    tradeId,
    logicalTradeGroupId: null,
    marketId,
    outcome: 'YES',
    side,
    price,
    size,
    notionalUsd: notionalUsd ?? size * price,
    feeUsd: 0,
    isFeeEstimated: true,
    ts,
    midpointAtFill: null,
    bestBidAtFill: null,
    bestAskAtFill: null,
    slippageBps: null,
    aggressor: 'UNKNOWN',
  };
}
