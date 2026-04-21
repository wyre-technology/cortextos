---
title: Security notice template
description: Template for security-related customer notifications — credential rotation, suspicious activity, or incident disclosure.
---

Fork this template for security notifications. It is intentionally
plainer than the onboarding and revocation templates: security notices
must be fast to read and hard to confuse with marketing email. Tokens
are interpolated at send time; see
[white-label setup](/guides/white-label-setup/) for the full token
list.

## Subject

```
Security notice from {{msp.name}} regarding {{customer.name}}
```

## Body

```markdown
This is a security notice from {{msp.name}} about your Conduit
environment for {{customer.name}}.

### What happened

{{security.summary}}

### What we have done

{{security.actionsTaken}}

### What you should do

{{security.actionsRequested}}

### Timeline

- Detected: {{security.detectedAt}}
- Action taken: {{security.respondedAt}}
- This notice sent: {{now}}

### Verification

This message is from {{msp.name}} via Conduit. To verify it is
genuine:

1. Sign in to Conduit directly at the URL you normally use — do not
   click a link in this email to sign in.
2. Open the audit log for {{customer.name}} and confirm the events
   described above appear there.
3. If anything does not match, contact {{msp.name}} immediately at
   {{msp.supportEmail}}.

### Questions

Contact {{msp.name}} support:

- Email: {{msp.supportEmail}}
- Portal: {{msp.supportUrl}}
```

## Required context fields

A security notice send **must** pass these extra fields in addition to
the standard tokens:

| Field | Purpose |
|---|---|
| `security.summary` | One-paragraph plain-English description of what happened. |
| `security.actionsTaken` | What the MSP or Conduit did in response. |
| `security.actionsRequested` | What the recipient must do, if anything. |
| `security.detectedAt` | ISO-8601 timestamp of initial detection. |
| `security.respondedAt` | ISO-8601 timestamp of remediation action. |

If any required field is missing the template renderer refuses to
send rather than emit an ambiguous notice.

## Notes for template authors

- Do not include images, logos, or tracking pixels in the body — the
  template renders without them on purpose. Security notices must
  render identically in a minimal text client.
- Do not embed clickable links to sign-in pages. The verification
  section explicitly tells the reader to navigate directly.
- Keep the three "What" sections to one short paragraph each. A
  reader deciding whether to act must be able to read the notice in
  under 60 seconds.
- Avoid jargon. "Credential rotation" is acceptable; "JWT refresh
  token invalidation" is not.
