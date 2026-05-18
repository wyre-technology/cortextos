---
title: OAuth consent template
description: Copy shown on the Conduit consent screen when a customer user authorizes a vendor OAuth connection.
---

Fork this template to control the words a customer sees when Conduit
asks them to authorize a vendor OAuth connection (for example Xero,
QuickBooks, HubSpot, Microsoft 365). Tokens are interpolated at render
time; see [white-label setup](/docs/guides/white-label-setup/) for the full
token list.

## Heading

```
Connect {{vendor.name}} to {{msp.name}}
```

## Body

```markdown
{{msp.name}} is setting up a connection between {{customer.name}}'s
{{vendor.name}} account and Conduit, the platform {{msp.name}} uses to
connect AI assistants to your business tools.

### What this allows

- {{msp.name}} technicians and the AI assistants they operate can call
  {{vendor.name}} on {{customer.name}}'s behalf.
- Every call is recorded in the Conduit audit log, visible to
  {{customer.name}} administrators.
- Conduit never stores raw OAuth access tokens in the clear; refresh
  tokens are encrypted at rest.

### What this does not allow

- Any access outside the scopes you approve on {{vendor.name}}'s
  consent screen on the next page.
- Direct access by {{msp.name}} staff — all access is mediated by
  Conduit and audit-logged.

### Before you continue

- Sign in with a {{vendor.name}} account that has the rights you
  intend to delegate.
- Review the scopes on {{vendor.name}}'s consent page carefully.
- You can revoke this connection at any time from Conduit or from
  {{vendor.name}} directly.
```

## Call to action

```
[Continue to {{vendor.name}}]   [Cancel]
```

## Footer

```markdown
Questions? Contact {{msp.name}} support at {{msp.supportEmail}}.
```

## Notes for template authors

- Do not soften "What this allows" — the block is a regulatory and
  transparency requirement, not marketing copy.
- Keep body copy under ~160 words. Longer text is ignored by users
  and dilutes the consent signal.
- `{{vendor.name}}` appears four times by design. Do not replace with
  pronouns — the specificity is what makes the consent informed.
