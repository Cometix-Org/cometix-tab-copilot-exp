import * as vscode from 'vscode';
import { IDocumentTracker } from '../context/contracts';

interface DiffEntry {
  readonly timestamp: number;
  readonly change: string;
}

const MAX_HISTORY = 10;

export class DocumentTracker implements vscode.Disposable, IDocumentTracker {
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
      // For insertions/replacements, record the new text
      // For deletions (empty text), record a special marker to indicate deletion happened
      const diff = change.text ? change.text.slice(-256) : '';
      
      // Skip if no meaningful change (both old and new are empty/whitespace only)
      if (!diff && change.rangeLength === 0) {
        continue;
      }
      
      // Record the change - empty string for deletions is meaningful context
      entries.push({ timestamp: Date.now(), change: diff });
    }

    while (entries.length > MAX_HISTORY) {
      entries.shift();
    }

    this.history.set(key, entries);
  }
}
