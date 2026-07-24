import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist']);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !ignored.has(entry.name))
      .map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return markdownFiles(absolute);
        return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : [];
      }),
  );
  return nested.flat();
}

const broken = [];
for (const file of await markdownFiles(root)) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || /^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split('#')[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    try {
      await stat(resolved);
    } catch {
      broken.push(`${path.relative(root, file)} -> ${rawTarget}`);
    }
  }
}

if (broken.length > 0) {
  process.stderr.write(`Broken documentation links:\n${broken.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Documentation links verified.\n');
}

