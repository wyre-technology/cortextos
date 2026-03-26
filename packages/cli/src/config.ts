/**
 * CLI configuration — reads gateway URL and token from disk/env.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.config', 'mcpgw');
const TOKEN_PATH = join(CONFIG_DIR, 'token.json');

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  gatewayUrl: string;
}

export function getGatewayUrl(): string {
  return process.env.MCPGW_URL ?? 'https://mcp.wyre.ai';
}

export function loadToken(): TokenData | null {
  if (process.env.MCPGW_TOKEN) {
    return {
      accessToken: process.env.MCPGW_TOKEN,
      gatewayUrl: getGatewayUrl(),
    };
  }

  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = readFileSync(TOKEN_PATH, 'utf-8');
    return JSON.parse(raw) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(data: TokenData): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function clearToken(): void {
  if (existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, '', { mode: 0o600 });
  }
}
