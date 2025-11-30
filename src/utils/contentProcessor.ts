import { createHash } from 'crypto';

/**
 * Content truncation radius - Cursor keeps 300 lines before and after cursor
 */
const CONTENT_TRUNCATION_RADIUS = 300;

/**
 * Truncation result containing processed content and metadata
 */
export interface TruncationResult {
  /** The truncated content */
  contents: string;
  /** The line number where truncated content starts (0-indexed) */
  contentsStartAtLine: number;
  /** Whether the content was truncated */
  wasTruncated: boolean;
}

/**
 * Truncate file content to keep only lines around the cursor position.
 * Matches Cursor's lc() function behavior:
 * - If file has < 600 lines (CPe * 2), return full content
 * - Otherwise, keep 300 lines before and 300 lines after cursor
 * - Adjust window if cursor is near the start or end of file
 * 
 * @param content Full file content
 * @param cursorLine 0-indexed line number of cursor position
 * @param lineEnding Line ending character(s) used in the file
 * @returns Truncation result with processed content and metadata
 */
export function truncateContentAroundCursor(
  content: string,
  cursorLine: number,
  lineEnding: string = '\n'
): TruncationResult {
  const lines = content.split(lineEnding);
  
  // If file is small enough, no truncation needed
  if (lines.length < CONTENT_TRUNCATION_RADIUS * 2) {
    return {
      contents: content,
      contentsStartAtLine: 0,
      wasTruncated: false,
    };
  }

  // Calculate initial window
  let startLine = Math.max(0, cursorLine - CONTENT_TRUNCATION_RADIUS);
  let endLine = Math.min(lines.length, cursorLine + CONTENT_TRUNCATION_RADIUS);

  // Adjust window if cursor is near the start
  const extraAtStart = CONTENT_TRUNCATION_RADIUS - cursorLine;
  if (extraAtStart > 0) {
    endLine = Math.min(lines.length, endLine + extraAtStart);
  }

  // Adjust window if cursor is near the end
  const extraAtEnd = cursorLine - (lines.length - CONTENT_TRUNCATION_RADIUS);
  if (extraAtEnd > 0) {
    startLine = Math.max(0, startLine - extraAtEnd);
  }

  // Build truncated content by emptying lines outside the window
  // Note: Cursor empties lines rather than removing them to preserve line numbers
  const truncatedLines = lines.map((line, index) => {
    if (index < startLine || index >= endLine) {
      return '';
    }
    return line;
  });

  return {
    contents: truncatedLines.join(lineEnding),
    contentsStartAtLine: startLine,
    wasTruncated: true,
  };
}

/**
 * Calculate SHA256 hash of content
 * @param content Content to hash
 * @returns Hex-encoded SHA256 hash
 */
export function calculateSHA256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Determine if SHA256 hash should be calculated based on configuration
 * Matches Cursor's rc() function behavior:
 * - Always calculate if relyOnFileSync is true
 * - Otherwise calculate based on checkFilesyncHashPercent probability
 * 
 * @param relyOnFileSync Whether relying on file sync
 * @param checkFilesyncHashPercent Percentage (0-1) of requests to hash
 * @returns Whether to calculate hash
 */
export function shouldCalculateHash(
  relyOnFileSync: boolean,
  checkFilesyncHashPercent: number = 0
): boolean {
  if (relyOnFileSync) {
    return true;
  }
  return Math.random() < checkFilesyncHashPercent;
}

/**
 * Generate a stable workspace ID based on workspace path
 * Format matches Cursor's getWorkspaceId() output
 * 
 * @param seed Optional seed for deterministic generation (workspace path)
 * @returns 22-character base62 workspace ID
 */
export function generateWorkspaceId(seed?: string): string {
  const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  
  let randomSource: string;
  if (seed) {
    // Use hash of seed for deterministic generation
    randomSource = calculateSHA256(seed);
  } else {
    // Generate random hex string
    randomSource = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }

  // Convert hex to base62
  let result = '';
  let num = BigInt('0x' + randomSource.slice(0, 32));
  const base = BigInt(62);

  for (let i = 0; i < 22; i++) {
    const remainder = Number(num % base);
    result = BASE62_CHARS[remainder] + result;
    num = num / base;
  }

  return result;
}

/**
 * Generate random ID suffix like Cursor does
 * Format: random alphanumeric string
 */
export function generateRandomIdSuffix(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}
