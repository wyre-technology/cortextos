/**
 * Auth0 Action: Pre User Registration — Invite-Only Signup
 *
 * Deploy in Auth0 Dashboard > Actions > Flows > Pre User Registration.
 *
 * Controls who can create an account:
 *   1. @wyretechnology.com emails — always allowed
 *   2. Emails listed in the ALLOWED_EMAILS secret — always allowed
 *   3. Everyone else — denied with a friendly message
 *
 * Secrets (configure in Auth0 Action settings):
 *   ALLOWED_EMAILS — comma-separated list of approved emails
 *                     e.g. "alice@example.com,bob@gmail.com"
 */

exports.onExecutePreUserRegistration = async (event, api) => {
  const email = (event.user.email || '').toLowerCase();
  const domain = email.split('@')[1];

  // 1. Always allow @wyretechnology.com
  const allowedDomains = ['wyretechnology.com'];
  if (allowedDomains.includes(domain)) {
    return; // allow
  }

  // 2. Check the approved email list
  const allowedEmails = (event.secrets.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.includes(email)) {
    return; // allow
  }

  // 3. Block everyone else
  api.access.deny(
    'registration_blocked',
    'Signups are currently invite-only. Join the waitlist at https://mcp.wyretechnology.com/waitlist to get notified when we open up.',
  );
};
