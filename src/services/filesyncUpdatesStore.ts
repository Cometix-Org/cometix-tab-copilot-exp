import * as vscode from 'vscode';
import {
  FilesyncUpdateWithModelVersion,
  SingleUpdateRequest,
  SimpleRange,
} from '../rpc/cursor-tab_pb';

const MAX_QUEUE_LENGTH = 30;

function toSimpleRange(range: vscode.Range): SimpleRange {
  return new SimpleRange({
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumberInclusive: range.end.line + 1,
    endColumn: range.end.character + 1,
  });
}

function isWorkspaceFile(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file';
}

export class FilesyncUpdatesStore implements vscode.Disposable {
  private readonly updates = new Map<string, FilesyncUpdateWithModelVersion[]>();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (isWorkspaceFile(event.document)) {
        this.recordUpdate(event);
      }
    });
  }

  getUpdates(uri: vscode.Uri, minVersionExclusive: number): FilesyncUpdateWithModelVersion[] {
    const queue = this.updates.get(uri.toString()) ?? [];
    return queue.filter((entry) => entry.modelVersion > minVersionExclusive);
  }

  dropThrough(uri: vscode.Uri, version: number): void {
    const key = uri.toString();
    const queue = this.updates.get(key);
    if (!queue) {
      return;
    }
    const filtered = queue.filter((entry) => entry.modelVersion > version);
    if (filtered.length === 0) {
      this.updates.delete(key);
    } else {
      this.updates.set(key, filtered);
    }
  }

  dispose(): void {
    this.disposable.dispose();
    this.updates.clear();
  }

  private recordUpdate(event: vscode.TextDocumentChangeEvent): void {
    if (!event.contentChanges.length) {
      return;
    }
    const relativePath = vscode.workspace.asRelativePath(event.document.uri, false);
    const updates = event.contentChanges.map(
      (change) =>
        new SingleUpdateRequest({
          startPosition: change.rangeOffset,
          endPosition: change.rangeOffset + change.rangeLength,
          changeLength: change.rangeLength,
          replacedString: change.text,
          range: toSimpleRange(change.range),
        }),
    );

    const record = new FilesyncUpdateWithModelVersion({
      modelVersion: event.document.version,
      relativeWorkspacePath: relativePath,
      updates,
      expectedFileLength: event.document.getText().length,
    });

    const key = event.document.uri.toString();
    const queue = this.updates.get(key) ?? [];
    queue.push(record);
    while (queue.length > MAX_QUEUE_LENGTH) {
      queue.shift();
    }
    this.updates.set(key, queue);
  }
}

