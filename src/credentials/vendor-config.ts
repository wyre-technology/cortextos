import { validateVendorBaseUrl } from './safe-fetch.js';

/**
 * Reject any user-supplied URL that points to private IPs / loopback / cloud
 * metadata endpoints before a vendor `validate()` calls fetch() on it.
 * Without this, the gateway becomes an SSRF probe for anything behind its
 * outbound NAT — see src/credentials/safe-fetch.ts for the exact rules.
 */
async function rejectIfUnsafeBaseUrl(
  url: string,
  label: string,
): Promise<{ valid: false; error: string } | null> {
  try {
    await validateVendorBaseUrl(url);
    return null;
  } catch (e) {
    return { valid: false, error: `${label} rejected: ${(e as Error).message}` };
  }
}

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

export type VendorCategory = 'rmm' | 'psa' | 'documentation' | 'security' | 'bcdr' | 'network' | 'sales' | 'accounting' | 'crm' | 'productivity' | 'email-security' | 'marketplace';

export const VENDOR_CATEGORIES: { slug: VendorCategory; label: string }[] = [
  { slug: 'rmm', label: 'Remote Monitoring & Management' },
  { slug: 'psa', label: 'Professional Services Automation' },
  { slug: 'documentation', label: 'IT Documentation' },
  { slug: 'security', label: 'Security' },
  { slug: 'bcdr', label: 'Backup, Continuity & Disaster Recovery' },
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
  /**
   * If set, surfaces a "Preview" badge in the UI for early-access vendors.
   * Does not affect proxy behavior.
   */
  preview?: boolean;
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

  action1: {
    name: 'Action1',
    slug: 'action1',
    category: 'rmm',
    containerUrl: 'http://action1-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, placeholder: 'Client ID from Action1 → Settings → API Credentials' },
      { key: 'secret', label: 'Secret', required: true, secret: true, placeholder: 'Non-recoverable — copy on creation' },
      {
        key: 'region',
        label: 'Region',
        required: true,
        options: ['NorthAmerica', 'Europe', 'AsiaPacific', 'Australia'],
      },
      { key: 'defaultOrgId', label: 'Default Organization ID', required: false, placeholder: 'Optional — for single-tenant use' },
    ],
    headerMapping: {
      apiKey: 'X-Action1-API-Key',
      secret: 'X-Action1-Secret',
      region: 'X-Action1-Region',
      defaultOrgId: 'X-Action1-Default-Org-Id',
    },
    docsUrl: 'https://www.action1.com/api-documentation/',
    async validate(creds) {
      // Action1 uses OAuth 2.0 client_credentials grant. The MCP server itself
      // handles the token exchange + caching at request time; validate here just
      // confirms the credentials can mint a token against the configured region.
      const hosts: Record<string, string> = {
        NorthAmerica: 'app.action1.com',
        Europe: 'app.eu.action1.com',
        AsiaPacific: 'app.ap.action1.com',
        Australia: 'app.au.action1.com',
      };
      const host = hosts[creds.region];
      if (!host) {
        return { valid: false, error: `Unknown Action1 region: ${creds.region}` };
      }
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.apiKey,
        client_secret: creds.secret,
      });
      const res = await fetch(`https://${host}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: 'Invalid Action1 API Key or Secret for the selected region.' };
        }
        return { valid: false, error: `Action1 OAuth token endpoint returned HTTP ${res.status}.` };
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
      const urlError = await rejectIfUnsafeBaseUrl(serverUrl, 'Server URL');
      if (urlError) return urlError;
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
      const urlError = await rejectIfUnsafeBaseUrl(baseUrl, 'Base URL');
      if (urlError) return urlError;
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

  'azure-mcp': {
    name: 'Azure MCP Server',
    slug: 'azure-mcp',
    // Closest available category — the gateway uses 'monitoring', which
    // Conduit's VendorCategory union does not define. Revisit if a cloud /
    // infrastructure category is added.
    category: 'network',
    containerUrl: 'http://azure-mcp:8080',
    fields: [
      { key: 'tenantId', label: 'Azure Tenant ID', required: true, placeholder: 'Directory (tenant) ID of the Entra tenant' },
      { key: 'clientId', label: 'Service Principal Client ID', required: true, placeholder: 'Application (client) ID of the service principal' },
      { key: 'clientSecret', label: 'Service Principal Client Secret', required: true, secret: true, placeholder: 'Client secret value for the service principal' },
    ],
    headerMapping: {
      tenantId: 'X-Azure-Tenant-Id',
      clientId: 'X-Azure-Client-Id',
      clientSecret: 'X-Azure-Client-Secret',
    },
    docsUrl: 'https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/overview',
    async validate(creds) {
      if (!creds.tenantId || !creds.clientId || !creds.clientSecret) {
        return { valid: false, error: 'Tenant ID, Client ID, and Client Secret are all required.' };
      }
      const res = await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: 'client_credentials',
            scope: 'https://management.azure.com/.default',
          }),
          signal: AbortSignal.timeout(10_000),
        },
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not reach Microsoft Entra: ${msg}`);
      });
      if (res.ok) return { valid: true };
      if (res.status >= 500)
        return {
          valid: false,
          error: `Microsoft Entra is unavailable (HTTP ${res.status}). Try again shortly.`,
        };
      // Entra returns 400 for bad client credentials — a real credential rejection.
      return { valid: false, error: 'Azure service principal rejected. Check the tenant ID, client ID, and secret.' };
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

  'microsoft-graph': {
    name: 'Microsoft Graph (Enterprise)',
    slug: 'microsoft-graph',
    category: 'productivity',
    preview: true,
    containerUrl: 'https://mcp.svc.cloud.microsoft',
    mcpPath: '/enterprise',
    fields: [],
    headerMapping: {},
    buildHeaders(creds) {
      return { Authorization: `Bearer ${creds.accessToken}` };
    },
    docsUrl: 'https://learn.microsoft.com/en-us/graph/mcp-server/overview',
    async validate(creds) {
      if (!creds.accessToken) {
        return { valid: false, error: 'Connect with Microsoft to authorize the Graph Enterprise MCP.' };
      }
      const res = await fetch('https://mcp.svc.cloud.microsoft/enterprise', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${creds.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'wyre-gateway-validator', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not reach Microsoft Graph Enterprise MCP: ${msg}`);
      });
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Microsoft authorization expired or insufficient. Reconnect with Microsoft.' };
      if (res.status >= 500)
        return {
          valid: false,
          error: `Microsoft Graph Enterprise MCP is unavailable (HTTP ${res.status}). Try again shortly.`,
        };
      // The Phase 0 spike established the Graph Enterprise MCP is a stateless,
      // POST-only Streamable HTTP server, so a valid `initialize` POST returns
      // 200. But validate() only needs to confirm the credential is accepted
      // (i.e. not auth-rejected) — so any non-auth, non-5xx response is treated
      // as a pass rather than risking a false rejection on a transport quirk.
      return { valid: true };
    },
    oauthConfig: {
      authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      scopes: ['api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default', 'offline_access', 'openid', 'profile'],
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

  blackpoint: {
    name: 'Blackpoint Cyber',
    slug: 'blackpoint',
    category: 'security',
    containerUrl: 'http://blackpoint-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
      {
        key: 'baseUrl',
        label: 'Base URL',
        required: false,
        placeholder: 'https://api.compassone.blackpointcyber.com/v1',
      },
    ],
    headerMapping: {
      apiToken: 'X-Blackpoint-Api-Token',
      baseUrl: 'X-Blackpoint-Base-Url',
    },
    docsUrl: 'https://compassone.blackpointcyber.com/',
    async validate(creds) {
      try {
        const baseUrl = (creds.baseUrl || 'https://api.compassone.blackpointcyber.com/v1').replace(/\/$/, '');
        const urlError = await rejectIfUnsafeBaseUrl(baseUrl, 'Base URL');
        if (urlError) return urlError;
        const res = await fetch(`${baseUrl}/accounts?limit=1`, {
          headers: {
            Authorization: `Bearer ${creds.apiToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Blackpoint Cyber API token.' };
        }
        if (!res.ok) {
          return { valid: false, error: `Blackpoint returned HTTP ${res.status}.` };
        }
        return { valid: true };
      } catch (err) {
        return {
          valid: false,
          error: `Blackpoint validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  cipp: {
    name: 'CIPP',
    slug: 'cipp',
    category: 'productivity',
    containerUrl: 'http://cipp-mcp:8080',
    fields: [
      {
        key: 'baseUrl',
        label: 'CIPP Base URL',
        required: true,
        placeholder: 'https://cippXXXXX.azurewebsites.net',
      },
      {
        key: 'tenantId',
        label: 'Entra Tenant ID',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'clientId',
        label: 'API Client ID',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'clientSecret',
        label: 'API Client Secret',
        required: true,
        secret: true,
      },
    ],
    headerMapping: {
      baseUrl: 'X-Base-Url',
      tenantId: 'X-Tenant-Id',
      clientId: 'X-Client-Id',
      clientSecret: 'X-Client-Secret',
    },
    docsUrl: 'https://github.com/wyre-technology/mcp-gateway/blob/main/docs/vendors/cipp.md',
    async validate(creds) {
      const missing = ['baseUrl', 'tenantId', 'clientId', 'clientSecret'].filter((k) => !creds[k]);
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required CIPP field(s): ${missing.join(', ')}. CIPP's API Client Management issues a client ID + secret — paste those here, not a bearer token.`,
        };
      }

      const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId!)}/oauth2/v2.0/token`;
      const tokenBody = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId!,
        client_secret: creds.clientSecret!,
        scope: `api://${creds.clientId!}/.default`,
      });
      let tokenRes: Response;
      try {
        tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { valid: false, error: `Network error reaching Entra token endpoint: ${msg}` };
      }
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '');
        if (tokenRes.status === 400 || tokenRes.status === 401) {
          return {
            valid: false,
            error: `Invalid CIPP OAuth credentials (Entra HTTP ${tokenRes.status}). Verify tenant ID, client ID, and secret. Details: ${body.slice(0, 300)}`,
          };
        }
        return { valid: false, error: `Entra token endpoint returned HTTP ${tokenRes.status}: ${body.slice(0, 300)}` };
      }
      let token: string | undefined;
      try {
        const parsed = (await tokenRes.json()) as { access_token?: string };
        token = parsed.access_token;
      } catch {
        return { valid: false, error: 'Entra token response was not valid JSON.' };
      }
      if (!token) {
        return { valid: false, error: 'Entra token response did not include an access_token.' };
      }

      const cippBaseUrl = creds.baseUrl!.replace(/\/$/, '');
      const urlError = await rejectIfUnsafeBaseUrl(cippBaseUrl, 'CIPP base URL');
      if (urlError) return urlError;
      const url = `${cippBaseUrl}/api/ListTenants?TenantFilter=allTenants`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) {
        return {
          valid: false,
          error: `CIPP rejected the OAuth-issued token (HTTP ${res.status}). The credentials authenticated against Entra, but CIPP does not recognise this app — check that CIPP's API Client Management has this client ID authorised.`,
        };
      }
      return { valid: false, error: `CIPP returned HTTP ${res.status}. Verify your base URL.` };
    },
  },

  crewhu: {
    name: 'Crewhu',
    slug: 'crewhu',
    category: 'productivity',
    containerUrl: 'http://crewhu-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
    ],
    headerMapping: {
      apiToken: 'X-Crewhu-Api-Token',
    },
    docsUrl: 'https://www.crewhu.com/help-center',
    async validate(creds) {
      try {
        const res = await fetch('https://api.crewhu.com/api/v1/user?step=1&limit=1', {
          headers: {
            X_CREWHU_APITOKEN: creds.apiToken!,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Crewhu API token.' };
        }
        if (!res.ok) {
          return { valid: false, error: `Crewhu returned HTTP ${res.status}.` };
        }
        return { valid: true };
      } catch (err) {
        return {
          valid: false,
          error: `Crewhu validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  'datto-bcdr': {
    name: 'Datto BCDR',
    slug: 'datto-bcdr',
    category: 'bcdr',
    containerUrl: 'http://datto-bcdr-mcp:8080',
    fields: [
      { key: 'publicKey', label: 'Public Key', required: true },
      { key: 'privateKey', label: 'Private Key', required: true, secret: true },
    ],
    headerMapping: {
      publicKey: 'X-Datto-BCDR-Public-Key',
      privateKey: 'X-Datto-BCDR-Private-Key',
    },
    docsUrl: 'https://continuity.datto.com/help/Content/kb/DBMA/KB400000010980.htm',
    async validate(creds) {
      const { createHmac } = await import('node:crypto');
      const path = '/v1/bcdr/device?_perPage=1';
      const ts = Math.floor(Date.now() / 1000).toString();
      const stringToSign = `GET\n${path}\n${ts}\n`;
      const signature = createHmac('sha256', creds.privateKey).update(stringToSign).digest('hex');
      const res = await fetch(`https://api.datto.com${path}`, {
        headers: {
          'X-Datto-API-Key': creds.publicKey,
          'X-Datto-API-Timestamp': ts,
          'X-Datto-API-Signature': signature,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      const body = await res.text().catch(() => '');
      if (res.status === 401) {
        return {
          valid: false,
          error: `Datto BCDR rejected the request (HTTP 401). Common causes: (1) public/private key mismatch, (2) host clock skew >5 minutes. ${body}`.trim(),
        };
      }
      if (res.status === 403) {
        return { valid: false, error: 'Datto BCDR key lacks permission. Verify the key is enabled and not appliance-restricted.' };
      }
      return { valid: false, error: `Datto BCDR returned HTTP ${res.status}: ${body}`.trim() };
    },
  },

  'datto-saas-protection': {
    name: 'Datto SaaS Protection',
    slug: 'datto-saas-protection',
    category: 'bcdr',
    containerUrl: 'http://datto-saas-protection-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      {
        key: 'region',
        label: 'Region',
        required: false,
        options: ['us', 'eu'],
        placeholder: 'us',
      },
    ],
    headerMapping: {
      apiKey: 'X-Datto-SaaS-API-Key',
      region: 'X-Datto-SaaS-Region',
    },
    docsUrl: 'https://saasprotection.datto.com/help/M365/Content/Other_Administrative_Tasks/using-rest-api-saas-protection.htm',
    async validate(creds) {
      const region = creds.region === 'eu' ? 'eu' : 'us';
      const baseUrl = region === 'eu' ? 'https://api.eu.datto.com' : 'https://api.datto.com';
      const res = await fetch(`${baseUrl}/api/v1/clients?limit=1`, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      const body = await res.text().catch(() => '');
      if (res.status === 401) {
        return {
          valid: false,
          error: `SaaS Protection rejected the API key (HTTP 401). The error is generic — common causes: (1) bad key, (2) wrong region (you selected '${region}'). ${body}`.trim(),
        };
      }
      if (res.status === 403) {
        return { valid: false, error: 'SaaS Protection key lacks scope. Verify the key has access to all clients or the targeted client.' };
      }
      return { valid: false, error: `SaaS Protection returned HTTP ${res.status}: ${body}`.trim() };
    },
  },

  'halopsa-official': {
    name: 'HaloPSA (First-Party MCP)',
    slug: 'halopsa-official',
    category: 'psa',
    // NOTE: Upstream uses resolveContainerUrl/buildHeadersAsync to dynamically
    // resolve the per-tenant URL and mint OAuth tokens at request time. Conduit
    // does not yet have those features; this entry is included for parity but
    // will not actually proxy until that plumbing is backported.
    containerUrl: 'https://halopsa.invalid',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
      {
        key: 'tenant',
        label: 'Tenant',
        required: true,
        placeholder: 'subdomain only — e.g. "wyretechnology" for wyretechnology.halopsa.com',
      },
    ],
    headerMapping: {
      clientId: 'X-Halopsa-Client-Id',
      clientSecret: 'X-Halopsa-Client-Secret',
      tenant: 'X-Halopsa-Tenant',
    },
    mcpPath: '/api/mcp',
    docsUrl: 'https://usehalo.com/halopsa/guides/2597',
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
          return { valid: false, error: 'Invalid HaloPSA client credentials or tenant subdomain.' };
        }
        return { valid: false, error: `HaloPSA returned HTTP ${res.status}.` };
      }
      const { access_token } = (await res.json()) as { access_token?: string };
      if (!access_token) {
        return { valid: false, error: 'HaloPSA token response did not include an access_token.' };
      }
      const probe = await fetch(`https://${creds.tenant}.halopsa.com/api/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'wyre-gateway-validator', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not reach Halopsa MCP endpoint: ${msg}`);
      });
      if (probe.status === 404) {
        return {
          valid: false,
          error:
            'HaloPSA credentials are valid but the MCP endpoint is disabled. ' +
            'Enable it in Configuration → AI → "Enable the MCP Endpoint" inside HaloPSA.',
        };
      }
      if (!probe.ok) {
        return { valid: false, error: `HaloPSA MCP endpoint returned HTTP ${probe.status}.` };
      }
      return { valid: true };
    },
  },

  immybot: {
    name: 'ImmyBot',
    slug: 'immybot',
    category: 'rmm',
    containerUrl: 'http://immybot-mcp:8080',
    fields: [
      {
        key: 'instanceSubdomain',
        label: 'Instance Subdomain',
        required: true,
        placeholder: 'yourcompany (becomes yourcompany.immy.bot)',
      },
      {
        key: 'tenantId',
        label: 'Entra Tenant ID',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'clientId',
        label: 'App Registration Client ID',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'clientSecret',
        label: 'App Registration Client Secret',
        required: true,
        secret: true,
      },
    ],
    headerMapping: {
      instanceSubdomain: 'X-Immybot-Instance-Subdomain',
      tenantId: 'X-Immybot-Tenant-Id',
      clientId: 'X-Immybot-Client-Id',
      clientSecret: 'X-Immybot-Client-Secret',
    },
    docsUrl: 'https://docs.immy.bot/',
    async validate(creds) {
      const missing = ['instanceSubdomain', 'tenantId', 'clientId', 'clientSecret'].filter((k) => !creds[k]);
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required ImmyBot field(s): ${missing.join(', ')}.`,
        };
      }
      if (!/^[a-zA-Z0-9-]{1,63}$/.test(creds.instanceSubdomain ?? '')) {
        return {
          valid: false,
          error: 'Instance subdomain must contain only alphanumerics and hyphens (DNS-label characters).',
        };
      }

      try {
        const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId!)}/oauth2/v2.0/token`;
        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.clientId!,
            client_secret: creds.clientSecret!,
            scope: `api://${creds.clientId}/.default`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!tokenRes.ok) {
          return {
            valid: false,
            error: `ImmyBot OAuth token exchange failed (HTTP ${tokenRes.status}). Check tenant ID, client ID, and client secret.`,
          };
        }
        const { access_token } = (await tokenRes.json()) as { access_token: string };

        const apiRes = await fetch(
          `https://${creds.instanceSubdomain}.immy.bot/api/v1/tenants?Page=1&PageSize=1`,
          {
            headers: { Authorization: `Bearer ${access_token}` },
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (apiRes.status === 401 || apiRes.status === 403) {
          return {
            valid: false,
            error: 'ImmyBot rejected the OAuth-issued token. Confirm the app registration is authorised in your ImmyBot instance.',
          };
        }
        if (!apiRes.ok) {
          return {
            valid: false,
            error: `ImmyBot returned HTTP ${apiRes.status}. Verify your instance subdomain.`,
          };
        }
        return { valid: true };
      } catch (err) {
        return {
          valid: false,
          error: `ImmyBot validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  'kaseya-bms': {
    name: 'Kaseya BMS',
    slug: 'kaseya-bms',
    category: 'psa',
    containerUrl: 'http://kaseya-bms-mcp:8080',
    fields: [
      {
        key: 'tenantSubdomain',
        label: 'Tenant Subdomain',
        required: true,
        placeholder: 'yourcompany',
      },
      { key: 'apiToken', label: 'API Token', required: false, secret: true },
      { key: 'kaseyaOneToken', label: 'Kaseya One token (alt to API token)', required: false, secret: true },
    ],
    headerMapping: {
      tenantSubdomain: 'X-Kaseya-BMS-Tenant-Subdomain',
      apiToken: 'X-Kaseya-BMS-API-Token',
      kaseyaOneToken: 'X-Kaseya-BMS-K1-Token',
    },
    docsUrl: 'https://help.bms.kaseya.com/help/Content/BMS%20API/bms-api-v2-bms-rest-apis.html',
    async validate(creds) {
      const subdomain = creds.tenantSubdomain;
      if (!subdomain) {
        return { valid: false, error: 'Tenant subdomain is required (e.g. "yourcompany").' };
      }
      if (!/^[a-zA-Z0-9-]{1,63}$/.test(subdomain)) {
        return { valid: false, error: 'Tenant subdomain must contain only alphanumerics and hyphens (DNS-label characters).' };
      }
      const hasK1 = !!creds.kaseyaOneToken;
      const hasApiToken = !!creds.apiToken;
      if (!hasK1 && !hasApiToken) {
        return { valid: false, error: 'Provide either an API token or a Kaseya One token.' };
      }
      const token = hasK1 ? creds.kaseyaOneToken : creds.apiToken;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (!hasK1) headers['X-Tenant'] = subdomain;
      const url = `https://${subdomain}.bms.kaseya.com/api/v2/service/tickets?$top=1`;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return { valid: true };
        if (res.status === 401) return { valid: false, error: 'BMS rejected the token. Verify the credential and tenant subdomain.' };
        if (res.status === 404) return { valid: false, error: 'BMS endpoint not found. Verify tenant subdomain spelling.' };
        return { valid: false, error: `BMS returned HTTP ${res.status}.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { valid: false, error: `Failed to reach BMS tenant: ${msg}` };
      }
    },
  },

  'kaseya-vsa': {
    name: 'Kaseya VSA',
    slug: 'kaseya-vsa',
    category: 'rmm',
    containerUrl: 'http://kaseya-vsa-mcp:8080',
    fields: [
      {
        key: 'tenantUrl',
        label: 'Tenant URL',
        required: true,
        placeholder: 'https://vsa.example.com/api/v1.0',
      },
      { key: 'username', label: 'Username', required: false },
      { key: 'password', label: 'Password', required: false, secret: true },
      { key: 'kaseyaOneToken', label: 'Kaseya One token (alt to username/password)', required: false, secret: true },
    ],
    headerMapping: {
      tenantUrl: 'X-Kaseya-VSA-Tenant-Url',
      username: 'X-Kaseya-VSA-Username',
      password: 'X-Kaseya-VSA-Password',
      kaseyaOneToken: 'X-Kaseya-VSA-K1-Token',
    },
    docsUrl: 'https://help.vsa10.kaseya.com/',
    async validate(creds) {
      const baseUrl = creds.tenantUrl?.replace(/\/+$/, '');
      if (!baseUrl) {
        return { valid: false, error: 'Tenant URL is required (e.g. https://vsa.example.com/api/v1.0).' };
      }
      const urlError = await rejectIfUnsafeBaseUrl(baseUrl, 'Tenant URL');
      if (urlError) return urlError;
      const hasK1 = !!creds.kaseyaOneToken;
      const hasLocal = !!(creds.username && creds.password);
      if (!hasK1 && !hasLocal) {
        return { valid: false, error: 'Provide either Kaseya One token, or username + password.' };
      }
      try {
        if (hasK1) {
          const res = await fetch(`${baseUrl}/auth/sso`, {
            headers: { Authorization: `Bearer ${creds.kaseyaOneToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) return { valid: true };
          if (res.status === 401) return { valid: false, error: 'Kaseya One token rejected. Verify the token and tenant URL.' };
          return { valid: false, error: `VSA returned HTTP ${res.status} on /auth/sso.` };
        }
        const { createHash, randomBytes } = await import('node:crypto');
        const rand = randomBytes(10).toString('hex');
        const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
        const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
        const rawSHA256 = sha256(creds.password + creds.username);
        const rawSHA1 = sha1(creds.password + creds.username);
        const pass2 = sha256(rawSHA256 + rand);
        const pass1 = sha1(rawSHA1 + rand);
        const auth = `Basic user=${creds.username},pass2=${pass2},pass1=${pass1},rpass2=${rawSHA256},rpass1=${rawSHA1},rand2=${rand}`;
        const res = await fetch(`${baseUrl}/auth`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { valid: true };
        if (res.status === 401) return { valid: false, error: 'VSA rejected the credentials. Verify username + password.' };
        if (res.status === 404) return { valid: false, error: 'VSA /auth endpoint not found. Is the tenant URL correct (must include /api/v1.0)?' };
        return { valid: false, error: `VSA returned HTTP ${res.status} on /auth.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { valid: false, error: `Failed to reach VSA tenant: ${msg}` };
      }
    },
  },

  spanning: {
    name: 'Spanning',
    slug: 'spanning',
    category: 'bcdr',
    containerUrl: 'http://spanning-mcp:8080',
    fields: [
      {
        key: 'platform',
        label: 'Platform',
        required: true,
        options: ['m365', 'gws', 'salesforce'],
      },
      { key: 'adminEmail', label: 'Admin Email', required: true },
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
    ],
    headerMapping: {
      platform: 'X-Spanning-Platform',
      adminEmail: 'X-Spanning-Admin-Email',
      apiToken: 'X-Spanning-API-Token',
    },
    docsUrl: 'https://www.spanning.com/support/api-documentation/',
    async validate(creds) {
      const platform = creds.platform;
      const baseUrls: Record<string, string> = {
        m365: 'https://o365-api.spanningbackup.com',
        gws: 'https://api.spanningbackup.com',
        salesforce: 'https://salesforce-api.spanningbackup.com',
      };
      const baseUrl = baseUrls[platform];
      if (!baseUrl) {
        return { valid: false, error: `Invalid platform '${platform}'. Pick m365, gws, or salesforce.` };
      }
      const path = '/external/license';
      const res = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.adminEmail}:${creds.apiToken}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) {
        return {
          valid: false,
          error: `Spanning rejected the credentials (HTTP 401). The admin email and API token are pair-bound — verify both fields together. You selected platform '${platform}'.`,
        };
      }
      if (res.status === 403) {
        return { valid: false, error: `Spanning token lacks scope on platform '${platform}'.` };
      }
      const body = await res.text().catch(() => '');
      return { valid: false, error: `Spanning returned HTTP ${res.status}: ${body}`.trim() };
    },
  },

  threatlocker: {
    name: 'ThreatLocker',
    slug: 'threatlocker',
    category: 'security',
    containerUrl: 'http://threatlocker-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true },
      { key: 'organizationId', label: 'Organization ID', required: false, placeholder: 'Leave blank for primary org' },
    ],
    headerMapping: {
      apiKey: 'X-Threatlocker-Api-Key',
      organizationId: 'X-Threatlocker-Organization-Id',
    },
    docsUrl: 'https://docs.threatlocker.com/',
    async validate(creds) {
      try {
        const headers: Record<string, string> = {
          'Authorization': creds.apiKey,
          'Accept': 'application/json',
        };
        if (creds.organizationId) {
          headers['OrganizationId'] = creds.organizationId;
        }
        const res = await fetch('https://portalapi.g.threatlocker.com/portalapi/ApprovalRequest/ApprovalRequestGetCount', {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { valid: false, error: 'Invalid ThreatLocker API key.' };
          }
          return { valid: false, error: `ThreatLocker returned HTTP ${res.status}.` };
        }
        return { valid: true };
      } catch (err) {
        return {
          valid: false,
          error: `ThreatLocker validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  timezest: {
    name: 'TimeZest',
    slug: 'timezest',
    category: 'productivity',
    containerUrl: 'http://timezest-mcp:8080',
    fields: [
      { key: 'apiToken', label: 'API Token', required: true, secret: true },
    ],
    headerMapping: {
      apiToken: 'X-Timezest-Api-Token',
    },
    docsUrl: 'https://developer.timezest.com/',
    async validate(creds) {
      try {
        const res = await fetch('https://api.timezest.com/v1/agents', {
          headers: {
            Authorization: `Bearer ${creds.apiToken}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid TimeZest API token.' };
        }
        if (!res.ok) {
          return { valid: false, error: `TimeZest returned HTTP ${res.status}.` };
        }
        return { valid: true };
      } catch (err) {
        return {
          valid: false,
          error: `TimeZest validation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  unitrends: {
    name: 'Unitrends',
    slug: 'unitrends',
    category: 'bcdr',
    containerUrl: 'http://unitrends-mcp:8080',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        required: true,
        placeholder: 'https://unitrends.example.com',
      },
      { key: 'username', label: 'Username', required: true },
      { key: 'password', label: 'Password', required: true, secret: true },
      {
        key: 'verifyTls',
        label: 'Verify TLS',
        required: false,
        options: ['true', 'false'],
        placeholder: 'true',
      },
    ],
    headerMapping: {
      baseUrl: 'X-Unitrends-Base-URL',
      username: 'X-Unitrends-Username',
      password: 'X-Unitrends-Password',
      verifyTls: 'X-Unitrends-Verify-TLS',
    },
    docsUrl: 'https://github.com/unitrends/unitrends-api-doc/wiki',
    async validate(creds) {
      const baseUrl = creds.baseUrl?.replace(/\/+$/, '');
      if (!baseUrl) return { valid: false, error: 'Base URL is required (e.g. https://unitrends.example.com).' };
      const urlError = await rejectIfUnsafeBaseUrl(baseUrl, 'Base URL');
      if (urlError) return urlError;
      const verifyTls = creds.verifyTls !== 'false';
      try {
        const fetchOpts: RequestInit & { dispatcher?: unknown } = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: creds.username, password: creds.password }),
          signal: AbortSignal.timeout(15_000),
        };
        if (!verifyTls) {
          const { Agent } = await import('undici');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fetchOpts.dispatcher = new Agent({ connect: { rejectUnauthorized: false } }) as any;
        }
        const res = await fetch(`${baseUrl}/api/login`, fetchOpts);
        if (res.ok) return { valid: true };
        if (res.status === 401) return { valid: false, error: 'Unitrends rejected the username/password.' };
        if (res.status === 503) return { valid: false, error: 'Unitrends appliance is overloaded or in maintenance. Try again in a minute.' };
        return { valid: false, error: `Unitrends returned HTTP ${res.status} on /api/login.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('certificate') || msg.includes('CERT_')) {
          return { valid: false, error: `TLS certificate error reaching ${baseUrl}. Set Verify TLS to false if this is an on-prem appliance with a self-signed cert.` };
        }
        return { valid: false, error: `Failed to reach Unitrends: ${msg}` };
      }
    },
  },

  ironscales: {
    name: 'Ironscales',
    slug: 'ironscales',
    category: 'security',
    containerUrl: 'http://ironscales-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true, placeholder: 'Generate in Ironscales partner portal' },
      { key: 'companyId', label: 'Company ID', required: true, placeholder: 'Ironscales tenant/company identifier' },
    ],
    headerMapping: {
      apiKey: 'X-Ironscales-API-Key',
      companyId: 'X-Ironscales-Company-Id',
    },
    docsUrl: 'https://app.ironscales.com/api/docs',
    async validate(creds) {
      const res = await fetch(`https://app.ironscales.com/appapi/company/${encodeURIComponent(creds.companyId)}/incident/`, {
        headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid Ironscales API key or company ID.' };
        }
        return { valid: false, error: `Ironscales returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  mimecast: {
    name: 'Mimecast',
    slug: 'mimecast',
    category: 'security',
    containerUrl: 'http://mimecast-mcp:8080',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true, placeholder: 'Mimecast API 2.0 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
      {
        key: 'region',
        label: 'Region',
        required: true,
        options: ['us', 'eu', 'de', 'ca', 'za', 'au', 'offshore', 'je'],
      },
    ],
    headerMapping: {
      clientId: 'X-Mimecast-Client-Id',
      clientSecret: 'X-Mimecast-Client-Secret',
      region: 'X-Mimecast-Region',
    },
    docsUrl: 'https://developer.services.mimecast.com/api/2.0',
    async validate(creds) {
      // Mimecast uses OAuth client_credentials at the regional token endpoint.
      // The MCP server itself handles the token exchange + caching at request
      // time; validate here just confirms creds can mint a token at the
      // configured region (same shape as the Action1 entry).
      const hosts: Record<string, string> = {
        us: 'https://api.services.mimecast.com',
        eu: 'https://eu-api.mimecast.com',
        de: 'https://de-api.mimecast.com',
        ca: 'https://ca-api.mimecast.com',
        za: 'https://za-api.mimecast.com',
        au: 'https://au-api.mimecast.com',
        offshore: 'https://offshore-api.mimecast.com',
        je: 'https://je-api.mimecast.com',
      };
      const host = hosts[creds.region];
      if (!host) {
        return { valid: false, error: `Unknown Mimecast region: ${creds.region}` };
      }
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });
      const res = await fetch(`${host}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) {
          return { valid: false, error: 'Invalid Mimecast credentials for the selected region.' };
        }
        return { valid: false, error: `Mimecast OAuth token endpoint returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
  },

  spamtitan: {
    name: 'SpamTitan',
    slug: 'spamtitan',
    category: 'security',
    containerUrl: 'http://spamtitan-mcp:8080',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, secret: true, placeholder: 'Generate in SpamTitan admin console' },
      {
        key: 'baseUrl',
        label: 'Base URL (optional)',
        required: false,
        placeholder: 'https://your-spamtitan.example.com — omit for TitanHQ-hosted',
      },
    ],
    headerMapping: {
      apiKey: 'X-SpamTitan-API-Key',
      baseUrl: 'X-SpamTitan-Base-URL',
    },
    docsUrl: 'https://www.titanhq.com/spamtitan/api-documentation/',
    async validate(creds) {
      // Two-tier vendor: TitanHQ-hosted (no baseUrl needed) or MSP-self-hosted
      // (customer-supplied baseUrl). When customer supplies a baseUrl, run it
      // through the SSRF guard before any fetch — per playbook §SSRF guard rule.
      const baseUrl = (creds.baseUrl?.trim() || 'https://api-spamtitan.titanhq.com').replace(/\/+$/, '');
      if (creds.baseUrl?.trim()) {
        const rejected = await rejectIfUnsafeBaseUrl(baseUrl, 'SpamTitan base URL');
        if (rejected) return rejected;
      }
      const res = await fetch(`${baseUrl}/restapi/v100/quarantine`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { valid: false, error: 'Invalid SpamTitan API key for the configured base URL.' };
        }
        return { valid: false, error: `SpamTitan returned HTTP ${res.status}.` };
      }
      return { valid: true };
    },
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
