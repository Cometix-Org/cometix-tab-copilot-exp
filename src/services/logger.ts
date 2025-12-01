import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';

export enum LogLevel {
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/**
 * Unified logger for the extension. All components should use this single channel.
 */
export class Logger implements vscode.Disposable, ILogger {
  private static instance: Logger | undefined;
  private readonly channel: vscode.OutputChannel;

  constructor() {
    // Reuse existing channel if singleton already exists
    if (Logger.instance) {
      this.channel = Logger.instance.channel;
    } else {
      this.channel = vscode.window.createOutputChannel('Cometix Tab', { log: true });
      Logger.instance = this;
    }
  }

  /**
   * Get the singleton Logger instance. Creates one if it doesn't exist.
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Get the shared output channel for direct access by other components
   */
  getChannel(): vscode.OutputChannel {
    return this.channel;
  }

  /**
   * Static method to get the shared channel (creates Logger if needed)
   */
  static getSharedChannel(): vscode.OutputChannel {
    return Logger.getInstance().channel;
  }

  info(message: string): void {
    this.write(LogLevel.Info, message);
  }

  warn(message: string): void {
    this.write(LogLevel.Warn, message);
  }

  error(message: string, err?: unknown): void {
    const suffix = err instanceof Error ? ` :: ${err.stack ?? err.message}` : err ? ` :: ${String(err)}` : '';
    this.write(LogLevel.Error, message + suffix);
  }

  private write(level: LogLevel, text: string): void {
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level}] ${text}`);
  }

  /**
   * Show the output channel
   */
  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
    Logger.instance = undefined;
  }
}
