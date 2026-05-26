# A remotely-managed Cloudflare Tunnel. The token this produces is stored in
# Key Vault (see Task 4) and consumed by cloudflared.service on the VM.
#
# Schema note (v5.19.1): account_id is optional on this resource (unlike many
# other CF v5 resources). config_src drives remote vs. local management.
resource "cloudflare_zero_trust_tunnel_cloudflared" "cortextos" {
  account_id = var.cloudflare_account_id
  name       = "${local.name_prefix}-tunnel"
  # config_src = "cloudflare" makes this a remotely-managed tunnel whose ingress
  # is defined by the _config resource below.
  config_src = "cloudflare"
}

# Ingress rules: hostname-based routing. Dashboard → local Next.js; ssh hostname
# → local sshd. Final catch-all returns 404 as required by cloudflared.
#
# Schema note (v5.19.1): both `config` and its nested `ingress` are
# nested_type attributes (not block_type), so assignment syntax (=) is
# required. The plan's HCL was already correct on this point.
# `source` is the attribute that mirrors config_src on the tunnel resource;
# `tunnel_id` is required.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cortextos" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id

  config = {
    ingress = [
      {
        hostname = var.dashboard_hostname
        service  = "http://localhost:3000"
      },
      {
        hostname = var.ssh_hostname
        service  = "ssh://localhost:22"
      },
      {
        # Required catch-all rule: no hostname means match everything else.
        service = "http_status:404"
      },
    ]
  }
}

# DNS: both hostnames are CNAMEs to the tunnel's <id>.cfargotunnel.com target,
# proxied through Cloudflare (orange cloud) so Access can gate them.
#
# Schema note (v5.19.1):
# - Content field is `content` (was `value` in v4) — correct.
# - `name` accepts the FQDN; the provider strips the zone suffix internally.
# - `ttl` is required (not optional); value 1 = automatic, valid when proxied.
# - `zone_id` is optional in schema but needed at apply time via var.
resource "cloudflare_dns_record" "dashboard" {
  zone_id = var.cloudflare_zone_id
  name    = var.dashboard_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 = automatic; required when proxied
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.cloudflare_zone_id
  name    = var.ssh_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
