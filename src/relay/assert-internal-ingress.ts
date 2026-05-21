/**
 * Boot-time assertion: the relay's control-plane endpoint MUST be served on
 * an internal-only ACA ingress.
 *
 * PR #2 scope-doc §3 decision (ii) — analyst pre-ack pin + warden scope-stage
 * pre-ack endorsement. Pair with `assertSecureRelayUrl` + `assertNoInbound`
 * to form the three-boot-assert family: every transport-level trust
 * assertion the design depends on gets a parallel boot-assert. The pattern:
 * if a deploy-config setting is load-bearing for security, do not trust the
 * yaml — verify at boot, fail loud.
 *
 * Two-layer falsifier framing (warden pre-ack 2026-05-21):
 *   - DEPLOY-TIME (CI): a CI step asserts the bicep has
 *     `ingress.external === false` for the relay's control-plane endpoint.
 *     Catches bicep-edit drift at deploy time.
 *   - BOOT-TIME (this module): reads the `CONTROL_PLANE_INGRESS` env var
 *     (set by the same bicep that the CI step verifies); refuses to boot
 *     if it is not `internal`. Catches env-var-set-wrong at boot.
 * Together: two falsifiers at different levels, complementary failure modes
 * (bicep-edit drift + env-var-set-wrong).
 *
 * A runtime self-probe (querying ACA's management API for own ingress.external
 * at boot) is overkill at M2 scale and adds RBAC + an API call to the boot
 * path. Revisit only if ACA shows ingress-config drift in practice.
 */

/** The env var the relay's deploy.yml/bicep sets. */
const INGRESS_ENV_VAR = 'CONTROL_PLANE_INGRESS';
/** The only value that permits boot. */
const REQUIRED_VALUE = 'internal';

/**
 * Refuse to boot if the control-plane ingress is not declared `internal`.
 * Call once at relay startup, BEFORE the HTTP control-plane server starts.
 * Same loud-abort posture as `assertNoInbound` + `assertSecureRelayUrl`.
 */
export function assertInternalIngress(): void {
  const value = process.env[INGRESS_ENV_VAR];
  if (value === REQUIRED_VALUE) return;

  if (value === undefined) {
    throw new Error(
      `INTERNAL-INGRESS INVARIANT CANNOT BE ENFORCED — ${INGRESS_ENV_VAR} ` +
        `env var is not set. The relay's control-plane endpoint must be served ` +
        `on an internal-only ACA ingress; the deploy.yml/bicep is responsible ` +
        `for setting ${INGRESS_ENV_VAR}=${REQUIRED_VALUE} alongside ` +
        `ingress.external=false. Refusing to boot.`,
    );
  }

  throw new Error(
    `INTERNAL-INGRESS INVARIANT VIOLATED — ${INGRESS_ENV_VAR}='${value}' ` +
      `(expected '${REQUIRED_VALUE}'). The relay's control-plane endpoint ` +
      `must be served on an internal-only ACA ingress. Refusing to boot.`,
  );
}
