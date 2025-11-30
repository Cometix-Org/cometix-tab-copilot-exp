import * as vscode from 'vscode';

/**
 * Memory-based snooze service - not persisted to configuration
 * Snooze state is lost when VS Code restarts (by design)
 */
export class SnoozeService implements vscode.Disposable {
  private static instance: SnoozeService | undefined;
  
  private snoozeUntil: number = 0;
  private readonly _onSnoozeChanged = new vscode.EventEmitter<boolean>();
  readonly onSnoozeChanged = this._onSnoozeChanged.event;
  
  private checkTimer?: NodeJS.Timeout;

  private constructor() {
    // Start periodic check for snooze expiration
    this.startExpirationCheck();
  }

  static getInstance(): SnoozeService {
    if (!SnoozeService.instance) {
      SnoozeService.instance = new SnoozeService();
    }
    return SnoozeService.instance;
  }

  /**
   * Check if currently snoozing
   */
  isSnoozing(): boolean {
    if (this.snoozeUntil === 0) {
      return false;
    }
    if (Date.now() >= this.snoozeUntil) {
      // Snooze expired
      this.snoozeUntil = 0;
      return false;
    }
    return true;
  }

  /**
   * Get remaining snooze time in minutes
   */
  getRemainingMinutes(): number {
    if (!this.isSnoozing()) {
      return 0;
    }
    return Math.ceil((this.snoozeUntil - Date.now()) / (60 * 1000));
  }

  /**
   * Snooze for specified minutes
   */
  snooze(minutes: number): void {
    this.snoozeUntil = Date.now() + (minutes * 60 * 1000);
    this._onSnoozeChanged.fire(true);
  }

  /**
   * Cancel snooze
   */
  cancelSnooze(): void {
    this.snoozeUntil = 0;
    this._onSnoozeChanged.fire(false);
  }

  /**
   * Get snooze end timestamp (0 if not snoozing)
   */
  getSnoozeUntil(): number {
    return this.isSnoozing() ? this.snoozeUntil : 0;
  }

  private startExpirationCheck(): void {
    // Check every 30 seconds if snooze has expired
    this.checkTimer = setInterval(() => {
      if (this.snoozeUntil > 0 && Date.now() >= this.snoozeUntil) {
        this.snoozeUntil = 0;
        this._onSnoozeChanged.fire(false);
      }
    }, 30000);
  }

  dispose(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    this._onSnoozeChanged.dispose();
    SnoozeService.instance = undefined;
  }
}
