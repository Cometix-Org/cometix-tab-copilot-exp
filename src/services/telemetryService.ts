import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';
import { TriggerSource } from '../context/types';

/**
 * Event types for CPP telemetry
 */
export enum CppEventType {
  Trigger = 'cpp_trigger',
  Suggestion = 'cpp_suggestion',
  Accept = 'cpp_accept',
  Reject = 'cpp_reject',
  PartialAccept = 'cpp_partial_accept',
  GenerationFinished = 'cpp_generation_finished',
  LspSuggestion = 'cpp_lsp_suggestion',
}

/**
 * Fate of a CPP suggestion
 */
export enum CppFate {
  Accept = 'accept',
  Reject = 'reject',
  PartialAccept = 'partial_accept',
  Timeout = 'timeout',
  Cancelled = 'cancelled',
}

/**
 * Base event interface
 */
interface CppEventBase {
  type: CppEventType;
  timestamp: number;
  requestId: string;
  documentUri?: string;
  documentVersion?: number;
}

/**
 * Trigger event data
 */
export interface CppTriggerEvent extends CppEventBase {
  type: CppEventType.Trigger;
  source: TriggerSource;
  cursorPosition: { line: number; column: number };
}

/**
 * Suggestion shown event data
 */
export interface CppSuggestionEvent extends CppEventBase {
  type: CppEventType.Suggestion;
  suggestionLength: number;
  lineCount: number;
}

/**
 * Accept event data
 */
export interface CppAcceptEvent extends CppEventBase {
  type: CppEventType.Accept;
  acceptedLength: number;
}

/**
 * Reject event data
 */
export interface CppRejectEvent extends CppEventBase {
  type: CppEventType.Reject;
  reason?: string;
}

/**
 * Partial accept event data
 */
export interface CppPartialAcceptEvent extends CppEventBase {
  type: CppEventType.PartialAccept;
  acceptedLength: number;
  kind: 'word' | 'line' | 'suggest' | 'unknown';
}

/**
 * Generation finished event data
 */
export interface CppGenerationFinishedEvent extends CppEventBase {
  type: CppEventType.GenerationFinished;
  durationMs: number;
  success: boolean;
}

/**
 * LSP suggestion event data
 */
export interface CppLspSuggestionEvent extends CppEventBase {
  type: CppEventType.LspSuggestion;
  suggestionCount: number;
  labels: string[];
}

type CppEvent =
  | CppTriggerEvent
  | CppSuggestionEvent
  | CppAcceptEvent
  | CppRejectEvent
  | CppPartialAcceptEvent
  | CppGenerationFinishedEvent
  | CppLspSuggestionEvent;

const MAX_EVENTS = 100;

/**
 * Telemetry service for tracking CPP events.
 * Events are logged locally and can be sent to the server.
 */
export class TelemetryService implements vscode.Disposable {
  private events: CppEvent[] = [];
  private requestStartTimes = new Map<string, number>();

  constructor(private readonly logger: ILogger) {}

  dispose(): void {
    this.events = [];
    this.requestStartTimes.clear();
  }

  /**
   * Record when a trigger starts (for duration tracking)
   */
  recordTriggerStart(requestId: string): void {
    this.requestStartTimes.set(requestId, performance.now());
  }

  /**
   * Record a CPP trigger event
   */
  recordTriggerEvent(
    document: vscode.TextDocument,
    requestId: string,
    position: vscode.Position,
    source: TriggerSource
  ): void {
    const event: CppTriggerEvent = {
      type: CppEventType.Trigger,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      source,
      cursorPosition: {
        line: position.line + 1, // 1-indexed
        column: position.character + 1,
      },
    };
    this.addEvent(event);
    this.logger.info(
      `[Telemetry] Trigger: ${source} at ${position.line + 1}:${position.character + 1}`
    );
  }

  /**
   * Record a suggestion shown event
   */
  recordSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    suggestionText: string
  ): void {
    const lineCount = suggestionText.split('\n').length;
    const event: CppSuggestionEvent = {
      type: CppEventType.Suggestion,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      suggestionLength: suggestionText.length,
      lineCount,
    };
    this.addEvent(event);
    this.logger.info(
      `[Telemetry] Suggestion shown: ${suggestionText.length} chars, ${lineCount} lines`
    );
  }

  /**
   * Record an accept event
   */
  recordAcceptEvent(document: vscode.TextDocument, requestId: string, acceptedLength: number): void {
    const event: CppAcceptEvent = {
      type: CppEventType.Accept,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      acceptedLength,
    };
    this.addEvent(event);
    this.logger.info(`[Telemetry] Accept: ${acceptedLength} chars`);
  }

  /**
   * Record a reject event
   */
  recordRejectEvent(document: vscode.TextDocument, requestId: string, reason?: string): void {
    const event: CppRejectEvent = {
      type: CppEventType.Reject,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      reason,
    };
    this.addEvent(event);
    this.logger.info(`[Telemetry] Reject${reason ? `: ${reason}` : ''}`);
  }

  /**
   * Record a partial accept event
   */
  recordPartialAcceptEvent(
    document: vscode.TextDocument,
    requestId: string,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown'
  ): void {
    const event: CppPartialAcceptEvent = {
      type: CppEventType.PartialAccept,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      acceptedLength,
      kind,
    };
    this.addEvent(event);
    this.logger.info(`[Telemetry] Partial accept: ${acceptedLength} chars, kind=${kind}`);
  }

  /**
   * Record generation finished event
   */
  recordGenerationFinished(requestId: string, success: boolean): void {
    const startTime = this.requestStartTimes.get(requestId);
    const durationMs = startTime ? performance.now() - startTime : 0;
    this.requestStartTimes.delete(requestId);

    const event: CppGenerationFinishedEvent = {
      type: CppEventType.GenerationFinished,
      timestamp: Date.now(),
      requestId,
      durationMs,
      success,
    };
    this.addEvent(event);
    this.logger.info(
      `[Telemetry] Generation ${success ? 'succeeded' : 'failed'} in ${Math.round(durationMs)}ms`
    );
  }

  /**
   * Record LSP suggestions available event
   */
  recordLspSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    labels: string[]
  ): void {
    const event: CppLspSuggestionEvent = {
      type: CppEventType.LspSuggestion,
      timestamp: Date.now(),
      requestId,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      suggestionCount: labels.length,
      labels: labels.slice(0, 10), // Keep only first 10
    };
    this.addEvent(event);
    this.logger.info(`[Telemetry] LSP suggestions: ${labels.length} items`);
  }

  /**
   * Get recent events for debugging
   */
  getRecentEvents(count = 20): CppEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get events for a specific request
   */
  getEventsForRequest(requestId: string): CppEvent[] {
    return this.events.filter((e) => e.requestId === requestId);
  }

  /**
   * Clear all events
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Add an event, keeping the list bounded
   */
  private addEvent(event: CppEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }
}
