import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCachePathAllowed,
  validateMainMessage,
  validateWorkerData,
  validateWorkerMessage,
} from '../src/server/analysis-worker-protocol.js';

describe('analysis worker protocol', () => {
  it('allows only normalized cache paths inside the expected project', () => {
    const projectPath = path.resolve('/tmp/code-atlas-project');

    expect(isCachePathAllowed(projectPath, projectPath, 'src/controllers/orders.ts')).toBe(true);
    expect(isCachePathAllowed(projectPath, projectPath, '../secrets.txt')).toBe(false);
    expect(isCachePathAllowed(projectPath, projectPath, 'src/../../secrets.txt')).toBe(false);
    expect(isCachePathAllowed(projectPath, projectPath, '/etc/passwd')).toBe(false);
    expect(isCachePathAllowed(projectPath, projectPath, 'src\\secrets.txt')).toBe(false);
    expect(isCachePathAllowed('/tmp/other-project', projectPath, 'src/index.ts')).toBe(false);
  });

  it('rejects malformed worker data and IPC messages', () => {
    expect(validateWorkerData({ projectPath: '/tmp/project', compareRef: '--output=/tmp/leak' })).toBeNull();
    expect(validateWorkerMessage({
      type: 'progress',
      progress: { phase: 'parsing', processedFiles: 9, totalFiles: 4, percentage: 225 },
    })).toBeNull();
    expect(validateWorkerMessage({
      type: 'cache-get',
      requestId: '1',
      projectPath: '/tmp/project',
      relativePath: 'src/index.ts',
      contentHash: 'not-a-sha256',
    })).toBeNull();
    expect(validateMainMessage({ type: 'cache-response', requestId: 'nope', ok: true })).toBeNull();
  });
});
