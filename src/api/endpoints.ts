// ==================== Endpoint Selection Mode ====================
/**
 * Endpoint selection modes:
 * - 'official': Use official Cursor endpoints with manual region selection
 * - 'auto': Automatically select best endpoint via CppConfig response
 * - 'custom': Use a custom user-provided endpoint URL
 */
export type EndpointMode = 'official' | 'auto' | 'custom';

// ==================== Official Region Endpoints ====================
/**
 * Available regions for official Cursor endpoints
 * Based on analysis of cursor source code
 */
export type OfficialRegion = 'default' | 'us' | 'eu' | 'asia';

/**
 * Official Cursor endpoint URLs
 * 
 * - api2: Main API endpoint (HTTP/1.1) - Connect RPC requests, file sync
 * - api4: Default GeoCpp endpoint (HTTP/2) - CppConfig fallback
 * - gcpp: Geographic CPP endpoints (HTTP/2) - code completion streaming
 */
export const OFFICIAL_ENDPOINTS = {
  /** Main API - HTTP/1.1, Connect RPC requests, file sync */
  api2: 'https://api2.cursor.sh',
  
  /** Default GeoCpp - HTTP/2, CppConfig endpoint */
  api4: 'https://api4.cursor.sh',
  
  /** Geographic CPP endpoints - regional code completion */
  gcpp: {
    /** Default - uses api4.cursor.sh */
    default: 'https://api4.cursor.sh',
    /** United States */
    us: 'https://us.gcpp.cursor.sh',
    /** Europe */
    eu: 'https://eu.gcpp.cursor.sh',
    /** Asia Pacific */
    asia: 'https://asia.gcpp.cursor.sh',
  },
} as const;

/**
 * Region display names for UI
 */
export const REGION_DISPLAY_NAMES: Record<OfficialRegion, string> = {
  default: 'Default (api4.cursor.sh)',
  us: 'United States (us.gcpp.cursor.sh)',
  eu: 'Europe (eu.gcpp.cursor.sh)',
  asia: 'Asia Pacific (asia.gcpp.cursor.sh)',
};

// ==================== API Path Mappings ====================
// Only includes endpoints that are actually used in the codebase
const sharedMappings = {
  streamCpp: '/aiserver.v1.AiService/StreamCpp',
  cppConfig: '/aiserver.v1.AiService/CppConfig', 
  refreshTabContext: '/aiserver.v1.AiService/RefreshTabContext',
  streamNextCursorPrediction: '/aiserver.v1.AiService/StreamNextCursorPrediction',
  uploadFile: '/filesync.v1.FileSyncService/FSUploadFile',
  syncFile: '/filesync.v1.FileSyncService/FSSyncFile',
};

export const ENDPOINT_MAPPINGS = sharedMappings;

export type EndpointKey = keyof typeof ENDPOINT_MAPPINGS;

// ==================== Default Values ====================
/** Default base URL for backward compatibility */
export const DEFAULT_BASE_URL = OFFICIAL_ENDPOINTS.api2;

/** Default GeoCpp URL (used for code completion streaming) */
export const DEFAULT_GEOCPP_URL = OFFICIAL_ENDPOINTS.api4;

/** Default CppConfig URL (used for fetching configuration including auto-selected endpoint) */
export const DEFAULT_CPP_CONFIG_URL = OFFICIAL_ENDPOINTS.api4;

// ==================== Utility Functions ====================
export function getEndpointUrl(baseUrl: string, endpoint: EndpointKey): string {
  const path = ENDPOINT_MAPPINGS[endpoint];
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Get the GeoCpp endpoint URL for a specific region
 */
export function getRegionEndpoint(region: OfficialRegion): string {
  return OFFICIAL_ENDPOINTS.gcpp[region];
}

/**
 * Check if a URL is an official Cursor endpoint
 */
export function isOfficialEndpoint(url: string): boolean {
  return url.includes('cursor.sh');
}

/**
 * Check if a URL should use HTTP/2
 * api2 uses HTTP/1.1, others (api3, api4, gcpp) use HTTP/2
 */
export function shouldUseHttp2(url: string): boolean {
  if (!isOfficialEndpoint(url)) {
    return false;
  }
  return !url.includes('api2.cursor.sh');
}

/**
 * Normalize endpoint URL to api2 format (for certain requests that require HTTP/1.1)
 */
export function normalizeToApi2(url: string): string {
  if (!isOfficialEndpoint(url)) {
    return url;
  }
  return url
    .replace('api3.cursor.sh', 'api2.cursor.sh')
    .replace('api4.cursor.sh', 'api2.cursor.sh')
    .replace(/^https:\/\/.*\.gcpp\.cursor\.sh/, 'https://api2.cursor.sh');
}

/**
 * Detect region from a gcpp URL
 */
export function detectRegionFromUrl(url: string): OfficialRegion | null {
  if (url.includes('us.gcpp.cursor.sh')) {return 'us';}
  if (url.includes('eu.gcpp.cursor.sh')) {return 'eu';}
  if (url.includes('asia.gcpp.cursor.sh')) {return 'asia';}
  if (url.includes('api4.cursor.sh')) {return 'default';}
  return null;
}
