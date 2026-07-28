export const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';
const MAX_DEPTH = 32;

const SENSITIVE_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'secret',
  'clientsecret',
  'webhooksecret',
  'password',
  'passwd',
  'credential',
  'credentials',
  'privatekey',
  'databaseurl',
  'dsn',
  'authheader',
  'openaiapikey',
  'githubtoken',
  'githubappprivatekey',
]);

interface CredentialPattern {
  kind: SecretFindingKind;
  expression: RegExp;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    kind: 'github_token',
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: 'jwt',
    expression: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: 'bearer_token',
    expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    kind: 'private_key',
    expression:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{64,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

export type SecretFindingKind =
  | 'registered_secret'
  | 'github_token'
  | 'jwt'
  | 'bearer_token'
  | 'private_key';

export interface SecretFinding {
  path: string;
  kind: SecretFindingKind;
}

export interface SecretScannerOptions {
  secrets?: readonly string[];
}

export interface SensitiveDataRedactorOptions {
  secrets?: readonly string[];
}

function normalizedName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function isSensitiveFieldName(name: string): boolean {
  const normalized = normalizedName(name);
  if (SENSITIVE_NAMES.has(normalized)) return true;
  return /(?:token|secret|password|passwd|credential|privatekey|apikey)$/.test(normalized);
}

function normalizedSecrets(secrets: readonly string[] | undefined): string[] {
  if (secrets === undefined) return [];
  const result = [...new Set(secrets.filter((secret) => secret.length >= 8 && secret.length <= 20_000))];
  return result.sort((left, right) => right.length - left.length);
}

function safePathSegment(key: string, secrets: readonly string[]): string {
  if (
    /^[A-Za-z0-9_.-]{1,64}$/.test(key) &&
    !secrets.some((secret) => key.includes(secret))
  ) {
    return key;
  }
  return '<redacted-key>';
}

function credentialPatterns(): CredentialPattern[] {
  return CREDENTIAL_PATTERNS.map((pattern) => ({
    kind: pattern.kind,
    expression: new RegExp(pattern.expression.source, pattern.expression.flags),
  }));
}

export class SecretScanner {
  private readonly secrets: readonly string[];

  constructor(options: SecretScannerOptions = {}) {
    this.secrets = normalizedSecrets(options.secrets);
  }

  scan(value: unknown, rootPath = '$'): SecretFinding[] {
    const findings: SecretFinding[] = [];
    this.walk(value, rootPath, findings, new WeakSet<object>(), 0);
    const unique = new Map(findings.map((finding) => [`${finding.kind}:${finding.path}`, finding]));
    return [...unique.values()];
  }

  scanText(text: string, path = '$'): SecretFinding[] {
    const findings: SecretFinding[] = [];
    if (this.secrets.some((secret) => text.includes(secret))) {
      findings.push({ path, kind: 'registered_secret' });
    }
    for (const pattern of credentialPatterns()) {
      if (pattern.expression.test(text)) findings.push({ path, kind: pattern.kind });
    }
    return findings;
  }

  assertNoSecrets(value: unknown, rootPath = '$'): void {
    const findings = this.scan(value, rootPath);
    if (findings.length === 0) return;
    const paths = [...new Set(findings.map((finding) => finding.path))].slice(0, 10);
    throw new Error(
      `Secret scan failed with ${findings.length} finding(s) at ${paths.join(', ')}`,
    );
  }

  private walk(
    value: unknown,
    path: string,
    findings: SecretFinding[],
    seen: WeakSet<object>,
    depth: number,
  ): void {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === 'string') {
      findings.push(...this.scanText(value, path));
      return;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      typeof value === 'symbol' ||
      typeof value === 'function'
    ) {
      return;
    }
    if (value instanceof ArrayBuffer) {
      this.walk(new TextDecoder().decode(value), path, findings, seen, depth + 1);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.walk(new TextDecoder().decode(bytes), path, findings, seen, depth + 1);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        this.walk(entry, `${path}[${index}]`, findings, seen, depth + 1);
      }
      return;
    }
    if (value instanceof Error) {
      this.walk(value.message, `${path}.message`, findings, seen, depth + 1);
      this.walk(value.stack, `${path}.stack`, findings, seen, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const childPath = `${path}.${safePathSegment(key, this.secrets)}`;
      this.walk(key, `${childPath}.<key>`, findings, seen, depth + 1);
      this.walk(entry, childPath, findings, seen, depth + 1);
    }
  }
}

export class SensitiveDataRedactor {
  private readonly secrets: readonly string[];

  constructor(options: SensitiveDataRedactorOptions = {}) {
    this.secrets = normalizedSecrets(options.secrets);
  }

  redactText(text: string): string {
    let output = text;
    for (const secret of this.secrets) output = output.replaceAll(secret, REDACTED);
    for (const pattern of credentialPatterns()) {
      output = output.replace(pattern.expression, REDACTED);
    }
    output = output.replace(
      /((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      `$1${REDACTED}`,
    );
    return output;
  }

  redactUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return this.redactText(raw);
    }
    if (url.username !== '') url.username = REDACTED;
    if (url.password !== '') url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED);
    url.hash = '';
    return this.redactText(url.toString());
  }

  redactHeaders(
    headers: Headers | Record<string, string | readonly string[] | undefined>,
  ): Record<string, string | string[]> {
    const entries: Array<[string, string | readonly string[]]> = [];
    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) entries.push([key, value]);
    } else {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) entries.push([key, value]);
      }
    }
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of entries) {
      if (isSensitiveFieldName(key)) {
        result[key] = REDACTED;
      } else if (Array.isArray(value)) {
        result[key] = value.map((entry) => this.redactText(entry));
      } else {
        result[key] = this.redactText(value as string);
      }
    }
    return result;
  }

  redactEnvironment(
    environment: Record<string, string | undefined>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) continue;
      if (isSensitiveFieldName(key)) {
        result[key] = REDACTED;
      } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
        result[key] = this.redactUrl(value);
      } else {
        result[key] = this.redactText(value);
      }
    }
    return result;
  }

  redactJson(value: unknown): unknown {
    return this.redactValue(value, undefined, new WeakSet<object>(), 0);
  }

  private redactValue(
    value: unknown,
    fieldName: string | undefined,
    seen: WeakSet<object>,
    depth: number,
  ): unknown {
    if (fieldName !== undefined && isSensitiveFieldName(fieldName)) return REDACTED;
    if (depth > MAX_DEPTH) return REDACTED;
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
        ? this.redactUrl(value)
        : this.redactText(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol' || typeof value === 'function') return REDACTED;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return '[BINARY]';
    if (typeof value !== 'object') return REDACTED;
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactValue(entry, undefined, seen, depth + 1));
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactText(value.message),
      };
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = this.redactValue(entry, key, seen, depth + 1);
    }
    return result;
  }
}
