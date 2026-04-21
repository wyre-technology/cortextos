---
title: Onboarding email template
description: Customer-facing email template sent when an MSP invites a new customer admin to Conduit.
---

Fork this template when you want an MSP-specific onboarding email
tone. Tokens are interpolated at send time; see
[white-label setup](/guides/white-label-setup/) for the full token
list.

## Subject

```
Welcome to {{msp.name}} — finish setting up your Conduit access
```

## Body

```markdown
Hi {{user.name}},

{{msp.name}} uses Conduit to connect AI assistants to the
business tools your team already works with — PSA, RMM, documentation,
security platforms, and more.

You've been invited as an administrator for **{{customer.name}}**.

### Next step

Accept your invitation and sign in:

  {{invite.url}}

This link expires on {{invite.expiresAt}}.

### What happens after you sign in

1. You'll review the vendor connections {{msp.name}} has set up
   on your behalf.
2. You can add your own connections for tools you manage directly.
3. You'll invite the rest of your team and assign their roles.

### Need help?

Reply to this email or contact {{msp.name}} support:

- Email: {{msp.supportEmail}}
- Portal: {{msp.supportUrl}}

Welcome aboard,
The {{msp.name}} team
```

## Notes for template authors

- Keep the subject line under 78 characters so it does not truncate in
  common clients.
- Lead with what the product does, not a logo or hero image — many
  first-contact recipients read email on mobile with images off.
- `{{invite.url}}` must appear exactly once as a full URL; Conduit
  validates the rendered email contains the invite link before send.
- Do not remove the expiration line — it is a security signal and
  reduces support load from stale-link complaints.
