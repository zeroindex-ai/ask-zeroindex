import { describe, it, expect } from 'vitest';
import { errMsg } from './errors';

describe('errMsg', () => {
  it('extracts message from Error instance', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('returns string throws as-is', () => {
    expect(errMsg('oops')).toBe('oops');
  });

  it('extracts message from plain object with .message', () => {
    expect(errMsg({ message: 'object error' })).toBe('object error');
  });

  it('coerces non-string .message to string', () => {
    expect(errMsg({ message: 42 })).toBe('42');
  });

  it('stringifies undefined / null / numbers', () => {
    expect(errMsg(undefined)).toBe('undefined');
    expect(errMsg(null)).toBe('null');
    expect(errMsg(42)).toBe('42');
  });

  it('handles objects without .message via String()', () => {
    expect(errMsg({ foo: 'bar' })).toBe('[object Object]');
  });
});
