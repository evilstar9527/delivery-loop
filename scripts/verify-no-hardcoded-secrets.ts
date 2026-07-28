import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { SecretScanner, type SecretFinding } from '../src/security/redaction.js';

const ROOT = resolve('.');
const SCAN_ROOTS = ['src', 'scripts', '.github/workflows', 'migrations', 'schemas'];
const TEXT_EXTENSIONS = new Set(['.ts', '.mjs', '.yml', '.yaml', '.sql', '.json', '.jsonc']);

function configuredCanaries(): string[] {
  const raw = process.env.DELIVERY_CANARY_SECRETS_JSON;
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Secret scan canary configuration is invalid');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('Secret scan canary configuration is invalid');
  }
  return parsed;
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(absolute);
  }
  return files;
}

const scanner = new SecretScanner({ secrets: configuredCanaries() });
const files = (
  await Promise.all(SCAN_ROOTS.map(async (path) => await filesUnder(resolve(ROOT, path))))
).flat();
const findings: SecretFinding[] = [];
for (const file of files) {
  findings.push(...scanner.scanText(await readFile(file, 'utf8'), relative(ROOT, file)));
}
if (findings.length > 0) {
  const paths = [...new Set(findings.map((finding) => finding.path))].slice(0, 20);
  throw new Error(
    `Production secret scan failed with ${findings.length} finding(s) in ${paths.join(', ')}`,
  );
}
process.stdout.write(`Production secret scan verified ${files.length} files.\n`);
