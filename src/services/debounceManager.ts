import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ILogger } from '../context/contracts';

function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Request tracking entry for debouncing
 * NOTE: Cursor does NOT store AbortController in entries - it's returned but not tracked here
 */
interface RequestEntry {
  requestId: string;
  startTime: number;
}

/**
 * Result from running a new request
 */
export interface RunRequestResult {
  generationUUID: string;
  startTime: number;
  abortController: AbortController;
  requestIdsToCancel: string[];
}

/**
 * Debounce manager that EXACTLY mirrors Cursor's debouncing behavior.
 * 
 * Cursor's Z$s class behavior:
 * - this.b = clientDebounceDuration (default: 25ms)
 * - this.c = totalDebounceDuration (default: 60ms) 
 * - this.d = maxRequestAge (for pruning old entries)
 * - this.a = request entries array
 * 
 * Key difference from previous implementation:
 * - runRequest does NOT enforce max concurrent streams (that's handled separately)
 * - runRequest does NOT abort streams - it only tracks timing
 * - requestIdsToCancel = requests within totalDebounceDuration window
 */
export class DebounceManager implements vscode.Disposable {
  private requests: RequestEntry[] = [];  // Cursor's this.a
  private clientDebounceDuration = 25;    // Cursor's this.b - debounce window for shouldDebounce
  private totalDebounceDuration = 60;     // Cursor's this.c - window for requestIdsToCancel
  private maxRequestAge = 10000;          // Cursor's this.d - prune requests older than this

  constructor(private readonly logger: ILogger) {}

  dispose(): void {
    this.requests = [];
  }

  /**
   * Configure debounce durations - matches Cursor's setDebouncingDurations
   */
  setDebounceDurations(options: {
    clientDebounceDuration?: number;
    totalDebounceDuration?: number;
  }): void {
    if (options.clientDebounceDuration !== undefined) {
      this.clientDebounceDuration = options.clientDebounceDuration;
    }
    if (options.totalDebounceDuration !== undefined) {
      this.totalDebounceDuration = options.totalDebounceDuration;
    }
  }

  /**
   * Remove old requests that are past the max age.
   * Cursor iterates in reverse and splices - we use simpler filter.
   */
  private pruneOldRequests(): void {
    const now = performance.now() + performance.timeOrigin;
    // Cursor: for (const [t, s] of [...this.a.entries()].reverse()) 
    //           if (now - s.startTime > this.d) this.a.splice(t, 1);
    this.requests = this.requests.filter(
      (entry) => now - entry.startTime <= this.maxRequestAge
    );
  }

  /**
   * Create a new request entry and return info needed to run it.
   * Also returns IDs of requests that should be cancelled.
   * 
   * EXACTLY matches Cursor's runRequest logic:
   * ```javascript
   * runRequest() {
   *   this.pruneOldRequests();
   *   const now = performance.now() + performance.timeOrigin;
   *   const uuid = Ft();  // generateUuid
   *   const idsToCancel = this.a.filter(n => n.startTime + this.c > now).map(n => n.requestId);
   *   this.a.push({ requestId: uuid, startTime: now });
   *   const abortController = new AbortController();
   *   return { generationUUID: uuid, startTime: now, abortController, requestIdsToCancel: idsToCancel };
   * }
   * ```
   * 
   * NOTE: Cursor does NOT enforce max concurrent streams here - that's handled separately.
   * NOTE: Cursor does NOT store AbortController in entries - just returns it.
   */
  runRequest(): RunRequestResult {
    this.pruneOldRequests();

    const now = performance.now() + performance.timeOrigin;
    const generationUUID = generateUuid();
    const abortController = new AbortController();

    // Find requests within totalDebounceDuration window to cancel
    // Cursor: this.a.filter(n => n.startTime + this.c > now).map(n => n.requestId)
    const requestIdsToCancel = this.requests
      .filter((entry) => entry.startTime + this.totalDebounceDuration > now)
      .map((entry) => entry.requestId);

    // Add new request (Cursor doesn't store AbortController in entries)
    this.requests.push({
      requestId: generationUUID,
      startTime: now,
    });

    if (requestIdsToCancel.length > 0) {
      this.logger.info(
        `[Debounce] New request ${generationUUID.slice(0, 8)}, marking ${requestIdsToCancel.length} pending requests for cancellation`
      );
    }

    return {
      generationUUID,
      startTime: now,
      abortController,
      requestIdsToCancel,
    };
  }

  /**
   * Check if a request should be debounced (skipped).
   * This is called after running a request to see if it was superseded.
   * 
   * @param requestId - The request ID to check
   * @param isRetry - Whether this is a retry after waiting
   * @returns true if the request should be skipped, false if it should proceed
   */
  async shouldDebounce(requestId: string, isRetry = false): Promise<boolean> {
    const entries = [...this.requests];
    
    // Find the index of this request
    let index = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].requestId === requestId) {
        index = i;
      }
    }

    // If request not found, don't debounce
    if (index === -1) {
      return false;
    }

    const now = performance.now() + performance.timeOrigin;
    const entry = entries[index];
    const elapsed = now - entry.startTime;

    // If we haven't waited long enough and this isn't a retry, wait and check again
    if (elapsed < this.clientDebounceDuration && !isRetry) {
      const waitTime = this.clientDebounceDuration - elapsed;
      this.logger.info(
        `[Debounce] Request ${requestId.slice(0, 8)} waiting ${Math.round(waitTime)}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.shouldDebounce(requestId, true);
    }

    // If this is the newest request, don't debounce
    if (index === entries.length - 1) {
      return false;
    }

    // Check if a newer request came in within the debounce window
    const nextEntry = entries[index + 1];
    const shouldDebounce = nextEntry.startTime - entry.startTime < this.clientDebounceDuration;

    if (shouldDebounce) {
      this.logger.info(
        `[Debounce] Skipping request ${requestId.slice(0, 8)} - superseded by ${nextEntry.requestId.slice(0, 8)}`
      );
    }

    return shouldDebounce;
  }

  /**
   * Remove a request from tracking (e.g., when cancelled or completed)
   */
  removeRequest(requestId: string): void {
    this.requests = this.requests.filter((entry) => entry.requestId !== requestId);
  }

  /**
   * Remove a specific request by ID (for cleanup)
   * NOTE: Cursor doesn't have abortRequest - AbortControllers are managed externally
   */
  forgetRequest(requestId: string): void {
    this.removeRequest(requestId);
  }

  /**
   * Clear all tracked requests (for cleanup/reset)
   * NOTE: Cursor doesn't have abortAll - AbortControllers are managed externally
   */
  clear(): void {
    const count = this.requests.length;
    this.requests = [];
    if (count > 0) {
      this.logger.info(`[Debounce] Cleared ${count} tracked requests`);
    }
  }

  /**
   * Get the current number of tracked requests
   */
  getRequestCount(): number {
    return this.requests.length;
  }
}
