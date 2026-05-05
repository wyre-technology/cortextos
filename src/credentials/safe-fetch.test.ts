import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as dns } from 'node:dns';
import { isPublicIp, validateVendorBaseUrl } from './safe-fetch.js';

describe('isPublicIp', () => {
  it('rejects IPv4 disallowed ranges', () => {
    const blocked = [
      '0.0.0.1',
      '10.0.0.1',
      '100.64.0.1',     // CGNAT
      '100.127.255.255',
      '127.0.0.1',
      '169.254.1.2',
      '169.254.169.254', // Azure/AWS IMDS
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.254',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ];
    for (const ip of blocked) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('accepts public IPv4', () => {
    const ok = ['8.8.8.8', '1.1.1.1', '52.96.0.1', '104.21.56.12', '203.0.114.1'];
    for (const ip of ok) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it('rejects IPv6 disallowed', () => {
    const blocked = ['::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'];
    for (const ip of blocked) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('accepts public IPv6', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
    expect(isPublicIp('')).toBe(false);
    expect(isPublicIp('1.2.3')).toBe(false);
  });
});

describe('validateVendorBaseUrl', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolve4Spy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolve6Spy: any;

  beforeEach(() => {
    resolve4Spy = vi.spyOn(dns, 'resolve4');
    resolve6Spy = vi.spyOn(dns, 'resolve6');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDns(addrs: { v4?: string[]; v6?: string[] }) {
    resolve4Spy.mockResolvedValue(addrs.v4 ?? []);
    resolve6Spy.mockResolvedValue(addrs.v6 ?? []);
  }

  it('rejects non-https schemes by default', async () => {
    await expect(validateVendorBaseUrl('http://example.com/')).rejects.toThrow(/https/);
    await expect(validateVendorBaseUrl('ftp://example.com/')).rejects.toThrow(/https/);
    await expect(validateVendorBaseUrl('file:///etc/passwd')).rejects.toThrow(/https/);
    await expect(validateVendorBaseUrl('javascript:alert(1)')).rejects.toThrow(/https/);
  });

  it('rejects malformed URLs', async () => {
    await expect(validateVendorBaseUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });

  it('rejects literal disallowed IPs (wiring smoke test — full IP table covered above)', async () => {
    // Just confirm the wiring catches one IPv4 + one IPv6 + the IMDS literal.
    // Exhaustive IP coverage lives in the isPublicIp suite.
    await expect(validateVendorBaseUrl('https://169.254.169.254/')).rejects.toThrow(/non-public/);
    await expect(validateVendorBaseUrl('https://10.0.0.1/')).rejects.toThrow(/non-public/);
    await expect(validateVendorBaseUrl('https://[::1]/')).rejects.toThrow(/non-public/);
  });

  it('rejects hostname that resolves to a private address', async () => {
    mockDns({ v4: ['10.0.0.5'] });
    await expect(validateVendorBaseUrl('https://attacker.example/')).rejects.toThrow(/non-public/);
  });

  it('rejects hostname that resolves to IMDS', async () => {
    mockDns({ v4: ['169.254.169.254'] });
    await expect(validateVendorBaseUrl('https://meta.attacker.example/')).rejects.toThrow(/non-public/);
  });

  it('rejects hostname with mixed public/private results (rebinding shape)', async () => {
    mockDns({ v4: ['8.8.8.8', '10.0.0.5'] });
    await expect(validateVendorBaseUrl('https://rebind.example/')).rejects.toThrow(/non-public/);
  });

  it('rejects hostname that does not resolve', async () => {
    mockDns({ v4: [], v6: [] });
    await expect(validateVendorBaseUrl('https://no-such-host.example/')).rejects.toThrow(/resolve/);
  });

  it('accepts hostname that resolves to a public IP', async () => {
    mockDns({ v4: ['8.8.8.8'] });
    await expect(validateVendorBaseUrl('https://api.vendor.com/path')).resolves.toBeUndefined();
  });

  it('accepts hostname that resolves only to public IPv6', async () => {
    mockDns({ v6: ['2606:4700:4700::1111'] });
    await expect(validateVendorBaseUrl('https://v6-only.example/')).resolves.toBeUndefined();
  });

});
