const sharedMappings = {
    shouldTurnOnCppOnboarding: '/aiserver.v1.AiService/ShouldTurnOnCppOnboarding',
    streamCpp: '/aiserver.v1.AiService/StreamCpp',
    cppConfig: '/aiserver.v1.AiService/CppConfig', 
    cppEditHistoryStatus: '/aiserver.v1.AiService/CppEditHistoryStatus',
    cppAppend: '/aiserver.v1.AiService/CppAppend',
    refreshTabContext: '/aiserver.v1.AiService/RefreshTabContext',
    streamNextCursorPrediction: '/aiserver.v1.AiService/StreamNextCursorPrediction',
    isCursorPredictionEnabled: '/aiserver.v1.AiService/IsCursorPredictionEnabled',
    getCppEditClassification: '/aiserver.v1.AiService/GetCppEditClassification',
    cppEditHistoryAppend: '/aiserver.v1.AiService/CppEditHistoryAppend',
    availableModels: '/aiserver.v1.CppService/AvailableModels',
    markCppForEval: '/aiserver.v1.CppService/MarkCppForEval',
    streamHoldCpp: '/aiserver.v1.CppService/StreamHoldCpp',
    recordCppFate: '/aiserver.v1.CppService/RecordCppFate',
    addTabRequestToEval: '/aiserver.v1.CppService/AddTabRequestToEval',
    uploadFile: '/filesync.v1.FileSyncService/FSUploadFile',
    syncFile: '/filesync.v1.FileSyncService/FSSyncFile',
    fsIsEnabledForUser: '/filesync.v1.FileSyncService/FSIsEnabledForUser',
    fsConfig: '/filesync.v1.FileSyncService/FSConfig',
    fsGetFileContents: '/filesync.v1.FileSyncService/FSGetFileContents',
    fsGetMultiFileContents: '/filesync.v1.FileSyncService/FSGetMultiFileContents',
    cursorPredictionConfig: '/aiserver.v1.CursorPredictionService/CursorPredictionConfig'
  };

export const ENDPOINT_MAPPINGS = sharedMappings;

export type EndpointKey = keyof typeof ENDPOINT_MAPPINGS;

export const DEFAULT_BASE_URL = 'https://api2.cursor.sh';

export function getEndpointUrl(baseUrl: string, endpoint: EndpointKey): string {
  const path = ENDPOINT_MAPPINGS[endpoint];
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}
