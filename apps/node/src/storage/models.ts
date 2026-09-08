export interface WalletRecord {
  walletId: string;
  mode: 'LIVE' | 'PAPER';
  strategy: string;
  capitalAllocated: number;
}

export interface TradeRecord {
  orderId: string;
  walletId: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
}
