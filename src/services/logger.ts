import * as vscode from 'vscode';

export enum LogLevel {
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Cursor Tab', { log: true });

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

  dispose(): void {
    this.channel.dispose();
  }
}
