/**
 * SCIM discovery endpoints — static JSON shaped to satisfy Entra ID, which
 * is the strictest of the four supported IdPs. Okta/JumpCloud/Google accept
 * the same payload.
 *
 *   GET /ServiceProviderConfig
 *   GET /ResourceTypes
 *   GET /Schemas
 *
 * Spec: RFC 7643 §6, RFC 7644 §4.
 *
 * Entra refuses to provision if /Schemas does not list both
 *   urn:ietf:params:scim:schemas:core:2.0:User
 *   urn:ietf:params:scim:schemas:core:2.0:Group
 * with the right shape. We list only the subset of attributes we actually
 * map — extras would mislead admins into setting attribute mappings that
 * silently drop on our side.
 */

const NOW = new Date().toISOString();

export const serviceProviderConfig = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://conduit.wyre.ai/docs/scim',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Bearer token issued by Conduit at SCIM connection setup.',
      primary: true,
    },
  ],
  meta: {
    location: '/scim/v2/ServiceProviderConfig',
    resourceType: 'ServiceProviderConfig',
    created: NOW,
    lastModified: NOW,
    version: 'W/"1"',
  },
} as const;

export const resourceTypes = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: 2,
  Resources: [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'User Account',
      schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
      meta: { location: '/scim/v2/ResourceTypes/User', resourceType: 'ResourceType' },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'Group',
      schema: 'urn:ietf:params:scim:schemas:core:2.0:Group',
      meta: { location: '/scim/v2/ResourceTypes/Group', resourceType: 'ResourceType' },
    },
  ],
} as const;

const userSchema = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
  id: 'urn:ietf:params:scim:schemas:core:2.0:User',
  name: 'User',
  description: 'User Account',
  attributes: [
    {
      name: 'userName',
      type: 'string',
      multiValued: false,
      required: true,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    },
    {
      name: 'name',
      type: 'complex',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      subAttributes: [
        { name: 'givenName', type: 'string', multiValued: false, required: false },
        { name: 'familyName', type: 'string', multiValued: false, required: false },
        { name: 'formatted', type: 'string', multiValued: false, required: false },
      ],
    },
    {
      name: 'displayName',
      type: 'string',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
    },
    {
      name: 'emails',
      type: 'complex',
      multiValued: true,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, required: false },
        { name: 'type', type: 'string', multiValued: false, required: false },
        { name: 'primary', type: 'boolean', multiValued: false, required: false },
      ],
    },
    {
      name: 'active',
      type: 'boolean',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
    },
    {
      name: 'externalId',
      type: 'string',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    },
  ],
  meta: { resourceType: 'Schema', location: '/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User' },
} as const;

const groupSchema = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
  id: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  name: 'Group',
  description: 'Group',
  attributes: [
    {
      name: 'displayName',
      type: 'string',
      multiValued: false,
      required: true,
      mutability: 'readWrite',
      returned: 'default',
    },
    {
      name: 'members',
      type: 'complex',
      multiValued: true,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, required: true },
        { name: 'display', type: 'string', multiValued: false, required: false },
      ],
    },
    {
      name: 'externalId',
      type: 'string',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
    },
  ],
  meta: { resourceType: 'Schema', location: '/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group' },
} as const;

export const schemas = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
  totalResults: 2,
  Resources: [userSchema, groupSchema],
} as const;
