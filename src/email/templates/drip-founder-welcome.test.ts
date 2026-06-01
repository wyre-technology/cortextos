import { describe, it, expect } from 'vitest';
import {
  dripFounderWelcomeSubject,
  dripFounderWelcomeHtml,
} from './drip-founder-welcome.js';

describe('dripFounderWelcomeSubject', () => {
  it('personalizes with the recipient name when present', () => {
    expect(dripFounderWelcomeSubject({ recipientName: 'Tim' })).toBe(
      'Welcome to WYRE Gateway, Tim',
    );
  });

  it('omits the name when absent', () => {
    expect(dripFounderWelcomeSubject({})).toBe('Welcome to WYRE Gateway');
  });

  it('uses the first name only when given a full name (Aaron-flagged regression)', () => {
    expect(dripFounderWelcomeSubject({ recipientName: 'Aaron Sachs' })).toBe(
      'Welcome to WYRE Gateway, Aaron',
    );
  });

  it('falls back to no-name on whitespace-only recipientName', () => {
    expect(dripFounderWelcomeSubject({ recipientName: '   ' })).toBe('Welcome to WYRE Gateway');
  });
});

describe('dripFounderWelcomeHtml', () => {
  it('greets by name and names the company', () => {
    const html = dripFounderWelcomeHtml({ recipientName: 'Tim', company: 'FCITG' });
    expect(html).toContain('Hi Tim,');
    expect(html).toContain('Saw FCITG come through');
  });

  it('falls back to "Hi there," when no name is given', () => {
    const html = dripFounderWelcomeHtml({ company: 'FCITG' });
    expect(html).toContain('Hi there,');
  });

  it('greets by first name only when given a full name (Aaron-flagged regression)', () => {
    const html = dripFounderWelcomeHtml({ recipientName: 'Aaron Sachs', company: 'FCITG' });
    expect(html).toContain('Hi Aaron,');
    expect(html).not.toContain('Hi Aaron Sachs,');
  });

  it('includes the Calendly link as anchor text and the Discord URL', () => {
    const html = dripFounderWelcomeHtml({ recipientName: 'Tim', company: 'FCITG' });
    expect(html).toContain('href="https://calendly.com/aaronsachs-wyre/1-1-w-aaron"');
    expect(html).toContain('grab a time on my calendar');
    expect(html).toContain('https://discord.gg/cCPtPaFw8e');
  });

  it('includes the WYRE signature', () => {
    const html = dripFounderWelcomeHtml({ recipientName: 'Tim', company: 'FCITG' });
    expect(html).toContain('Aaron Sachs');
    expect(html).toContain('mailto:aaron@wyre.ai');
  });

  it('escapes HTML-special characters in the company name', () => {
    const html = dripFounderWelcomeHtml({
      recipientName: 'Juan Carlos',
      company: 'AM3 Technology & Cybersecurity',
    });
    expect(html).toContain('AM3 Technology &amp; Cybersecurity');
    expect(html).not.toContain('AM3 Technology & Cybersecurity');
  });
});
