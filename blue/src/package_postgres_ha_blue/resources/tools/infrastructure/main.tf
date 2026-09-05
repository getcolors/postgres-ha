terraform {
  required_version = ">= 1.8.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

# The token arrives as DIGITALOCEAN_TOKEN in the process environment, so it is
# never written into this file or into OpenTofu's resolved-config cache.
provider "digitalocean" {}

locals {
  name           = "<{ digitalocean-name }>"
  node_names     = <{ node-names-hcl|safe }>
<% if ssh-keygen %>  ssh_keys       = [digitalocean_ssh_key.machine.id]
<% else %>  ssh_keys       = <{ ssh-keys-hcl|safe }>
<% endif %>  ssh_sources    = <{ ssh-sources-hcl|safe }>
  client_sources = <{ client-sources-hcl|safe }>
}

# Looking a VPC up by region returns that region's existing default VPC. This
# deployment neither creates a VPC nor accepts a VPC identifier or CIDR as
# input, so there is no file to edit that could put these nodes on another
# deployment's private network.
data "digitalocean_vpc" "default" {
  region = "<{ digitalocean-region }>"
}

<% if ssh-keygen %># Keygen mode (workspace standards/ssh-keypair.md): the account key is named
# after the profile and lives in this stack's state, which is what makes its
# ownership decidable. One key for the cluster, not one per node — the
# deployment is one thing, and a key per machine would multiply what the
# standard exists to make singular. Never reference a literal key id here in
# keygen mode.
resource "digitalocean_ssh_key" "machine" {
  name       = "<{ profile }>"
  # fileexists: a delete after a completed delete renders this stack with the
  # key files already gone (the keypair cleanup is the last step) and tofu
  # evaluates file() even while destroying an empty state. A real create has
  # generated the file in preflight before this renders, so the placeholder
  # is never applied; the provider validates the value at plan time, which
  # is why it is a well-formed key line and not an empty string, and would
  # reject it at apply if it ever got there.
  public_key = fileexists("<{ ssh-public-key-path }>") ? trimspace(file("<{ ssh-public-key-path }>")) : "ssh-ed25519 PLACEHOLDER managed-by-colors"
}

<% endif %># One resource with a count rather than three addressed resources: the nodes
# are interchangeable by construction — any of them can hold the leader lock —
# and a per-node resource address would invite per-node configuration drift
# that the failover design specifically must not have.
resource "digitalocean_droplet" "node" {
  count    = length(local.node_names)
  name     = local.node_names[count.index]
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = local.ssh_keys
  tags     = ["colors-postgres-ha", local.name]

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

resource "digitalocean_firewall" "cluster" {
  name        = "${local.name}-firewall"
  droplet_ids = digitalocean_droplet.node[*].id

  # Administrative access.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }

  # The client endpoint. Only HAProxy binds these on the public address;
  # PostgreSQL itself is bound to the private VPC address and is unreachable
  # from the internet whatever this rule says.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "<{ haproxy-primary-port }>"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "<{ haproxy-replica-port }>"
    source_addresses = local.client_sources
  }

  # Everything the cluster says to itself — streaming replication, the etcd
  # peer and client ports, and the Patroni REST API — stays inside the VPC.
  # That single boundary is what stands in for the etcd and Patroni API
  # authentication this deployment has no credential to configure, and it is
  # why widening it is a security change rather than a convenience.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.default.ip_range]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.default.ip_range]
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = concat(local.ssh_sources, [data.digitalocean_vpc.default.ip_range])
  }

  # Outbound is open: the nodes fetch packages, the pinned etcd release, and
  # push WAL and backups to Cloudflare R2.
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

output "vpc_id" {
  value = data.digitalocean_vpc.default.id
}

output "vpc_ip_range" {
  value = data.digitalocean_vpc.default.ip_range
}

output "node_public_ips" {
  value = digitalocean_droplet.node[*].ipv4_address
}

output "node_private_ips" {
  value = digitalocean_droplet.node[*].ipv4_address_private
}

# The Compute Cluster Standard's `params`: the one output every later stage
# reads. The outputs above stay so no state output disappears; after adoption
# nothing reads them but the legacy translation.
output "params" {
  value = {
    provider     = "digitalocean"
<% if ssh-keygen %>    ssh_key_id   = digitalocean_ssh_key.machine.id
<% endif %>    vpc_id       = data.digitalocean_vpc.default.id
    vpc_ip_range = data.digitalocean_vpc.default.ip_range
    nodes = [for i, d in digitalocean_droplet.node : {
      index  = i
      role   = null
      name   = d.name
      ip     = d.ipv4_address
      vpc_ip = d.ipv4_address_private
      user   = "root"
      sudoer = "root"
    }]
  }
}
