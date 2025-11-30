import * as vscode from 'vscode';
import { IConfigService } from '../context/contracts';
import { CursorFeatureFlags, DebugConfig } from '../context/types';

export class ConfigService implements vscode.Disposable, IConfigService {
  private readonly emitter = new vscode.EventEmitter<CursorFeatureFlags>();
  readonly onDidChange = this.emitter.event;
  private current = this.readConfig();
  private currentDebug = this.readDebugConfig();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cometixTab')) {
        this.current = this.readConfig();
        this.currentDebug = this.readDebugConfig();
        this.emitter.fire(this.current);
      }
    });
  }

  get flags(): CursorFeatureFlags {
    return this.current;
  }

  get debug(): DebugConfig {
    return this.currentDebug;
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
      // New flags for enhanced context
      enableAdditionalFilesContext: cfg.get<boolean>('enableAdditionalFilesContext', true),
      cppTriggerInComments: cfg.get<boolean>('cppTriggerInComments', true),
    };
  }

  private readDebugConfig(): DebugConfig {
    const cfg = vscode.workspace.getConfiguration('cometixTab.debug');
    return {
      enabled: cfg.get<boolean>('enabled', true),
      logStream: cfg.get<boolean>('logStream', true),
      logEditCombine: cfg.get<boolean>('logEditCombine', true),
      logFileSync: cfg.get<boolean>('logFileSync', true),
      logRpc: cfg.get<boolean>('logRpc', true),
      verbosePayloads: cfg.get<boolean>('verbosePayloads', false),
    };
  }
}
