terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# The API token arrives as CLOUDFLARE_API_TOKEN in the process environment.
provider "cloudflare" {}

data "cloudflare_zone" "domain" {
  filter = {
    name = "<{ cloudflare-zone }>"
  }
}

# One A record per node, all carrying the same client endpoint name.
#
# This is the client-endpoint mechanism, and it is deliberately static: the
# record set does not change when the cluster fails over. Each node runs an
# HAProxy that forwards to whichever member currently holds the leader lock, so
# every address in this set is a correct answer as long as its node is up, and
# libpq tries the resolved addresses in turn until one connects. Nothing has to
# call a DNS or cloud API at the moment the cluster is degraded, which is
# exactly when such a call is least likely to succeed.
#
# The records must not be proxied: Cloudflare's proxy speaks HTTP, not the
# PostgreSQL wire protocol, and desired-state validation refuses `true` here.
<% for node in nodes %>
resource "cloudflare_dns_record" "endpoint_<{ node.ordinal }>" {
  zone_id = data.cloudflare_zone.domain.id
  name    = "<{ cluster-host }>"
  content = "<{ node.public-ip }>"
  type    = "A"
  proxied = <{ cloudflare-proxied }>
  ttl     = <{ cloudflare-record-ttl }>
  comment = "colors postgres-ha <{ node.name }>"
}
<% endfor %>
output "endpoint" {
  value = "<{ cluster-host }>"
}
