import { Position } from '../types';

export class PositionManager {
  private readonly positions = new Map<string, Position[]>();

  getPositions(walletId: string): Position[] {
    return this.positions.get(walletId) ?? [];
  }

  setPositions(walletId: string, positions: Position[]): void {
    this.positions.set(walletId, positions);
  }
}
