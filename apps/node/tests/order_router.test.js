"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const order_router_1 = require("../src/execution/order_router");
const risk_engine_1 = require("../src/risk/risk_engine");
const kill_switch_1 = require("../src/risk/kill_switch");
const trade_executor_1 = require("../src/execution/trade_executor");
const wallet_manager_1 = require("../src/wallets/wallet_manager");
class StubWallet {
    constructor(state) {
        this.state = state;
        this.called = false;
    }
    getState() {
        return this.state;
    }
    getTradeHistory() {
        return [];
    }
    updateBalance() {
        return;
    }
    async placeOrder() {
        this.called = true;
    }
}
(0, vitest_1.describe)('OrderRouter', () => {
    (0, vitest_1.it)('routes orders that pass risk checks', async () => {
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
                maxDailyLoss: 100,
                maxOpenTrades: 5,
                maxDrawdown: 0.2,
            },
        };
        const manager = new wallet_manager_1.WalletManager();
        const stub = new StubWallet(walletState);
        manager.wallets.set(walletState.walletId, stub);
        const router = new order_router_1.OrderRouter(manager, new risk_engine_1.RiskEngine(new kill_switch_1.KillSwitch()), new trade_executor_1.TradeExecutor());
        const order = {
            walletId: walletState.walletId,
            marketId: 'POLY-EXAMPLE',
            outcome: 'YES',
            side: 'BUY',
            price: 0.5,
            size: 10,
            strategy: 'momentum',
        };
        await router.route(order);
        (0, vitest_1.expect)(stub.called).toBe(true);
    });
});
