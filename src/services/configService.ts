import * as vscode from 'vscode';
import { IConfigService } from '../context/contracts';
import { CursorFeatureFlags } from '../context/types';

export class ConfigService implements vscode.Disposable, IConfigService {
  private readonly emitter = new vscode.EventEmitter<CursorFeatureFlags>();
  readonly onDidChange = this.emitter.event;
  private current = this.readConfig();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cometixTab')) {
        this.current = this.readConfig();
        this.emitter.fire(this.current);
      }
    });
  }

  get flags(): CursorFeatureFlags {
    return this.current;
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }

  private readConfig(): CursorFeatureFlags {
    const cfg = vscode.workspace.getConfiguration('cometixTab');
    return {
      enableInlineSuggestions: cfg.get<boolean>('enableInlineSuggestions', true),
      enableCursorPrediction: cfg.get<boolean>('enableCursorPrediction', true),
      enableDiagnosticsHints: cfg.get<boolean>('enableDiagnosticsHints', false),
      excludedLanguages: cfg.get<string[]>('excludedLanguages', []),
    };
  }
}
