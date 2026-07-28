const MAX_PROVIDER_STDERR_CHARS = 8_192;

export const PROVIDER_PROCESS_FAILURE_CODES = [
  'provider_authentication_failed',
  'provider_quota_exceeded',
  'provider_rate_limited',
  'provider_model_unavailable',
  'provider_endpoint_not_found',
  'provider_responses_incompatible',
  'provider_upstream_unavailable',
  'provider_timeout',
  'provider_stream_interrupted',
  'provider_network_failed',
  'provider_cli_contract_failed',
  'provider_process_failed',
] as const;

export type ProviderProcessFailureCode =
  typeof PROVIDER_PROCESS_FAILURE_CODES[number];

const AUTHENTICATION_FAILURE = /(?:\binvalid[_ -]?api[_ -]?key\b|\bauth(?:entication)?(?: error| failed| failure)\b|\bunauthorized\b|\bforbidden\b|\bpermission[_ -]?denied\b|(?:\bstatus(?: code)?\b|\bhttp(?:\/\d(?:\.\d)?)?\b)[^\d]{0,12}(?:401|403)\b)/i;
const QUOTA_FAILURE = /(?:\binsufficient[_ -]?quota\b|\bquota(?: has been)? (?:exceeded|exhausted)\b|\bbilling(?: hard)? limit\b|\bcredits?(?: are)? (?:exhausted|depleted)\b)/i;
const RATE_LIMIT_FAILURE = /(?:\brate[_ -]?limit(?:ed|ing)?\b|\btoo many requests\b|(?:\bstatus(?: code)?\b|\bhttp(?:\/\d(?:\.\d)?)?\b)?[^\d]{0,12}\b429\b)/i;
const MODEL_FAILURE = /(?:\bmodel\b[^\r\n]{0,160}\b(?:not found|does not exist|not supported|unsupported|unavailable|invalid)\b|\b(?:unknown|unsupported|invalid) model\b)/i;
const ENDPOINT_FAILURE = /(?:(?:\bstatus(?: code)?\b|\bhttp(?:\/\d(?:\.\d)?)?\b|\bresponse\b)[^\d]{0,12}(?:404|405|410)\b|\b404 not found\b|\b405 method not allowed\b|\b410 gone\b)/i;
const RESPONSES_FAILURE = /(?:\bresponses? api\b[^\r\n]{0,120}\b(?:unsupported|not supported|unavailable|invalid)\b|\buse (?:the )?chat completions?\b|\berror decoding response body\b|\bfailed to (?:decode|deserialize|parse) (?:the )?(?:response|response body)\b|\binvalid response body\b|\bunexpected content[- ]type\b|\bexpected value at line\b)/i;
const UPSTREAM_FAILURE = /(?:(?:\bstatus(?: code)?\b|\bhttp(?:\/\d(?:\.\d)?)?\b|\bresponse\b|\bupstream\b)[^\d]{0,12}(?:500|502|503|504|520|521|522|523|524)\b|\bbad gateway\b|\bservice unavailable\b|\bgateway timeout\b|\bupstream\b[^\r\n]{0,120}\b(?:failed|failure|error|unavailable)\b)/i;
const TIMEOUT_FAILURE = /\b(?:timed? out|timeout|deadline exceeded|operation expired)\b/i;
const STREAM_INTERRUPTION_FAILURE = /(?:\bstream disconnected before completion\b|\b(?:responses?\s+)?sse\s+stream\b[^\r\n]{0,160}\b(?:interrupted|disconnected|ended|closed)\b|\b(?:interrupted|disconnected|ended|closed)\b[^\r\n]{0,160}\b(?:responses?\s+)?sse\s+stream\b|\bstream\b[^\r\n]{0,80}\b(?:closed|ended)\b[^\r\n]{0,80}\bbefore (?:response[.]completed|completion)\b)/i;
const NETWORK_FAILURE = /(?:\bdns\b|\bname resolution\b|\bconnection (?:refused|reset|closed|error)\b|\bfailed to connect\b|\bnetwork is unreachable\b|\btls\b|\bssl\b|\bcertificate(?: verification)? failed\b|\bsocket error\b)/i;
const CLI_CONTRACT_FAILURE = /(?:\bunexpected argument\b|\bunrecognized option\b|\bunknown (?:configuration|config) key\b|\bfailed to (?:load|parse) config\b|\bconfiguration (?:error|invalid)\b|\binvalid value for (?:argument|option)\b)/i;

/**
 * Converts already-redacted, bounded CLI stderr into a fixed safe code.
 * Raw provider text is never returned or persisted by this classifier.
 */
export function classifyProviderProcessFailure(
  stderr: string | undefined,
): ProviderProcessFailureCode {
  const sample = stderr?.slice(0, MAX_PROVIDER_STDERR_CHARS) ?? '';
  if (AUTHENTICATION_FAILURE.test(sample)) return 'provider_authentication_failed';
  if (QUOTA_FAILURE.test(sample)) return 'provider_quota_exceeded';
  if (RATE_LIMIT_FAILURE.test(sample)) return 'provider_rate_limited';
  if (MODEL_FAILURE.test(sample)) return 'provider_model_unavailable';
  if (ENDPOINT_FAILURE.test(sample)) return 'provider_endpoint_not_found';
  if (RESPONSES_FAILURE.test(sample)) return 'provider_responses_incompatible';
  if (UPSTREAM_FAILURE.test(sample)) return 'provider_upstream_unavailable';
  if (TIMEOUT_FAILURE.test(sample)) return 'provider_timeout';
  if (STREAM_INTERRUPTION_FAILURE.test(sample)) return 'provider_stream_interrupted';
  if (NETWORK_FAILURE.test(sample)) return 'provider_network_failed';
  if (CLI_CONTRACT_FAILURE.test(sample)) return 'provider_cli_contract_failed';
  return 'provider_process_failed';
}
