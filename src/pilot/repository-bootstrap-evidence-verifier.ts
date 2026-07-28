import { canonicalSha256 } from '../domain/digest.js';
import {
  RepositoryBootstrapEvidenceManifestV1Schema,
  type RepositoryBootstrapEvidenceManifestV1,
} from '../domain/repository-bootstrap-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const RULE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const RULE_SOURCE_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export type RepositoryBootstrapEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'decision_digest_mismatch'
  | 'local_remote_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_repository_mismatch'
  | 'github_branch_mismatch'
  | 'github_protection_mismatch';

export class RepositoryBootstrapEvidenceVerificationError extends Error {
  constructor(readonly code: RepositoryBootstrapEvidenceVerificationErrorCode) {
    super(`Repository bootstrap evidence verification failed: ${code}`);
    this.name = 'RepositoryBootstrapEvidenceVerificationError';
  }
}

export interface RepositoryBootstrapEvidenceVerifierOptions {
  githubToken: string;
  localOriginUrl: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface RepositoryBootstrapEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  decisionId: string;
  repository: string;
  visibility: 'public' | 'private' | 'internal';
  defaultBranch: string;
  githubRepositoryId: string;
  branchHeadSha: string;
  activeRuleCount: number;
  rulesDigest: string;
  localOriginMatched: true;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new RepositoryBootstrapEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new RepositoryBootstrapEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function repositoryFromRemote(raw: string): string | null {
  if (raw.length < 1 || raw.length > 2_048 || /[\0\r\n]/.test(raw)) return null;
  const scp = /^git@github\.com:(.+)$/.exec(raw);
  if (scp !== null) {
    const path = (scp[1] ?? '').replace(/\.git$/, '');
    return REPOSITORY_PATTERN.test(path) ? path : null;
  }
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const https = url.protocol === 'https:' && url.username === '' && url.password === '';
  const ssh = url.protocol === 'ssh:' && url.username === 'git' && url.password === '';
  if (
    (!https && !ssh) || url.hostname !== 'github.com' || url.port !== '' ||
    url.search !== '' || url.hash !== ''
  ) return null;
  const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  return REPOSITORY_PATTERN.test(path) ? path : null;
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function getJson(fetcher: typeof fetch, url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
    });
  } catch {
    throw new RepositoryBootstrapEvidenceVerificationError('github_api_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new RepositoryBootstrapEvidenceVerificationError('github_api_unavailable');
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid');
  }
  const bytes = await readBounded(response);
  if (bytes === null) {
    throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid');
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid'); }
}

function githubId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && GITHUB_ID_PATTERN.test(value)) return value;
  return null;
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function normalizeActiveRules(input: unknown): Promise<
  RepositoryBootstrapEvidenceManifestV1['protection']['rules']
> {
  if (!Array.isArray(input) || input.length > 100) {
    throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid');
  }
  const rules: RepositoryBootstrapEvidenceManifestV1['protection']['rules'] = [];
  for (const value of input) {
    const rule = record(value);
    const id = githubId(rule?.ruleset_id);
    const type = rule?.type;
    const sourceType = rule?.ruleset_source_type;
    const source = rule?.ruleset_source;
    // GitHub's effective `/rules/branches/:branch` endpoint omits the
    // ruleset enforcement (some responses expose it as `null`); presence in
    // this endpoint already means the rule is active. The `/rulesets` endpoint
    // retains the explicit `active` value, so accept all three representations.
    const enforcement = rule === null || !Object.hasOwn(rule, 'enforcement') ||
      rule.enforcement === null ? 'active' : rule.enforcement;
    if (
      rule === null || id === null || typeof type !== 'string' || !RULE_TYPE_PATTERN.test(type) ||
      (sourceType !== 'Repository' && sourceType !== 'Organization' && sourceType !== 'Enterprise') ||
      typeof source !== 'string' || !RULE_SOURCE_PATTERN.test(source) ||
      (enforcement !== 'active' && enforcement !== 'evaluate' && enforcement !== 'disabled')
    ) throw new RepositoryBootstrapEvidenceVerificationError('github_response_invalid');
    if (enforcement !== 'active') continue;
    rules.push({
      rulesetId: id,
      type,
      rulesetSourceType: sourceType,
      rulesetSource: source,
      enforcement: 'active',
      parametersDigest: await canonicalSha256(
        Object.hasOwn(rule, 'parameters') ? rule.parameters : null,
      ),
    });
  }
  rules.sort((left, right) =>
    `${left.rulesetId}\0${left.type}\0${left.parametersDigest}`.localeCompare(
      `${right.rulesetId}\0${right.type}\0${right.parametersDigest}`,
    ));
  if (rules.length < 1) {
    throw new RepositoryBootstrapEvidenceVerificationError('github_protection_mismatch');
  }
  return rules;
}

export async function verifyRepositoryBootstrapEvidence(
  input: RepositoryBootstrapEvidenceManifestV1,
  options: RepositoryBootstrapEvidenceVerifierOptions,
): Promise<RepositoryBootstrapEvidenceVerificationSummary> {
  const parsed = RepositoryBootstrapEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new RepositoryBootstrapEvidenceVerificationError('manifest_invalid');
  }
  if (!TOKEN_PATTERN.test(options.githubToken)) {
    throw new RepositoryBootstrapEvidenceVerificationError('configuration_invalid');
  }
  const manifest = parsed.data;
  const manifestRulesDigest = await canonicalSha256(manifest.protection.rules);
  const selectionDigest = await canonicalSha256({
    repository: manifest.decision.repository,
    visibility: manifest.decision.visibility,
    defaultBranch: manifest.decision.defaultBranch,
    protectionRulesDigest: manifest.decision.protectionRulesDigest,
  });
  if (
    manifestRulesDigest !== manifest.protection.rulesDigest ||
    selectionDigest !== manifest.decision.selectionDigest
  ) throw new RepositoryBootstrapEvidenceVerificationError('decision_digest_mismatch');
  const localRepository = repositoryFromRemote(options.localOriginUrl);
  if (localRepository !== manifest.repository.fullName) {
    throw new RepositoryBootstrapEvidenceVerificationError('local_remote_mismatch');
  }
  const apiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const repositoryPath = `/repos/${manifest.repository.fullName}`;
  const repository = record(await getJson(
    fetcher, `${apiOrigin}${repositoryPath}`, options.githubToken,
  ));
  const owner = record(repository?.owner);
  if (
    repository === null || githubId(repository.id) !== manifest.repository.githubRepositoryId ||
    repository.name !== manifest.repository.name || repository.full_name !== manifest.repository.fullName ||
    repository.html_url !== manifest.repository.htmlUrl ||
    repository.visibility !== manifest.repository.visibility ||
    repository.private !== (manifest.repository.visibility === 'private') ||
    repository.default_branch !== manifest.repository.defaultBranch ||
    repository.archived !== false || repository.disabled !== false || repository.fork !== false ||
    normalizedDate(repository.created_at) !== new Date(manifest.repository.createdAt).toISOString() ||
    owner?.login !== manifest.repository.ownerLogin || owner.type !== manifest.repository.ownerType
  ) throw new RepositoryBootstrapEvidenceVerificationError('github_repository_mismatch');

  const encodedBranch = manifest.repository.defaultBranch.split('/').map(encodeURIComponent).join('/');
  const branch = record(await getJson(
    fetcher,
    `${apiOrigin}${repositoryPath}/branches/${encodedBranch}`,
    options.githubToken,
  ));
  const commit = record(branch?.commit);
  if (
    branch === null || branch.name !== manifest.branch.name || branch.protected !== true ||
    commit?.sha !== manifest.branch.headSha
  ) throw new RepositoryBootstrapEvidenceVerificationError('github_branch_mismatch');

  const liveRules = await normalizeActiveRules(await getJson(
    fetcher,
    `${apiOrigin}${repositoryPath}/rules/branches/${encodedBranch}`,
    options.githubToken,
  ));
  const liveRulesDigest = await canonicalSha256(liveRules);
  if (
    liveRulesDigest !== manifest.protection.rulesDigest ||
    JSON.stringify(liveRules) !== JSON.stringify(manifest.protection.rules)
  ) throw new RepositoryBootstrapEvidenceVerificationError('github_protection_mismatch');

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    decisionId: manifest.decision.decisionId,
    repository: manifest.repository.fullName,
    visibility: manifest.repository.visibility,
    defaultBranch: manifest.repository.defaultBranch,
    githubRepositoryId: manifest.repository.githubRepositoryId,
    branchHeadSha: manifest.branch.headSha,
    activeRuleCount: liveRules.length,
    rulesDigest: liveRulesDigest,
    localOriginMatched: true,
  };
}
