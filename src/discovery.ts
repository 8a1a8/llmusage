import {opendir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, extname, join, normalize, resolve, sep} from 'node:path';
import type {DiscoveredFile, Source} from './types.js';
import {expandHome} from './utils.js';

interface DiscoveryResult {
  files: DiscoveredFile[];
  warnings: string[];
}

const sourceFromPath = (path: string): Source => {
  const normalized = normalize(path).toLowerCase();
  if (
    normalized.includes(`${sep}claude${sep}local-agent-mode-sessions${sep}`) &&
    normalized.includes(`${sep}.claude${sep}projects${sep}`)
  ) return 'claude-desktop';
  if (normalized.includes(`${normalize('.codex/sessions').toLowerCase()}`)) return 'codex';
  if (normalized.includes(`${normalize('.claude/projects').toLowerCase()}`)) return 'claude';
  if (
    normalized.includes(`${normalize('.grok/sessions').toLowerCase()}`) &&
    ['updates.jsonl', 'signals.json'].includes(basename(path).toLowerCase())
  ) return 'grok';
  return 'generic';
};

const claudeDesktopRoots = (home: string): string[] => {
  if (process.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions')];
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')];
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return [
    join(config, 'Claude', 'local-agent-mode-sessions'),
    join(config, 'claude', 'local-agent-mode-sessions')
  ];
};

const isClaudeDesktopUsage = (path: string): boolean => {
  const normalized = normalize(path).toLowerCase();
  return extname(path).toLowerCase() === '.jsonl' &&
    basename(path).toLowerCase() !== 'audit.jsonl' &&
    normalized.includes(`${sep}.claude${sep}projects${sep}`);
};

const walk = async (
  root: string,
  source: Source,
  matches: (path: string) => boolean,
  output: DiscoveredFile[],
  warnings: string[],
  descends: (path: string) => boolean = () => true
): Promise<void> => {
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && descends(path)) await walk(path, source, matches, output, warnings, descends);
      else if (entry.isFile() && matches(path)) output.push({path, source});
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') warnings.push(`Could not read ${root}: ${(error as Error).message}`);
  }
};

export const discoverFiles = async (paths?: string[], sources?: Source[]): Promise<DiscoveryResult> => {
  const output: DiscoveredFile[] = [];
  const warnings: string[] = [];
  const allowed = new Set<Source>(sources?.length ? sources : ['codex', 'claude', 'claude-desktop', 'grok', 'generic']);

  if (paths?.length) {
    for (const rawPath of paths) {
      const path = expandHome(rawPath);
      try {
        const info = await stat(path);
        if (info.isFile()) {
          const source = sourceFromPath(path);
          if (allowed.has(source)) output.push({path, source});
        } else if (info.isDirectory()) {
          await walk(
            path,
            'generic',
            candidate => extname(candidate).toLowerCase() === '.jsonl' || basename(candidate).toLowerCase() === 'signals.json',
            output,
            warnings
          );
        }
      } catch (error) {
        warnings.push(`Could not inspect ${path}: ${(error as Error).message}`);
      }
    }
  } else {
    const home = homedir();
    if (allowed.has('codex')) {
      await walk(join(home, '.codex', 'sessions'), 'codex', path => extname(path).toLowerCase() === '.jsonl', output, warnings);
    }
    if (allowed.has('claude')) {
      await walk(join(home, '.claude', 'projects'), 'claude', path => extname(path).toLowerCase() === '.jsonl', output, warnings);
    }
    if (allowed.has('claude-desktop')) {
      for (const root of claudeDesktopRoots(home)) {
        await walk(
          root,
          'claude-desktop',
          isClaudeDesktopUsage,
          output,
          warnings,
          path => !['outputs', 'node_modules', '.git'].includes(basename(path).toLowerCase())
        );
      }
    }
    if (allowed.has('grok')) {
      await walk(
        join(home, '.grok', 'sessions'),
        'grok',
        path => ['updates.jsonl', 'signals.json'].includes(basename(path).toLowerCase()),
        output,
        warnings
      );
    }
  }

  const unique = new Map<string, DiscoveredFile>();
  const grokUpdateDirectories = new Set(
    output
      .filter(file =>
        basename(file.path).toLowerCase() === 'updates.jsonl' &&
        (file.source === 'grok' || sourceFromPath(resolve(file.path)) === 'grok')
      )
      .map(file => normalize(dirname(resolve(file.path))).toLowerCase())
  );
  for (const file of output) {
    const path = resolve(file.path);
    const normalizedPath = normalize(path).toLowerCase();
    if (
      basename(path).toLowerCase() === 'audit.jsonl' &&
      normalizedPath.includes(`${sep}local-agent-mode-sessions${sep}`)
    ) continue;
    const inferred = file.source === 'generic' ? sourceFromPath(path) : file.source;
    if (
      inferred === 'grok' &&
      basename(path).toLowerCase() === 'signals.json' &&
      grokUpdateDirectories.has(normalize(dirname(path)).toLowerCase())
    ) continue;
    if (allowed.has(inferred)) unique.set(normalize(path).toLowerCase(), {path, source: inferred});
  }
  const files = [...unique.values()];
  if (allowed.has('claude') && allowed.has('claude-desktop')) {
    const claudeCodeSessions = new Set(
      files.filter(file => file.source === 'claude').map(file => basename(file.path, '.jsonl').toLowerCase())
    );
    for (let index = files.length - 1; index >= 0; index--) {
      const file = files[index];
      if (file.source === 'claude-desktop' && claudeCodeSessions.has(basename(file.path, '.jsonl').toLowerCase())) {
        files.splice(index, 1);
      }
    }
  }
  return {files: files.sort((a, b) => a.path.localeCompare(b.path)), warnings};
};
