import { describe, it, expect } from 'vitest';
import { publicSourceUrl } from './sourcePath';

describe('publicSourceUrl', () => {
  it('maps a local ingest path to the public origin', () => {
    expect(publicSourceUrl('/Users/Abhishek/Desktop/ZeroIndex/Code/zeroindexai/index.html')).toBe(
      'https://zeroindex.ai'
    );
  });

  it('never returns a local filesystem path', () => {
    const out = publicSourceUrl('/Users/someone/secret/path/index.html');
    expect(out.startsWith('/Users/')).toBe(false);
    expect(out).toBe('https://zeroindex.ai');
  });

  it('passes through an already-public URL', () => {
    expect(publicSourceUrl('https://zeroindex.ai/#services')).toBe('https://zeroindex.ai/#services');
  });
});
