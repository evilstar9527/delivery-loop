import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  SecretScanner,
  SensitiveDataRedactor,
} from '../src/security/redaction.js';

const HEADER_SECRET = 'CANARY_HEADER_SECRET_123456';
const JSON_SECRET = 'CANARY_NESTED_JSON_SECRET_123456';
const URL_SECRET = 'CANARY_URL_QUERY_SECRET_123456';
const ENV_SECRET = 'CANARY_COMMAND_ENV_SECRET_123456';

describe('schema-aware sensitive data redaction', () => {
  it('redacts sensitive headers and embedded registered secrets without mutating safe headers', () => {
    const redactor = new SensitiveDataRedactor({ secrets: [HEADER_SECRET] });
    const result = redactor.redactHeaders({
      authorization: `Bearer ${HEADER_SECRET}`,
      cookie: `session=${HEADER_SECRET}`,
      'x-api-key': HEADER_SECRET,
      'x-request-id': 'request-safe-123',
      'x-debug': `prefix-${HEADER_SECRET}-suffix`,
    });
    expect(result).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'x-api-key': REDACTED,
      'x-request-id': 'request-safe-123',
      'x-debug': `prefix-${REDACTED}-suffix`,
    });
    expect(JSON.stringify(result)).not.toContain(HEADER_SECRET);

    const headersResult = redactor.redactHeaders(
      new Headers({ authorization: `Bearer ${HEADER_SECRET}`, 'x-debug': HEADER_SECRET }),
    );
    expect(headersResult).toEqual({ authorization: REDACTED, 'x-debug': REDACTED });
  });

  it('recursively redacts nested JSON fields, bearer text, URLs, arrays, and cycles', () => {
    const redactor = new SensitiveDataRedactor({ secrets: [JSON_SECRET, URL_SECRET] });
    const input: Record<string, unknown> = {
      safe: 'visible',
      nested: {
        accessToken: JSON_SECRET,
        note: `Bearer ${JSON_SECRET}`,
        callbackUrl: `https://example.test/callback?code=${URL_SECRET}#private`,
        list: [{ password: JSON_SECRET }, `prefix-${JSON_SECRET}`],
      },
    };
    input.circular = input;
    const result = redactor.redactJson(input) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(JSON_SECRET);
    expect(serialized).not.toContain(URL_SECRET);
    expect(serialized).toContain(REDACTED);
    expect(serialized).toContain('[CIRCULAR]');
    expect((result.nested as { accessToken: string }).accessToken).toBe(REDACTED);
    expect(input.nested).not.toEqual(result.nested);
  });

  it('removes URL credentials, fragments, and every query value', () => {
    const redactor = new SensitiveDataRedactor({ secrets: [URL_SECRET] });
    const result = redactor.redactUrl(
      `https://user:${URL_SECRET}@example.test/path?token=${URL_SECRET}&safe=value#${URL_SECRET}`,
    );
    expect(result).not.toContain(URL_SECRET);
    expect(result).not.toContain('value');
    expect(result).not.toContain('#');
    const parsed = new URL(result);
    expect(decodeURIComponent(parsed.username)).toBe(REDACTED);
    expect(decodeURIComponent(parsed.password)).toBe(REDACTED);
    expect([...parsed.searchParams.values()].every((value) => value === REDACTED)).toBe(true);
  });

  it('redacts command environment variables by key, known value, bearer token, and URL query', () => {
    const redactor = new SensitiveDataRedactor({ secrets: [ENV_SECRET] });
    const result = redactor.redactEnvironment({
      OPENAI_API_KEY: ENV_SECRET,
      DATABASE_URL: `https://db:${ENV_SECRET}@db.example.test/main?password=${ENV_SECRET}`,
      SAFE_PATH: '/usr/local/bin',
      SAFE_BUT_TAINTED: `prefix-${ENV_SECRET}`,
      AUTH_HEADER: `Bearer ${ENV_SECRET}`,
    });
    expect(result.OPENAI_API_KEY).toBe(REDACTED);
    expect(result.DATABASE_URL).not.toContain(ENV_SECRET);
    expect(result.SAFE_PATH).toBe('/usr/local/bin');
    expect(result.SAFE_BUT_TAINTED).toBe(`prefix-${REDACTED}`);
    expect(result.AUTH_HEADER).toBe(REDACTED);
    expect(JSON.stringify(result)).not.toContain(ENV_SECRET);
  });
});

describe('canary and credential scanning', () => {
  it('finds log/Task/checkpoint/artifact/PR canaries but reports no matched values', () => {
    const secrets = [HEADER_SECRET, JSON_SECRET, URL_SECRET, ENV_SECRET];
    const scanner = new SecretScanner({ secrets });
    const findings = scanner.scan({
      log: `failed with ${HEADER_SECRET}`,
      task: { description: JSON_SECRET },
      checkpoint: { summary: URL_SECRET },
      artifact: new Uint8Array(new TextEncoder().encode(ENV_SECRET)),
      pr: { body: `Bearer ${HEADER_SECRET}` },
    });
    expect(findings.length).toBeGreaterThanOrEqual(5);
    const serialized = JSON.stringify(findings);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(findings.every((finding) => finding.path.startsWith('$'))).toBe(true);

    let error: Error | undefined;
    try {
      scanner.assertNoSecrets({ artifact: ENV_SECRET });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain('Secret scan failed');
    expect(error?.message).not.toContain(ENV_SECRET);
  });

  it('detects credential-shaped text and passes a fully redacted structure', () => {
    const scanner = new SecretScanner();
    const findings = scanner.scan({
      github: `ghp_${'a'.repeat(36)}`,
      jwt: `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(24)}`,
      bearer: `Bearer ${'d'.repeat(32)}`,
    });
    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'bearer_token',
      'github_token',
      'jwt',
    ]);
    const redactor = new SensitiveDataRedactor();
    expect(scanner.scan(redactor.redactJson({ authorization: `Bearer ${'d'.repeat(32)}` }))).toEqual(
      [],
    );
  });
});
