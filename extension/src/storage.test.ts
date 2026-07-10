// ABOUTME: Unit tests for normalizeBoardUrl — the localhost→127.0.0.1 pin that keeps the MV3 service
// ABOUTME: worker from dying on IPv6 (::1) when the board is bound only to IPv4 (127.0.0.1).
import { describe, it, expect } from 'vitest';
import { normalizeBoardUrl } from './storage';

describe('normalizeBoardUrl', () => {
  it('pins a bare localhost host to IPv4, preserving port and path', () => {
    expect(normalizeBoardUrl('http://localhost:4611')).toBe('http://127.0.0.1:4611');
    expect(normalizeBoardUrl('http://localhost')).toBe('http://127.0.0.1');
    expect(normalizeBoardUrl('http://localhost/api/agent/bugs')).toBe('http://127.0.0.1/api/agent/bugs');
    expect(normalizeBoardUrl('https://localhost:8443')).toBe('https://127.0.0.1:8443');
  });

  it('leaves real hostnames untouched', () => {
    expect(normalizeBoardUrl('https://be10x.notpritam.in')).toBe('https://be10x.notpritam.in');
    expect(normalizeBoardUrl('http://localhost.company.com:4611')).toBe('http://localhost.company.com:4611');
    expect(normalizeBoardUrl('http://mylocalhost:4611')).toBe('http://mylocalhost:4611');
    expect(normalizeBoardUrl('http://127.0.0.1:4611')).toBe('http://127.0.0.1:4611');
  });

  it('passes through empty/undefined', () => {
    expect(normalizeBoardUrl(undefined)).toBeUndefined();
    expect(normalizeBoardUrl('')).toBe('');
  });
});
