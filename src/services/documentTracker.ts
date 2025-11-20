import * as vscode from 'vscode';

interface DiffEntry {
  readonly timestamp: number;
  readonly change: string;
}

const MAX_HISTORY = 10;

export class DocumentTracker implements vscode.Disposable {
  private readonly history = new Map<string, DiffEntry[]>();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument((event) => this.recordChange(event));
  }

  getHistory(uri: vscode.Uri): string[] {
    return (this.history.get(uri.toString()) ?? []).map((entry) => entry.change);
  }

  clear(uri: vscode.Uri): void {
    this.history.delete(uri.toString());
  }

  dispose(): void {
    this.disposable.dispose();
    this.history.clear();
  }

  private recordChange(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    const entries = this.history.get(key) ?? [];

    for (const change of event.contentChanges) {
      const diff = change.text.slice(-256);
      if (!diff) {
        continue;
      }
      entries.push({ timestamp: Date.now(), change: diff });
    }

    while (entries.length > MAX_HISTORY) {
      entries.shift();
    }

    this.history.set(key, entries);
  }
}
