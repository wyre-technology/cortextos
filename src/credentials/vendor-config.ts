export interface VendorField {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Configuration for vendors that use OAuth 2.0 Authorization Code flow. */
export interface OAuthVendorConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  extraTokenParams?: Record<string, string>;
  extraFields?: string[];
}

export type VendorCategory = 'rmm' | 'psa' | 'documentation' | 'security' | 'network' | 'sales' | 'accounting' | 'crm' | 'productivity' | 'email-security' | 'marketplace';

export const VENDOR_CATEGORIES: { slug: VendorCategory; label: string }[] = [
  { slug: 'rmm', label: 'Remote Monitoring & Management' },
  { slug: 'psa', label: 'Professional Services Automation' },
  { slug: 'documentation', label: 'IT Documentation' },
  { slug: 'security', label: 'Security' },
  { slug: 'network', label: 'Network Monitoring & Security' },
  { slug: 'sales', label: 'Sales & Distribution' },
  { slug: 'accounting', label: 'Accounting & Finance' },
  { slug: 'crm', label: 'CRM' },
  { slug: 'productivity', label: 'Productivity' },
  { slug: 'email-security', label: 'Email Security & Awareness' },
  { slug: 'marketplace', label: 'Marketplace' },
];

export interface VendorConfig {
  name: string;
  slug: string;
  category: VendorCategory;
  containerUrl: string;
  fields: VendorField[];
  headerMapping: Record<string, string>;
  /** Optional: build headers from raw credentials when simple 1:1 mapping isn't enough (e.g. base64 encoding multiple fields). Overrides headerMapping when present. */
  buildHeaders?: (creds: Record<string, string>) => Record<string, string>;
  docsUrl: string;
  validate?: (creds: Record<string, string>) => Promise<ValidationResult>;
  /** If set, this vendor uses OAuth 2.0 Authorization Code flow instead of manual credential entry. */
  oauthConfig?: OAuthVendorConfig;
  /**
   * Path appended to containerUrl when proxying MCP requests. Defaults to '/mcp' (Streamable HTTP).
   * Set to '/sse' for vendors that only expose SSE transport.
   */
  mcpPath?: string;
}

export const VENDORS: Record<string, VendorConfig> = {
  'datto-rmm': {
    name: 'Datto RMM',
    slug: 'datto-rmm',
    category: 'rmm',
    containerUrl: 'http://datto-rmm-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true },
      { key: 'apiSecret', label: 'API Secret', required: true, secret: true },
      {
        key: 'platform',
        label: 'Platform',
        required: true,
        options: ['concord', 'pinotage', 'merlot', 'vidal', 'zinfandel'],
      },
    ],
    headerMapping: {
      apiKey: 'X-Datto-API-Key',
      apiSecret: 'X-Datto-API-Secret',
      platform: 'X-Datto-Platform',
    },
    docsUrl: 'https://rmm.datto.com/help/en/Content/2SETUP/APIv2.htm',
    async validate(creds) {
      const url = `https://${creds.platform}-api.centrastage.net/auth/oauth/token`;
      const basicAuth = Buffer.from('public-client:public').toString('base64');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: 'password',
          username: creds.apiKey,
          password: creds.apiSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: `Invalid API key/secret or wrong platform region. ${body}`.trim() };
        }
        return { valid: false, error: `Datto RMM returned HTTP ${res.status}: ${body}`.trim() };
      }
      return { valid: true };
    },
  },

  domotz: {
    name: 'Domotz',
    slug: 'domotz',
    category: 'network',
    containerUrl: 'http://domotz-mcp:8080',
    docsUrl: 'https://portal.domotz.com/developers/',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        required: true,
        secret: true,
      },
      {
        key: 'region',
        label: 'Region',
        required: false,
        options: ['us-east-1', 'eu-central-1'],
      },
    ],
    headerMapping: {
      apiKey: 'X-Domotz-API-Key',
      region: 'X-Domotz-Region',
    },
    async validate(creds) {
      const host =
        creds.region === 'eu-central-1'
          ? 'api-eu-central-1-cell-1.domotz.com'
          : 'api-us-east-1-cell-1.domotz.com';
      const res = await fetch(`https://${host}/public-api/v1/user`, {
        headers: { 'X-Api-Key': creds.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid API key.' };
      return { valid: false, error: `Domotz returned HTTP ${res.status}. Check your region selection.` };
    },
  },

  itglue: {
    name: 'IT Glue',
    slug: 'itglue',
    category: 'documentation',
    containerUrl: 'http://itglue-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
    ],
    headerMapping: {
      apiKey: 'X-ITGlue-API-Key',
    },
    docsUrl: 'https://api.itglue.com/developer/',
    async validate(creds) {
      const res = await fetch('https://api.itglue.com/organizations?page[size]=1', {
        headers: { 'x-api-key': creds.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid IT Glue API key.' };
        }
        return { valid: false, error: `IT Glue returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  autotask: {
    name: 'Autotask PSA',
    slug: 'autotask',
    category: 'psa',
    containerUrl: 'http://autotask-mcp:8080',
    fields: [
      { key: 'username', label: 'Username', required: true },
      { key: 'secret', label: 'Secret', required: true, secret: true },
      {
        key: 'integrationCode',
        label: 'Integration Code',
        required: true,
      },
    ],
    headerMapping: {
      username: 'X-Api-Key',
      secret: 'X-Api-Secret',
      integrationCode: 'X-Integration-Code',
    },
    docsUrl: 'https://ww1.autotask.net/help/DeveloperHelp/Content/APIs/REST/REST_API_Home.htm',
    async validate(creds) {
      const url = `https://webservices2.autotask.net/ATServicesRest/V1.0/zoneInformation?user=${encodeURIComponent(creds.username)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return { valid: false, error: `Autotask zone lookup failed (HTTP ${res.status}). Check your username.` };
      }
      const data = await res.json() as { url?: string; errorMessage?: string };
      if (data.errorMessage) {
        return { valid: false, error: `Autotask: ${data.errorMessage}` };
      }
      if (!data.url) {
        return { valid: false, error: 'Autotask returned no zone URL. Verify your username.' };
      }
      return { valid: true };
    },
  },

  syncro: {
    name: 'Syncro',
    slug: 'syncro',
    category: 'rmm',
    containerUrl: 'http://syncro-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      {
        key: 'subdomain',
        label: 'Subdomain',
        required: false,
        placeholder: 'yourcompany',
      },
    ],
    headerMapping: {
      apiKey: 'X-Syncro-API-Key',
      subdomain: 'X-Syncro-Subdomain',
    },
    docsUrl: 'https://api-docs.syncromsp.com/',
    async validate(creds) {
      const subdomain = creds.subdomain || 'app';
      const url = `https://${subdomain}.syncromsp.com/api/v1/contacts?api_key=${encodeURIComponent(creds.apiKey)}&limit=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Syncro API key or subdomain.' };
        }
        return { valid: false, error: `Syncro returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  atera: {
    name: 'Atera',
    slug: 'atera',
    category: 'rmm',
    containerUrl: 'http://atera-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
    ],
    headerMapping: {
      apiKey: 'X-Atera-API-Key',
    },
    docsUrl: 'https://app.atera.com/apidocs',
    async validate(creds) {
      const res = await fetch('https://app.atera.com/api/v3/agents', {
        headers: { 'X-API-KEY': creds.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Atera API key.' };
        }
        return { valid: false, error: `Atera returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  superops: {
    name: 'SuperOps',
    slug: 'superops',
    category: 'rmm',
    containerUrl: 'http://superops-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
      {
        key: 'subdomain',
        label: 'Subdomain',
        required: true,
        placeholder: 'yourcompany',
      },
    ],
    headerMapping: {
      apiToken: 'X-SuperOps-API-Token',
      subdomain: 'X-SuperOps-Subdomain',
    },
    docsUrl: 'https://developer.superops.ai/',
    async validate(creds) {
      const res = await fetch('https://api.superops.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiToken}`,
          CustomerSubDomain: creds.subdomain,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid SuperOps API token or subdomain.' };
        }
        return { valid: false, error: `SuperOps returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  halopsa: {
    name: 'HaloPSA',
    slug: 'halopsa',
    category: 'psa',
    containerUrl: 'http://halopsa-mcp:8080',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        required: true,
        secret: true,
      },
      { key: 'tenant', label: 'Tenant', required: true },
    ],
    headerMapping: {
      clientId: 'X-Halo-Client-ID',
      clientSecret: 'X-Halo-Client-Secret',
      tenant: 'X-Halo-Tenant',
    },
    docsUrl: 'https://halopsa.com/apidoc/',
    async validate(creds) {
      const url = `https://${creds.tenant}.halopsa.com/auth/token`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: 'all',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: 'Invalid HaloPSA client credentials or tenant name.' };
        }
        return { valid: false, error: `HaloPSA returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  'connectwise-psa': {
    name: 'ConnectWise PSA',
    slug: 'connectwise-psa',
    category: 'psa',
    containerUrl: 'http://connectwise-psa-mcp:8080',
    fields: [
      { key: 'companyId', label: 'Company ID', required: true },
      { key: 'publicKey', label: 'Public Key', required: true },
      {
        key: 'privateKey',
        label: 'Private Key',
        required: true,
        secret: true,
      },
      { key: 'clientId', label: 'Client ID', required: true },
    ],
    headerMapping: {
      companyId: 'X-CW-Company-ID',
      publicKey: 'X-CW-Public-Key',
      privateKey: 'X-CW-Private-Key',
      clientId: 'X-CW-Client-ID',
    },
    docsUrl: 'https://developer.connectwise.com/Products/ConnectWise_PSA/REST',
    async validate(creds) {
      const basicAuth = Buffer.from(`${creds.companyId}+${creds.publicKey}:${creds.privateKey}`).toString('base64');
      const res = await fetch('https://api-na.myconnectwise.net/v4_6_release/apis/3.0/company/companies?pageSize=1', {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          clientId: creds.clientId,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid ConnectWise PSA credentials or client ID.' };
        }
        return { valid: false, error: `ConnectWise PSA returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  'connectwise-automate': {
    name: 'ConnectWise Automate',
    slug: 'connectwise-automate',
    category: 'rmm',
    containerUrl: 'http://connectwise-automate-mcp:8080',
    fields: [
      {
        key: 'serverUrl',
        label: 'Server URL',
        required: true,
        placeholder: 'https://automate.example.com',
      },
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'username', label: 'Username', required: true },
      {
        key: 'password',
        label: 'Password',
        required: true,
        secret: true,
      },
    ],
    headerMapping: {
      serverUrl: 'X-CW-Automate-Server-URL',
      clientId: 'X-CW-Automate-Client-ID',
      username: 'X-CW-Automate-Username',
      password: 'X-CW-Automate-Password',
    },
    docsUrl: 'https://developer.connectwise.com/Products/ConnectWise_Automate/Automate_APIs',
    async validate(creds) {
      const serverUrl = creds.serverUrl.replace(/\/+$/, '');
      const res = await fetch(`${serverUrl}/cwa/api/v1/APIToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          UserName: creds.username,
          Password: creds.password,
          ClientId: creds.clientId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: 'Invalid ConnectWise Automate credentials or server URL.' };
        }
        return { valid: false, error: `ConnectWise Automate returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  liongard: {
    name: 'Liongard',
    slug: 'liongard',
    category: 'documentation',
    containerUrl: 'http://liongard-mcp:8080',
    fields: [
      {
        key: 'instance',
        label: 'Instance Name',
        required: true,
        placeholder: 'yourcompany',
      },
      { key: 'accessKeyId', label: 'Access Key ID', required: true },
      { key: 'accessKeySecret', label: 'Access Key Secret', required: true, secret: true },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      const encoded = Buffer.from(`${creds.accessKeyId}:${creds.accessKeySecret}`).toString('base64');
      return {
        'X-Liongard-Instance': creds.instance,
        'X-Liongard-API-Key': encoded,
      };
    },
    docsUrl: 'https://docs.liongard.com/reference/authentication',
    async validate(creds) {
      const encoded = Buffer.from(`${creds.accessKeyId}:${creds.accessKeySecret}`).toString('base64');
      const url = `https://${creds.instance}.app.liongard.com/api/v1/environments?page=1&pageSize=1`;
      const res = await fetch(url, {
        headers: { 'X-ROAR-API-KEY': encoded, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Liongard access key or instance name.' };
        }
        return { valid: false, error: `Liongard returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  hudu: {
    name: 'Hudu',
    slug: 'hudu',
    category: 'documentation',
    containerUrl: 'http://hudu-mcp:8080',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        required: true,
        placeholder: 'https://acme.huducloud.com',
      },
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
    ],
    headerMapping: {
      baseUrl: 'X-Hudu-Base-URL',
      apiKey: 'X-Hudu-API-Key',
    },
    docsUrl: 'https://support.hudu.com/hc/en-us/articles/how-to-use-the-hudu-api',
    async validate(creds) {
      const baseUrl = creds.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/v1/companies?page=1&page_size=1`, {
        headers: { 'x-api-key': creds.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Cloudflare/WAF may block server-to-server requests with 403 + HTML body;
        // distinguish from a real Hudu 401/403 by checking content-type.
        const ct = res.headers.get('content-type') || '';
        if ((res.status === 403) && !ct.includes('application/json')) {
          // Likely a WAF challenge, not a Hudu auth rejection — skip validation
          return { valid: true };
        }
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Hudu API key or base URL.' };
        }
        return { valid: false, error: `Hudu returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  rocketcyber: {
    name: 'RocketCyber',
    slug: 'rocketcyber',
    category: 'security',
    containerUrl: 'http://rocketcyber-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      {
        key: 'region',
        label: 'Region',
        required: false,
        options: ['us', 'eu'],
      },
    ],
    headerMapping: {
      apiKey: 'X-RocketCyber-API-Key',
      region: 'X-RocketCyber-Region',
    },
    docsUrl: 'https://api-doc.rocketcyber.com/',
    async validate(creds) {
      const region = creds.region || 'us';
      const host = region === 'eu' ? 'api-eu.rocketcyber.com' : 'api-us.rocketcyber.com';
      const res = await fetch(`https://${host}/v3/account`, {
        headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid RocketCyber API key or wrong region.' };
        }
        return { valid: false, error: `RocketCyber returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  runzero: {
    name: 'runZero',
    slug: 'runzero',
    category: 'security',
    containerUrl: 'https://console.runzero.com/mcp',
    docsUrl: 'https://www.runzero.com/docs/api/',
    fields: [
      {
        key: 'apiToken',
        label: 'Account API Token',
        required: true,
        secret: true,
        placeholder: 'CT-...',
      },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.apiToken}` };
    },
    async validate(creds) {
      const res = await fetch('https://console.runzero.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${creds.apiToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway', version: '1.0' },
          },
          id: 1,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid API token. Use an Account API token (CT-... prefix) from runZero console.' };
      if (res.status === 403) return { valid: false, error: 'Access denied. Ensure your token has the required permissions.' };
      return { valid: false, error: `runZero returned HTTP ${res.status}` };
    },
  },

  salesbuildr: {
    name: 'SalesBuildr',
    slug: 'salesbuildr',
    category: 'sales',
    containerUrl: 'http://salesbuildr-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
    ],
    headerMapping: {
      apiKey: 'X-SalesBuildr-API-Key',
    },
    docsUrl: 'https://portal.salesbuildr.com/public-api',
    async validate(creds) {
      const res = await fetch('https://portal.salesbuildr.com/public-api/companies?size=1', {
        headers: { 'api-key': creds.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid SalesBuildr API key.' };
        }
        return { valid: false, error: `SalesBuildr returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  pax8: {
    name: 'Pax8',
    slug: 'pax8',
    category: 'sales',
    containerUrl: 'https://mcp.pax8.com/v1',
    fields: [
      {
        key: 'mcpToken',
        label: 'MCP Token',
        required: true,
        secret: true,
        placeholder: 'Generate at app.pax8.com/integrations/mcp',
      },
    ],
    headerMapping: {
      mcpToken: 'x-pax8-mcp-token',
    },
    docsUrl: 'https://devx.pax8.com/docs/mcp-server',
    async validate(creds) {
      // Validate by sending an MCP initialize request to Pax8's hosted server.
      // Pax8 requires Accept: application/json, text/event-stream per StreamableHTTP spec.
      const res = await fetch('https://mcp.pax8.com/v1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'x-pax8-mcp-token': creds.mcpToken,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway-validator', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Pax8 MCP token. Generate one at app.pax8.com/integrations/mcp.' };
        }
        return { valid: false, error: `Pax8 MCP server returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  xero: {
    name: 'Xero',
    slug: 'xero',
    category: 'accounting',
    containerUrl: 'http://xero-mcp:8080',
    fields: [],
    headerMapping: {
      accessToken: 'X-Xero-Access-Token',
      tenantId: 'X-Xero-Tenant-Id',
    },
    docsUrl: 'https://developer.xero.com/documentation/api/accounting/overview',
    oauthConfig: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: ['openid', 'profile', 'email', 'accounting.transactions', 'accounting.contacts', 'accounting.reports.read', 'accounting.settings', 'offline_access'],
      clientIdEnv: 'XERO_CLIENT_ID',
      clientSecretEnv: 'XERO_CLIENT_SECRET',
      extraFields: ['tenantId'],
    },
  },

  qbo: {
    name: 'QuickBooks Online',
    slug: 'qbo',
    category: 'accounting',
    containerUrl: 'http://qbo-mcp:8080',
    fields: [],
    headerMapping: {
      accessToken: 'X-Qbo-Access-Token',
      realmId: 'X-Qbo-Realm-Id',
    },
    docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account',
    oauthConfig: {
      authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
      tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      scopes: ['com.intuit.quickbooks.accounting'],
      clientIdEnv: 'QBO_CLIENT_ID',
      clientSecretEnv: 'QBO_CLIENT_SECRET',
      extraFields: ['realmId'],
    },
  },

  pandadoc: {
    name: 'PandaDoc',
    slug: 'pandadoc',
    category: 'sales',
    containerUrl: 'https://developers.pandadoc.com',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `API-Key ${creds.apiKey}` };
    },
    docsUrl: 'https://developers.pandadoc.com/docs/use-pandadoc-mcp-server',
    async validate(creds) {
      const res = await fetch('https://developers.pandadoc.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `API-Key ${creds.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {},
            clientInfo: { name: 'mcp-gateway-validator', version: '1.0.0' } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403)
          return { valid: false, error: 'Invalid PandaDoc API key.' };
        return { valid: false, error: `PandaDoc returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  hubspot: {
    name: 'HubSpot',
    slug: 'hubspot',
    category: 'crm',
    containerUrl: 'https://mcp.hubspot.com',
    fields: [],
    headerMapping: {
      accessToken: 'Authorization',
    },
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.accessToken}` };
    },
    docsUrl: 'https://developers.hubspot.com/mcp',
    oauthConfig: {
      authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scopes: ['oauth', 'crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'],
      clientIdEnv: 'HUBSPOT_CLIENT_ID',
      clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
    },
  },

  huntress: {
    name: 'Huntress',
    slug: 'huntress',
    category: 'security',
    containerUrl: 'http://huntress-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true },
      { key: 'apiSecret', label: 'API Secret', required: true, secret: true },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    },
    docsUrl: 'https://api.huntress.io/docs',
    async validate(creds) {
      const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
      const res = await fetch('https://api.huntress.io/v1/account', {
        headers: { Authorization: `Basic ${encoded}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Huntress API key or secret.' };
        }
        return { valid: false, error: `Huntress returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  blumira: {
    name: 'Blumira',
    slug: 'blumira',
    category: 'security',
    containerUrl: 'http://blumira-mcp:8080',
    fields: [
      { key: 'jwtToken', label: 'JWT Token', required: true, secret: true },
    ],
    headerMapping: {
      jwtToken: 'Authorization',
    },
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.jwtToken}` };
    },
    docsUrl: 'https://blumira.help/api',
    async validate(creds) {
      const res = await fetch('https://api.blumira.com/public-api/v1/health', {
        headers: { Authorization: `Bearer ${creds.jwtToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Blumira JWT token.' };
        }
        return { valid: false, error: `Blumira returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  sentinelone: {
    name: 'SentinelOne',
    slug: 'sentinelone',
    category: 'security',
    containerUrl: 'http://sentinelone-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
      {
        key: 'consoleUrl',
        label: 'Console URL',
        required: true,
        placeholder: 'https://your-console.sentinelone.net',
      },
    ],
    headerMapping: {
      apiToken: 'X-S1-API-Token',
      consoleUrl: 'X-S1-Console-URL',
    },
    docsUrl: 'https://github.com/Sentinel-One/purple-mcp',
    async validate(creds) {
      const consoleUrl = creds.consoleUrl.replace(/\/+$/, '');
      const res = await fetch(`${consoleUrl}/web/api/v2.1/system/status`, {
        headers: { Authorization: `ApiToken ${creds.apiToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid SentinelOne API token or console URL.' };
        }
        return { valid: false, error: `SentinelOne returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  ninjaone: {
    name: 'NinjaOne',
    slug: 'ninjaone',
    category: 'rmm',
    containerUrl: 'http://ninjaone-mcp:8080',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        required: true,
        secret: true,
      },
      {
        key: 'region',
        label: 'Region',
        required: true,
        options: ['us', 'eu', 'oc'],
      },
    ],
    headerMapping: {
      clientId: 'X-Ninja-Client-ID',
      clientSecret: 'X-Ninja-Client-Secret',
      region: 'X-Ninja-Region',
    },
    docsUrl: 'https://app.ninjarmm.com/apidocs/',
    async validate(creds) {
      const regionHost: Record<string, string> = {
        us: 'app.ninjarmm.com',
        eu: 'eu.ninjarmm.com',
        oc: 'oc.ninjarmm.com',
      };
      const host = regionHost[creds.region] || regionHost.us;
      const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
      const res = await fetch(`https://${host}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'monitoring' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: 'Invalid NinjaOne client credentials or wrong region.' };
        }
        return { valid: false, error: `NinjaOne returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },
  pagerduty: {
    name: 'PagerDuty',
    slug: 'pagerduty',
    category: 'security',
    // EU accounts: set VENDOR_URL_PAGERDUTY=https://mcp.eu.pagerduty.com
    containerUrl: 'https://mcp.pagerduty.com',
    fields: [
      {
        key: 'apiKey',
        label: 'User API Token',
        required: true,
        secret: true,
        placeholder: 'Generate at My Profile → User Settings → API Access',
      },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      // PagerDuty MCP uses the same auth format as the REST API: Token token=<key>
      return { Authorization: `Token token=${creds.apiKey}` };
    },
    docsUrl: 'https://developer.pagerduty.com/docs/mcp-tooling-remote-server',
    async validate(creds) {
      const containerUrl = process.env.VENDOR_URL_PAGERDUTY ?? 'https://mcp.pagerduty.com';
      const res = await fetch(`${containerUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Token token=${creds.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway-validator', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid PagerDuty API token. Generate a User API Token at My Profile → User Settings → API Access.' };
      return { valid: false, error: `PagerDuty MCP server returned HTTP ${res.status}.` };
    },
  },
  betterstack: {
    name: 'BetterStack',
    slug: 'betterstack',
    category: 'network',
    containerUrl: 'https://mcp.betterstack.com',
    fields: [
      {
        key: 'apiToken',
        label: 'API Token',
        required: true,
        secret: true,
        placeholder: 'Generate at Better Stack → API tokens',
      },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.apiToken}` };
    },
    docsUrl: 'https://betterstack.com/docs/getting-started/integrations/mcp/',
    async validate(creds) {
      const res = await fetch('https://mcp.betterstack.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${creds.apiToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'mcp-gateway-validator', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid BetterStack API token. Generate one at Better Stack → API tokens.' };
      return { valid: false, error: `BetterStack MCP server returned HTTP ${res.status}.` };
    },
  },
  m365: {
    name: 'Microsoft 365',
    slug: 'm365',
    category: 'productivity',
    containerUrl: process.env.M365_MCP_URL ?? 'http://m365-mcp:8080',
    fields: [],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.accessToken}` };
    },
    docsUrl: 'https://learn.microsoft.com/en-us/graph/overview',
    oauthConfig: {
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['https://graph.microsoft.com/.default', 'offline_access', 'openid', 'profile'],
      clientIdEnv: 'MICROSOFT_CLIENT_ID',
      clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
      extraFields: ['tenantId'],
    },
  },

  rootly: {
    name: 'Rootly',
    slug: 'rootly',
    category: 'security',
    containerUrl: 'https://mcp.rootly.com',
    fields: [
      {
        key: 'apiToken',
        label: 'API Token',
        required: true,
        secret: true,
        placeholder: 'Generate at Account > Manage API Keys',
      },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.apiToken}` };
    },
    docsUrl: 'https://docs.rootly.com/integrations/mcp-server',
    mcpPath: '/sse',
    async validate(creds) {
      // Rootly exposes SSE transport at /sse — open the stream and check auth
      // then immediately cancel the body to avoid holding the connection open.
      const controller = new AbortController();
      const res = await fetch('https://mcp.rootly.com/sse', {
        headers: { Authorization: `Bearer ${creds.apiToken}` },
        signal: controller.signal,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not reach Rootly MCP server: ${msg}`);
      });
      controller.abort(); // cancel the SSE body stream immediately
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid Rootly API token. Generate one at Account > Manage API Keys.' };
      return { valid: false, error: `Rootly MCP server returned HTTP ${res.status}.` };
    },
  },

  'abnormal-security': {
    name: 'Abnormal Security',
    slug: 'abnormal-security',
    category: 'security',
    containerUrl: 'http://abnormal-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
    ],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.apiToken}` };
    },
    docsUrl: 'https://abnormalsecurity.com/api-documentation',
    async validate(creds) {
      const res = await fetch('https://api.abnormalplatform.com/v1/threats?pageSize=1', {
        headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid Abnormal Security API token. Generate one in the Abnormal portal under Settings > Integrations > API.' };
      return { valid: false, error: `Abnormal Security returned HTTP ${res.status}.` };
    },
  },

  avanan: {
    name: 'Checkpoint Avanan',
    slug: 'avanan',
    category: 'email-security',
    containerUrl: 'http://avanan-mcp:8080',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'secretKey', label: 'API Secret Key', required: true, secret: true },
    ],
    headerMapping: {
      clientId: 'X-Checkpoint-Client-Id',
      secretKey: 'X-Checkpoint-Secret-Key',
    },
    docsUrl: 'https://sc1.checkpoint.com/documents/Harmony_Email_Collaboration/Default.htm',
  },

  proofpoint: {
    name: 'Proofpoint',
    slug: 'proofpoint',
    category: 'email-security',
    containerUrl: 'http://proofpoint-mcp:8080',
    fields: [
      { key: 'servicePrincipal', label: 'Service Principal', required: true },
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      { key: 'clusterUrl', label: 'Cluster URL', required: false, placeholder: 'https://tap-api.proofpoint.com' },
    ],
    headerMapping: {
      servicePrincipal: 'X-Proofpoint-Service-Principal',
      apiKey: 'X-Proofpoint-Api-Key',
      clusterUrl: 'X-Proofpoint-Cluster-Url',
    },
    docsUrl: 'https://help.proofpoint.com/Threat_Insight_Dashboard/API_Documentation',
  },

  knowbe4: {
    name: 'KnowBe4',
    slug: 'knowbe4',
    category: 'email-security',
    containerUrl: 'http://knowbe4-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      {
        key: 'region',
        label: 'Region',
        required: false,
        options: ['us', 'eu', 'uk', 'de', 'ca'],
        placeholder: 'us',
      },
    ],
    headerMapping: {
      apiKey: 'X-Knowbe4-Api-Key',
      region: 'X-Knowbe4-Region',
    },
    docsUrl: 'https://developer.knowbe4.com/',
  },

  sherweb: {
    name: 'Sherweb',
    slug: 'sherweb',
    category: 'marketplace',
    containerUrl: 'http://sherweb-mcp:8080',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
      { key: 'subscriptionKey', label: 'Subscription Key', required: true, secret: true },
    ],
    headerMapping: {
      clientId: 'X-Sherweb-Client-Id',
      clientSecret: 'X-Sherweb-Client-Secret',
      subscriptionKey: 'X-Sherweb-Subscription-Key',
    },
    docsUrl: 'https://developers.sherweb.com/apis',
  },
};

/**
 * Look up vendor config by slug, returns undefined if not found.
 * The containerUrl can be overridden via environment variable:
 *   VENDOR_URL_DATTO_RMM=http://custom-host:8080
 * (slug uppercased, hyphens replaced with underscores, prefixed with VENDOR_URL_)
 */
export function getVendor(slug: string): VendorConfig | undefined {
  const vendor = VENDORS[slug];
  if (!vendor) return undefined;

  const envKey = `VENDOR_URL_${slug.toUpperCase().replace(/-/g, '_')}`;
  const envUrl = process.env[envKey];
  if (envUrl) {
    return { ...vendor, containerUrl: envUrl };
  }

  return vendor;
}

/** Get all vendor slugs */
export function getVendorSlugs(): string[] {
  return Object.keys(VENDORS);
}

/** Get vendor slugs grouped by category, in VENDOR_CATEGORIES display order. */
export function getVendorsByCategory(): { slug: VendorCategory; label: string; vendors: VendorConfig[] }[] {
  return VENDOR_CATEGORIES
    .map((cat) => ({
      ...cat,
      vendors: Object.values(VENDORS).filter((v) => v.category === cat.slug),
    }))
    .filter((cat) => cat.vendors.length > 0);
}

/** Check if a vendor uses OAuth authorization code flow */
export function isOAuthVendor(slug: string): boolean {
  const vendor = VENDORS[slug];
  return vendor?.oauthConfig != null;
}
