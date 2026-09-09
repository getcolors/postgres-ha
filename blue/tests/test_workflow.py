from pathlib import Path

from blue.workflow import run
from conftest import fixture, optout
from package_postgres_ha_blue import tools, validate, workflow
from test_tools import recorded


def test_lifecycle_order_preserves_application_cleanup_before_compute():
    assert workflow.wire_fn('postgres-ha/start', {'blue/event': 'create'})[1] == 'postgres-ha/infrastructure'
    assert workflow.wire_fn('postgres-ha/dns', {'blue/event': 'delete'})[1] == 'postgres-ha/infrastructure'
    assert workflow.wire_fn('postgres-ha/infrastructure', {'blue/event': 'delete'})[1] == 'postgres-ha/generated-cleanup'


async def test_native_build_renders_shared_nodes_and_every_application_stage(tmp_path):
    result = await run(workflow.postgres_ha_workflow, fixture({'blue/event': 'build', 'workdir': str(tmp_path)}))
    assert result['blue/exit'] == 0, result.get('blue/err')
    assert list(tmp_path.rglob('inventory.json'))
    assert list(tmp_path.rglob('pgbackrest.conf.j2'))
    assert list(tmp_path.rglob('*.tf.json'))
    assert not (Path(tools.tool_dir(result, tools.infrastructure_tool)) / 'main.tf').exists()


async def test_adapter_delegates_compute_and_adopts_shared_metadata(monkeypatch):
    seen = []
    async def operation(opts, topology, requirements):
        seen.append((topology, requirements))
        return {'status': 'ready', 'cluster': recorded(), 'shared': {'params': {'network_cidr': '10.20.0.0/20'}}, 'key': {'private_key_path': '/tmp/owned'}}
    monkeypatch.setattr(tools, 'orchestrate', operation)
    result = await tools.infrastructure_step(fixture({'blue/event': 'create'}))
    assert result['blue/exit'] == 0 and result['ssh-private-key-path'] == '/tmp/owned'
    assert tools.data_fn(result)['vpc-cidr'] == '10.20.0.0/20'
    assert seen[0][0] == [{'role': None, 'count': 3}]


async def test_delete_read_refuses_legacy_and_unreadable_state(monkeypatch):
    async def read(opts): return {'status': 'error'}
    monkeypatch.setattr(tools, 'read_deployment', read)
    result = await tools.load_infrastructure_step(fixture({'blue/event': 'delete', 'compute-prevent-destroy': False}))
    assert result['blue/exit'] == 1 and 'explicit migration' in result['blue/err']
    async def retired(opts): return {'status': 'destroyed'}
    monkeypatch.setattr(tools, 'read_deployment', retired)
    assert (await tools.load_infrastructure_step(fixture({'blue/event': 'delete'})))['postgres-ha/already-destroyed'] is True


async def test_protected_delete_stops_before_inspection(monkeypatch):
    monkeypatch.setattr(validate, 'secret_errors', lambda *_: [])
    result = await workflow.start_step(fixture({'blue/event': 'delete'}), {})
    assert result['blue/exit'] != 0


async def test_native_optout_build_keeps_external_identity_reference(tmp_path):
    result = await run(workflow.postgres_ha_workflow, optout({'blue/event': 'build', 'workdir': str(tmp_path)}))
    assert result['blue/exit'] == 0, result.get('blue/err')
    assert result['ssh-private-key-path']
