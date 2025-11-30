import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';
import { AdditionalFileInfo } from '../context/types';

/**
 * Tracked file entry with visible ranges and timestamp
 */
interface TrackedFile {
  uri: vscode.Uri;
  visibleRanges: vscode.Range[];
  lastViewedAt: number;
}

const MAX_FILE_AGE_MS = 60000; // 60 seconds - files viewed longer ago are pruned
const MAX_TRACKED_FILES = 20;
const MAX_LINE_LENGTH = 512; // Truncate lines longer than this

/**
 * Tracks recently viewed files and their visible ranges.
 * Used to provide additional context to CPP requests.
 */
export class RecentFilesTracker implements vscode.Disposable {
  private readonly trackedFiles = new Map<string, TrackedFile>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: ILogger) {
    // Track when editors become visible
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        this.updateFromVisibleEditors(editors);
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        this.updateVisibleRanges(event.textEditor.document.uri, event.visibleRanges);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.trackedFiles.delete(doc.uri.toString());
      })
    );

    // Initialize with current visible editors
    this.updateFromVisibleEditors(vscode.window.visibleTextEditors);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.trackedFiles.clear();
  }

  /**
   * Update tracking from visible editors
   */
  private updateFromVisibleEditors(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      if (this.isTrackableDocument(editor.document)) {
        this.updateVisibleRanges(editor.document.uri, editor.visibleRanges);
      }
    }
  }

  /**
   * Update visible ranges for a document
   */
  private updateVisibleRanges(uri: vscode.Uri, ranges: readonly vscode.Range[]): void {
    const key = uri.toString();
    this.trackedFiles.set(key, {
      uri,
      visibleRanges: [...ranges],
      lastViewedAt: Date.now(),
    });

    // Prune if we have too many tracked files
    if (this.trackedFiles.size > MAX_TRACKED_FILES) {
      this.pruneOldestFiles();
    }
  }

  /**
   * Check if a document should be tracked
   */
  private isTrackableDocument(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file';
  }

  /**
   * Remove the oldest tracked files to stay under the limit
   */
  private pruneOldestFiles(): void {
    const entries = [...this.trackedFiles.entries()].sort(
      (a, b) => a[1].lastViewedAt - b[1].lastViewedAt
    );

    const toRemove = entries.slice(0, entries.length - MAX_TRACKED_FILES);
    for (const [key] of toRemove) {
      this.trackedFiles.delete(key);
    }
  }

  /**
   * Get additional files context for a CPP request.
   * Excludes the current file being edited.
   *
   * @param currentUri - The URI of the current file (to exclude)
   * @param fetchContent - Whether to fetch the actual content of visible ranges
   */
  async getAdditionalFilesContext(
    currentUri: vscode.Uri,
    fetchContent = true
  ): Promise<AdditionalFileInfo[]> {
    const result: AdditionalFileInfo[] = [];
    const now = Date.now();
    const currentKey = currentUri.toString();
    const currentRelative = vscode.workspace.asRelativePath(currentUri, false);

    // Log current state for debugging
    this.logger.info(`[RecentFiles] getAdditionalFilesContext: currentFile=${currentRelative}, visibleEditors=${vscode.window.visibleTextEditors.length}, trackedFiles=${this.trackedFiles.size}`);

    // First, add currently visible editors (they're open)
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (!this.isTrackableDocument(doc)) continue;
      if (doc.uri.toString() === currentKey) continue;

      const relativePath = vscode.workspace.asRelativePath(doc.uri, false);
      if (relativePath === currentRelative) continue;

      const info = await this.buildFileInfo(
        doc.uri,
        editor.visibleRanges,
        true, // isOpen
        undefined, // lastViewedAt not needed for open files
        fetchContent ? doc : undefined
      );
      if (info) {
        this.logger.info(`[RecentFiles] Added visible editor: ${relativePath}, ranges=${editor.visibleRanges.length}`);
        result.push(info);
      }
    }

    // Then add recently viewed files that aren't currently visible
    const visibleUris = new Set(
      vscode.window.visibleTextEditors.map((e) => e.document.uri.toString())
    );

    const toRemove: string[] = [];

    for (const [key, tracked] of this.trackedFiles.entries()) {
      // Skip current file and visible files
      if (key === currentKey || visibleUris.has(key)) continue;

      // Skip files that are too old
      if (now - tracked.lastViewedAt > MAX_FILE_AGE_MS) {
        toRemove.push(key);
        continue;
      }

      const relativePath = vscode.workspace.asRelativePath(tracked.uri, false);
      if (relativePath === currentRelative) continue;

      // Skip if already added
      if (result.some((r) => r.relativeWorkspacePath === relativePath)) continue;

      let doc: vscode.TextDocument | undefined;
      if (fetchContent) {
        try {
          doc = await vscode.workspace.openTextDocument(tracked.uri);
        } catch {
          // File may have been deleted
          toRemove.push(key);
          continue;
        }
      }

      const info = await this.buildFileInfo(
        tracked.uri,
        tracked.visibleRanges,
        false, // not open
        tracked.lastViewedAt,
        doc
      );
      if (info) {
        result.push(info);
      }
    }

    // Clean up old entries
    for (const key of toRemove) {
      this.trackedFiles.delete(key);
    }

    // Sort by open status (open first) then by recency
    result.sort((a, b) => {
      if (a.isOpen !== b.isOpen) {
        return a.isOpen ? -1 : 1;
      }
      const aTime = a.lastViewedAt ?? Date.now();
      const bTime = b.lastViewedAt ?? Date.now();
      return bTime - aTime; // More recent first
    });

    this.logger.info(`[RecentFiles] Found ${result.length} additional files for context`);
    return result;
  }

  /**
   * Build AdditionalFileInfo for a file
   */
  private async buildFileInfo(
    uri: vscode.Uri,
    ranges: readonly vscode.Range[],
    isOpen: boolean,
    lastViewedAt: number | undefined,
    doc: vscode.TextDocument | undefined
  ): Promise<AdditionalFileInfo | null> {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    if (!relativePath) return null;

    const visibleRangeContent: string[] = [];
    const startLineNumbers: number[] = [];
    const visibleRanges: AdditionalFileInfo['visibleRanges'] = [];

    for (const range of ranges) {
      visibleRanges.push({
        startLineNumber: range.start.line + 1, // 1-indexed
        endLineNumberInclusive: range.end.line + 1,
      });

      startLineNumbers.push(range.start.line + 1);

      if (doc) {
        const content = this.getContentForRange(doc, range);
        visibleRangeContent.push(content);
      } else {
        visibleRangeContent.push('');
      }
    }

    return {
      relativeWorkspacePath: relativePath,
      visibleRangeContent,
      startLineNumberOneIndexed: startLineNumbers,
      visibleRanges,
      isOpen,
      lastViewedAt,
    };
  }

  /**
   * Get content for a visible range, truncating long lines
   */
  private getContentForRange(doc: vscode.TextDocument, range: vscode.Range): string {
    const lines: string[] = [];
    for (let line = range.start.line; line <= range.end.line && line < doc.lineCount; line++) {
      let text = doc.lineAt(line).text;
      if (text.length > MAX_LINE_LENGTH) {
        text = text.substring(0, MAX_LINE_LENGTH) + '...';
      }
      lines.push(text);
    }
    return lines.join('\n');
  }
}
