import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyNewSignup, type NewSignupEvent } from './sales-notifier.js';
import type { FastifyBaseLogger } from 'fastify';

// Mock the config
vi.mock('../config.js', () => ({
  config: {
    slackSalesWebhookUrl: 'https://hooks.slack.com/test-webhook',
  },
}));

// Mock fetch globally
global.fetch = vi.fn();

describe('notifyNewSignup', () => {
  const mockLog: FastifyBaseLogger = {
    warn: vi.fn(),
  } as unknown as FastifyBaseLogger;

  const baseEvent: NewSignupEvent = {
    userId: 'user-123',
    orgId: 'org-456',
    isOwner: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
  });

  it('should not post when user has multiple memberships', async () => {
    // Mock SQL to return count !== 1
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 2 }]); // membership count query

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should not post when user has zero memberships', async () => {
    // Mock SQL to return count = 0
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 0 }]); // membership count query

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should not post when user data is missing', async () => {
    // Mock SQL to return count = 1 then empty user data
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count query
      .mockResolvedValueOnce([]); // no user data

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(global.fetch).not.toHaveBeenCalled();
    // Function should return early without logging error since user data is checked and returns early
  });

  it('should not post when org data is missing', async () => {
    // Mock SQL to return count = 1, user data, then empty org data
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count query
      .mockResolvedValueOnce([{ email: 'test@example.com', name: 'Test User' }]) // user data
      .mockResolvedValueOnce([]); // no org data

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(global.fetch).not.toHaveBeenCalled();
    // Function should return early without logging error since org data is checked and returns early
  });

  it('should post slack message for new member signup', async () => {
    // Mock successful queries
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count
      .mockResolvedValueOnce([{ email: 'test@example.com', name: 'Test User' }]) // user data
      .mockResolvedValueOnce([{ name: 'Test Organization' }]); // org data

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test-webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"text":":wave: New Conduit signup — test@example.com (Joined existing org)"'),
      }
    );

    const fetchCall = (global.fetch as any).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);

    expect(payload.text).toBe(':wave: New Conduit signup — test@example.com (Joined existing org)');
    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[0].text.text).toContain(':wave: *New Conduit signup*');
    expect(payload.blocks[0].text.text).toContain('*Test User <test@example.com>* joined an existing organization, *Test Organization*.');
    expect(payload.blocks[1].fields).toHaveLength(3);
    expect(payload.blocks[1].fields[2].text).toContain('*Type*\nJoined existing org');
  });

  it('should post slack message for new owner signup', async () => {
    const ownerEvent: NewSignupEvent = { ...baseEvent, isOwner: true };

    // Mock successful queries
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count
      .mockResolvedValueOnce([{ email: 'owner@example.com', name: null }]) // user data (no name)
      .mockResolvedValueOnce([{ name: 'New Organization' }]); // org data

    await notifyNewSignup(mockSqlFn as any, ownerEvent, mockLog);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test-webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"text":":office: New Conduit signup — owner@example.com (Org owner)"'),
      }
    );

    const fetchCall = (global.fetch as any).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);

    expect(payload.text).toBe(':office: New Conduit signup — owner@example.com (Org owner)');
    expect(payload.blocks[0].text.text).toContain(':office: *New Conduit signup*');
    expect(payload.blocks[0].text.text).toContain('*owner@example.com* created a new organization, *New Organization*.');
    expect(payload.blocks[1].fields[2].text).toContain('*Type*\nOrg owner');
  });

  it('should handle fetch errors gracefully', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));

    // Mock successful queries
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count
      .mockResolvedValueOnce([{ email: 'test@example.com', name: 'Test User' }]) // user data
      .mockResolvedValueOnce([{ name: 'Test Organization' }]); // org data

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(mockLog.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'sales-notifier: Slack webhook call threw'
    );
  });

  it('should handle non-2xx responses gracefully', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    // Mock successful queries
    const mockSqlFn = vi.fn()
      .mockResolvedValueOnce([{ count: 1 }]) // membership count
      .mockResolvedValueOnce([{ email: 'test@example.com', name: 'Test User' }]) // user data
      .mockResolvedValueOnce([{ name: 'Test Organization' }]); // org data

    await notifyNewSignup(mockSqlFn as any, baseEvent, mockLog);

    expect(mockLog.warn).toHaveBeenCalledWith(
      { status: 500, statusText: 'Internal Server Error' },
      'sales-notifier: Slack webhook returned non-2xx'
    );
  });
});

// Note: Testing the no webhook URL case is complex with vitest mocking,
// but the logic is straightforward: postToSlack returns early if config.slackSalesWebhookUrl is falsy.