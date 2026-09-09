import json

import pytest
from colors_compute import collect, expand
from conftest import fixture
from package_postgres_ha_blue import compute, tools


def recorded():
    return collect(expand([{'count': 3}]), [
        {'node_id': str(i), 'provider': 'digitalocean', 'name': f'deployment-{i}',
         'ip': f'203.0.113.{i+1}', 'vpc_ip': f'10.20.0.{i+11}', 'user': 'root', 'sudoer': 'root'} for i in range(3)], '0')


def converged():
    return fixture({'blue/event': 'create', 'colors-compute/cluster': recorded(),
                    'colors-compute/shared': {'params': {'network_cidr': '10.20.0.0/20'}},
                    'ssh-private-key-path': '/tmp/owned'})


def test_library_fallbacks_keep_application_ordinals_and_stable_node_ids():
    nodes = tools.nodes(fixture())
    assert [node['ordinal'] for node in nodes] == [1, 2, 3]
    assert [node['public-ip'] for node in nodes] == ['192.0.2.10', '192.0.2.11', '192.0.2.12']
    assert [node['name'] for node in nodes] == ['postgres-ha-fixture-0', 'postgres-ha-fixture-1', 'postgres-ha-fixture-2']


def test_live_application_inventory_uses_observed_network_and_node_addresses():
    opts = converged()
    data = tools.data_fn(opts)
    assert data['vpc-cidr'] == '10.20.0.0/20'
    assert [node['private-ip'] for node in data['nodes']] == ['10.20.0.11', '10.20.0.12', '10.20.0.13']
    hosts = json.loads(tools.inventory(opts))['all']['children']['postgres']['hosts']
    assert hosts['deployment-0']['ansible_host'] == '203.0.113.1'
    assert hosts['deployment-0']['node_ordinal'] == 1
    assert tools.ssh_config_hosts(opts)[0]['name'] == opts['profile']


def test_no_live_placeholder_or_missing_private_network_fallback():
    with pytest.raises(ValueError):
        tools.nodes(fixture({'blue/event': 'create'}))
    opts = converged()
    opts['colors-compute/shared'] = {}
    with pytest.raises(ValueError, match='network CIDR'):
        tools.data_fn(opts)
    opts = converged()
    opts['colors-compute/cluster']['nodes'][0]['vpc_ip'] = None
    with pytest.raises(ValueError, match='vpc_ip'):
        tools.nodes(opts)


def test_application_requirements_preserve_network_trust_boundary_and_legacy_guard():
    policy = compute.requirements(fixture())
    assert policy['private'] is True
    assert policy['legacy_state_keys'] == ['postgres-ha-fixture/postgres-ha-infrastructure.tfstate']
    rules = policy['security']['ingress']
    assert {rule['from_port'] for rule in rules if rule['sources'] != ['private']} >= {22, 5432, 5433}
    assert len([rule for rule in rules if rule['sources'] == ['private']]) >= 2


def test_application_templates_keep_backup_restore_heartbeat_and_dns():
    targets = [str(spec['target']) for spec in tools.cluster_specs(converged())]
    for name in ('patroni.yml', 'etcd.conf.yml', 'haproxy.cfg', 'pgbackrest.conf', 'postgres-ha-heartbeat', 'postgres-ha-backup', 'postgres-ha-restore-check', 'inventory.json'):
        assert any(target.endswith('/' + name) or target.endswith('/' + name + '.j2') for target in targets), name
    assert tools.dns_specs(converged())


def test_dns_backend_uses_r2_credentials_without_rebinding_compute_credentials():
    env = tools.credential_env(fixture({'r2-access-key-id': 'test-access', 'r2-secret-access-key': 'test-secret', 'cloudflare-api-token': 'dns-token'}), 'provider-dns')
    assert env['AWS_ACCESS_KEY_ID'] == 'test-access'
    assert env['AWS_SECRET_ACCESS_KEY'] == 'test-secret'
    assert env['CLOUDFLARE_API_TOKEN'] == 'dns-token'
    assert 'DIGITALOCEAN_TOKEN' not in env
