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
  name           = "postgres-ha-fixture"
  node_names     = ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]
  ssh_keys       = [digitalocean_ssh_key.machine.id]
  ssh_sources    = ["203.0.113.10/32"]
  client_sources = ["203.0.113.10/32"]
}

# Looking a VPC up by region returns that region's existing default VPC. This
# deployment neither creates a VPC nor accepts a VPC identifier or CIDR as
# input, so there is no file to edit that could put these nodes on another
# deployment's private network.
data "digitalocean_vpc" "default" {
  region = "ams3"
}

# Keygen mode (workspace standards/ssh-keypair.md): the account key is named
# after the profile and lives in this stack's state, which is what makes its
# ownership decidable. One key for the cluster, not one per node — the
# deployment is one thing, and a key per machine would multiply what the
# standard exists to make singular. Never reference a literal key id here in
# keygen mode.
resource "digitalocean_ssh_key" "machine" {
  name       = "postgres-ha-fixture"
  public_key = trimspace(file("/home/build-placeholder/.ssh/postgres-ha-fixture.pub"))
}

# One resource with a count rather than three addressed resources: the nodes
# are interchangeable by construction — any of them can hold the leader lock —
# and a per-node resource address would invite per-node configuration drift
# that the failover design specifically must not have.
resource "digitalocean_droplet" "node" {
  count    = length(local.node_names)
  name     = local.node_names[count.index]
  region   = "ams3"
  size     = "s-2vcpu-4gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = local.ssh_keys
  tags     = ["colors-postgres-ha", local.name]

  lifecycle {
    prevent_destroy = true
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
    port_range       = "5432"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "5433"
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
    prevent_destroy = true
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
    ssh_key_id   = digitalocean_ssh_key.machine.id
    vpc_id       = data.digitalocean_vpc.default.id
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
