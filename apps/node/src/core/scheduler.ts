import { logger } from '../reporting/logs';

export type TickHandler = () => Promise<void> | void;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private readonly intervalMs: number;

  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
  }

  start(handler: TickHandler): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        await handler();
      } catch (error) {
        logger.error({ error }, 'Scheduler tick failed');
      }
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('Scheduler stopped');
    }
  }
}
