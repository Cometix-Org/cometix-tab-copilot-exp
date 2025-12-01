// ==================== Endpoint Selection Mode ====================
/**
 * Endpoint selection modes:
 * - 'official': Use official Cursor endpoints with manual region selection
 * - 'auto': Automatically select best endpoint via CppConfig response
 * - 'custom': Use a custom user-provided endpoint URL
 */
export type EndpointMode = 'official' | 'auto' | 'custom';

// ==================== Official Region ====================
/**
 * Available regions for official Cursor endpoints
 * Based on analysis of cursor source code
 */
export type OfficialRegion = 'default' | 'us' | 'eu' | 'asia';

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

// ==================== Utility Functions ====================
export function getEndpointUrl(baseUrl: string, endpoint: EndpointKey): string {
  const path = ENDPOINT_MAPPINGS[endpoint];
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}
