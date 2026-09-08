import { WalletState } from '../types';

export class Database {
  private wallets: WalletState[] = [];

  async connect(): Promise<void> {
    return;
  }

  async saveWallets(wallets: WalletState[]): Promise<void> {
    this.wallets = wallets.map((wallet) => ({ ...wallet }));
  }

  async loadWallets(): Promise<WalletState[]> {
    return this.wallets.map((wallet) => ({ ...wallet }));
  }
}
