{ pkgs, ... }:
{
  # The launcher resolves this package by immutable Git SHA and drives
  # OpenTofu and Ansible. `postgresql` is here for `psql`, which the
  # acceptance checks use to reach the cluster the way a client would.
  languages.clojure.enable = true;
  languages.ansible.enable = true;
  languages.opentofu.enable = true;

  packages = with pkgs; [
    awscli2
    babashka
    curl
    doctl
    jq
    openssh
    postgresql_17
  ];
}
