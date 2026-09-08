"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const risk_engine_1 = require("../src/risk/risk_engine");
const kill_switch_1 = require("../src/risk/kill_switch");
const walletState = {
    walletId: 'wallet_1',
    mode: 'PAPER',
    assignedStrategy: 'momentum',
    capitalAllocated: 1000,
    availableBalance: 1000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
        maxPositionSize: 100,
        maxExposurePerMarket: 200,
        maxDailyLoss: 50,
        maxOpenTrades: 5,
        maxDrawdown: 0.2,
    },
};
const order = {
    walletId: 'wallet_1',
    marketId: 'POLY-EXAMPLE',
    outcome: 'YES',
    side: 'BUY',
    price: 0.5,
    size: 10,
    strategy: 'momentum',
};
(0, vitest_1.describe)('RiskEngine', () => {
    (0, vitest_1.it)('approves orders within limits', () => {
        const engine = new risk_engine_1.RiskEngine(new kill_switch_1.KillSwitch());
        const result = engine.check(order, walletState);
        (0, vitest_1.expect)(result.ok).toBe(true);
    });
    (0, vitest_1.it)('rejects when kill switch active', () => {
        const killSwitch = new kill_switch_1.KillSwitch();
        killSwitch.activate();
        const engine = new risk_engine_1.RiskEngine(killSwitch);
        const result = engine.check(order, walletState);
        (0, vitest_1.expect)(result.ok).toBe(false);
    });
});
