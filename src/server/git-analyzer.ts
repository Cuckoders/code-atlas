import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitComparison, GitSummary } from '../shared/graph.js';

const execFileAsync = promisify(execFile);
const MAX_COMMITS = 300;
const MAX_GIT_OUTPUT = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const COMMIT_PREFIX = '@@@';
const FIELD_SEPARATOR = '\u001f';
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,127}$/;

export interface GitFileHistory {
  commits: number;
  additions: number;
  deletions: number;
  authors: string[];
  lastChangedAt?: string;
  change?: 'added' | 'modified' | 'deleted';
}

export interface GitAnalysis {
  summary: GitSummary;
  files: Map<string, GitFileHistory>;
}

export class GitReferenceError extends Error {}

export async function analyzeGitHistory(rootPath: string, compareRef?: string): Promise<GitAnalysis> {
  if (compareRef && !isSafeGitReference(compareRef)) {
    throw new GitReferenceError('Некорректное имя Git-ветки или тега.');
  }

  const isRepository = await runGit(rootPath, ['rev-parse', '--is-inside-work-tree']).catch(() => null);
  if (isRepository?.trim() !== 'true') return emptyAnalysis();

  const [branchResult, logResult] = await Promise.all([
    readBranch(rootPath),
    runGit(rootPath, [
      'log',
      `--max-count=${MAX_COMMITS}`,
      '--date=iso-strict',
      `--format=${COMMIT_PREFIX}%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI`,
      '--numstat',
      '--no-ext-diff',
      '--no-textconv',
      '--relative',
      '--',
      '.',
    ]).catch(() => ''),
  ]);
  const parsed = parseGitLog(logResult);
  const comparison = compareRef ? await compareWithReference(rootPath, compareRef, parsed.files) : undefined;

  return {
    summary: {
      available: true,
      branch: branchResult,
      commitsAnalyzed: parsed.commits,
      contributors: [...parsed.contributors].sort(),
      lastCommitAt: parsed.lastCommitAt,
      comparison,
    },
    files: parsed.files,
  };
}

export function isSafeGitReference(reference: string): boolean {
  return SAFE_REF.test(reference) && !reference.includes('..') && !reference.includes('@{');
}

async function readBranch(rootPath: string): Promise<string | undefined> {
  const branch = await runGit(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (branch.trim()) return branch.trim();
  const commit = await runGit(rootPath, ['rev-parse', '--short', 'HEAD']).catch(() => '');
  return commit.trim() || undefined;
}

function parseGitLog(output: string): {
  commits: number;
  contributors: Set<string>;
  lastCommitAt?: string;
  files: Map<string, GitFileHistory>;
} {
  const files = new Map<string, GitFileHistory>();
  const contributors = new Set<string>();
  let commits = 0;
  let currentAuthor = '';
  let currentDate = '';
  let lastCommitAt: string | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith(COMMIT_PREFIX)) {
      const [, author = '', date = ''] = line.slice(COMMIT_PREFIX.length).split(FIELD_SEPARATOR);
      currentAuthor = author;
      currentDate = date;
      if (author) contributors.add(author);
      if (!lastCommitAt && date) lastCommitAt = date;
      commits += 1;
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const filePath = normalizeGitPath(match[3]);
    const current = files.get(filePath) ?? {
      commits: 0,
      additions: 0,
      deletions: 0,
      authors: [],
    };
    current.commits += 1;
    current.additions += match[1] === '-' ? 0 : Number(match[1]);
    current.deletions += match[2] === '-' ? 0 : Number(match[2]);
    if (currentAuthor && !current.authors.includes(currentAuthor)) current.authors.push(currentAuthor);
    current.lastChangedAt ??= currentDate || undefined;
    files.set(filePath, current);
  }
  return { commits, contributors, lastCommitAt, files };
}

async function compareWithReference(
  rootPath: string,
  reference: string,
  files: Map<string, GitFileHistory>,
): Promise<GitComparison> {
  const verified = await runGit(rootPath, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`]).catch(() => '');
  if (!verified.trim()) throw new GitReferenceError(`Git-ref «${reference}» не найден.`);
  const output = await runGit(rootPath, [
    'diff',
    '--name-status',
    '--no-ext-diff',
    '--no-textconv',
    '--relative',
    reference,
    'HEAD',
    '--',
    '.',
  ]).catch(() => {
    throw new GitReferenceError(`Не удалось сравнить проект с «${reference}».`);
  });
  let added = 0;
  let modified = 0;
  let deleted = 0;
  const changedPaths = new Set<string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [rawStatus, firstPath, secondPath] = line.split('\t');
    const status = rawStatus?.[0];
    const filePath = normalizeGitPath(secondPath ?? firstPath ?? '');
    if (!filePath) continue;
    changedPaths.add(filePath);
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';
    if (change === 'added') added += 1;
    else if (change === 'deleted') deleted += 1;
    else modified += 1;
    const history = files.get(filePath) ?? { commits: 0, additions: 0, deletions: 0, authors: [] };
    history.change = change;
    files.set(filePath, history);
  }
  return { baseRef: reference, changedFiles: changedPaths.size, added, modified, deleted };
}

function normalizeGitPath(filePath: string): string {
  const braceRename = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/.exec(filePath);
  return braceRename ? `${braceRename[1]}${braceRename[2]}${braceRename[3]}` : filePath;
}

async function runGit(rootPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['--no-pager', ...args], {
    cwd: rootPath,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.stdout;
}

function emptyAnalysis(): GitAnalysis {
  return {
    summary: { available: false, commitsAnalyzed: 0, contributors: [] },
    files: new Map(),
  };
}
