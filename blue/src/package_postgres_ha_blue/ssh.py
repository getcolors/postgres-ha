"""The deployment's machine keypair, per the workspace SSH Keypair Standard.

The behaviour itself is ONCE's (``package_once_blue.ssh``): keygen mode when
desired state carries no ``digitalocean-ssh-keys``, an ed25519 key named after
the profile in ``~/.ssh``, the create matrix, the DigitalOcean REST preflight,
and a cleanup that runs only after a successful destroy. Reusing it rather
than reimplementing means one standard has one implementation, and a fix
upstream reaches this package when the pin moves.

What is added here is a build-time placeholder. ONCE derives the key paths from
``$HOME`` and does not commit rendered output; this package does commit
goldens, so on ``build`` the rendered paths must not name the operator's home
directory or the goldens would differ per workstation. Real events use the
real paths.
"""

from __future__ import annotations

from pathlib import Path

from package_once_blue import ssh as once_ssh

from . import validate

# The `~/.ssh` stand-in rendered on `build`. Fixed, so a build is
# byte-identical on every workstation and the committed goldens mean something.
build_placeholder_dir = "/home/build-placeholder/.ssh"


def rendered_only(opts: dict) -> bool:
    """Whether this event only renders: a `build`, or any `--dry-run`. The
    standard holds both to the same rule — neither may read, create, or require
    anything under `~/.ssh`, and both must render byte-identically whether or
    not the keypair exists. A dry-run is a create that touches nothing, so
    testing the event alone would let it reach the real key path."""
    return opts.get("blue/event") == "build" or bool(opts.get("blue/dry-run"))


def with_machine_key(opts: dict) -> dict:
    """Fill the template values keygen mode owns. Opt-out opts pass through
    untouched, byte-for-byte as before the standard. The placeholder
    public-key path lands on whichever key the selected provider takes the
    machine key through — ONCE's table, not a literal, so a second provider
    needs no second branch here."""
    if not validate.keygen(opts):
        return opts
    build = rendered_only(opts)
    opts = once_ssh.with_machine_key(opts, not build)
    if not build:
        return opts
    profile = opts.get("profile") or "postgres-ha"
    prv = f"{build_placeholder_dir}/{profile}"
    pub = f"{prv}.pub"
    return {**opts,
            "ssh-private-key-path": prv,
            "ssh-public-key-path": pub,
            once_ssh.machine_key_keys[str(opts.get("provider-compute"))]: pub}


async def ensure_key(opts: dict, state_fn) -> dict:
    """The standard's create matrix and key generation, on a real create."""
    return await once_ssh.ensure_key(opts, state_fn)


def preflight(opts: dict, fetch_fn=once_ssh.fetch_account_keys) -> dict:
    """Refuse a real create when the provider account holds a key named after
    the profile that this deployment's state does not own. ONCE selects the
    REST API and the token by provider: ``do-token`` on DigitalOcean."""
    return once_ssh.preflight(opts, fetch_fn)


def cleanup_step(opts: dict) -> dict:
    """Remove the generated keypair, strictly after the compute destroy
    succeeded."""
    return once_ssh.cleanup_step(opts)


def identity_args(opts: dict) -> list[str]:
    """ssh arguments selecting this deployment's key, empty in opt-out mode."""
    return once_ssh.identity_args(opts)


def private_key_path(opts: dict) -> str:
    return str(Path(once_ssh.private_key_path(opts)).absolute())
