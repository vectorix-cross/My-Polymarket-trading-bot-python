import { OrderRequest } from '../types';
import { ExecutionWallet } from '../wallets/wallet_manager';

export class TradeExecutor {
  async execute(order: OrderRequest, wallet: ExecutionWallet): Promise<void> {
    await wallet.placeOrder({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      price: order.price,
      size: order.size,
    });
  }
}
