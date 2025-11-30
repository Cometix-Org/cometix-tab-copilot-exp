import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ILogger } from '../context/contracts';

function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Request tracking entry for debouncing
 */
interface RequestEntry {
  requestId: string;
  startTime: number;
  abortController: AbortController;
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
 * Debounce manager that mirrors Cursor's debouncing behavior.
 * Prevents excessive requests by tracking request timing and cancelling
 * requests that are superseded by newer ones.
 * 
 * Key features matching Cursor:
 * - Max concurrent streams limit (default: 6)
 * - Client debounce duration (default: 25ms like Cursor)
 * - Total debounce duration (default: 60ms like Cursor)
 * - Automatic abortion of oldest streams when limit exceeded
 */
export class DebounceManager implements vscode.Disposable {
  private requests: RequestEntry[] = [];
  // Cursor defaults: ZJo = 25, eGo = 60
  private clientDebounceDuration = 25; // ms - debounce window for client (Cursor default)
  private totalDebounceDuration = 60; // ms - total debounce window (Cursor default)
  private maxRequestAge = 10000; // ms - prune requests older than this
  // Cursor's jc = 6
  private maxConcurrentStreams = 6; // Maximum concurrent streams allowed

  constructor(private readonly logger: ILogger) {}

  dispose(): void {
    this.requests = [];
  }

  /**
   * Configure debounce durations and max streams
   */
  setDebounceDurations(options: {
    clientDebounceDuration?: number;
    totalDebounceDuration?: number;
    maxConcurrentStreams?: number;
  }): void {
    if (options.clientDebounceDuration !== undefined) {
      this.clientDebounceDuration = options.clientDebounceDuration;
    }
    if (options.totalDebounceDuration !== undefined) {
      this.totalDebounceDuration = options.totalDebounceDuration;
    }
    if (options.maxConcurrentStreams !== undefined) {
      this.maxConcurrentStreams = options.maxConcurrentStreams;
    }
  }

  /**
   * Remove old requests that are past the max age
   */
  private pruneOldRequests(): void {
    const now = performance.now() + performance.timeOrigin;
    this.requests = this.requests.filter(
      (entry) => now - entry.startTime <= this.maxRequestAge
    );
  }

  /**
   * Create a new request entry and return info needed to run it.
   * Also returns IDs of requests that should be cancelled.
   * 
   * Implements Cursor's stream limiting logic:
   * - If too many concurrent streams, abort oldest ones
   * - Find requests within debounce window to cancel
   */
  runRequest(): RunRequestResult {
    this.pruneOldRequests();

    const now = performance.now() + performance.timeOrigin;
    const generationUUID = generateUuid();
    const abortController = new AbortController();

    // Enforce max concurrent streams limit (like Cursor's jc = 6)
    // Abort oldest streams when limit is exceeded
    const requestIdsToCancel: string[] = [];
    
    while (this.requests.length >= this.maxConcurrentStreams) {
      const oldest = this.requests.shift();
      if (oldest) {
        this.logger.info(
          `[Debounce] Too many streams (${this.requests.length + 1}/${this.maxConcurrentStreams}), aborting oldest: ${oldest.requestId.slice(0, 8)}`
        );
        oldest.abortController.abort();
        requestIdsToCancel.push(oldest.requestId);
      }
    }

    // Also cancel requests within the total debounce window
    for (const entry of this.requests) {
      if (entry.startTime + this.totalDebounceDuration > now) {
        if (!requestIdsToCancel.includes(entry.requestId)) {
          requestIdsToCancel.push(entry.requestId);
        }
      }
    }

    // Add new request with its abort controller
    this.requests.push({
      requestId: generationUUID,
      startTime: now,
      abortController,
    });

    this.logger.info(
      `[Debounce] New request ${generationUUID.slice(0, 8)}, cancelling ${requestIdsToCancel.length} pending requests`
    );

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
   * Abort a specific request by ID
   */
  abortRequest(requestId: string): void {
    const entry = this.requests.find((e) => e.requestId === requestId);
    if (entry) {
      entry.abortController.abort();
      this.removeRequest(requestId);
      this.logger.info(`[Debounce] Manually aborted request ${requestId.slice(0, 8)}`);
    }
  }

  /**
   * Abort all pending requests
   */
  abortAll(): void {
    for (const entry of this.requests) {
      entry.abortController.abort();
    }
    const count = this.requests.length;
    this.requests = [];
    this.logger.info(`[Debounce] Aborted all ${count} pending requests`);
  }

  /**
   * Get the current number of tracked requests
   */
  getRequestCount(): number {
    return this.requests.length;
  }
}
