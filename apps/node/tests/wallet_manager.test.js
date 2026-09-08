"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const wallet_manager_1 = require("../src/wallets/wallet_manager");
const walletConfig = {
    id: 'wallet_1',
    mode: 'PAPER',
    strategy: 'momentum',
    capital: 500,
};
(0, vitest_1.describe)('WalletManager', () => {
    (0, vitest_1.it)('registers paper wallets', () => {
        const manager = new wallet_manager_1.WalletManager();
        manager.registerWallet(walletConfig, walletConfig.strategy, false);
        const wallets = manager.listWallets();
        (0, vitest_1.expect)(wallets).toHaveLength(1);
        (0, vitest_1.expect)(wallets[0].mode).toBe('PAPER');
    });
    (0, vitest_1.it)('skips live wallets when not enabled', () => {
        const manager = new wallet_manager_1.WalletManager();
        manager.registerWallet({ ...walletConfig, id: 'live_1', mode: 'LIVE' }, walletConfig.strategy, false);
        (0, vitest_1.expect)(manager.listWallets()).toHaveLength(0);
    });
});
