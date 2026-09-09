"""Application topology and network requirements for the shared compute library."""
from colors_compute import collect, expand
from colors_compute.deployment_request import source_cidrs
from colors_compute.planning import plan_deployment


def topology(opts):
    return [{'role': None, 'count': opts.get('cluster-nodes', 3)}]


def requirements(opts):
    ssh = source_cidrs(opts, 'ssh-sources', 'postgres-ssh-sources')
    clients = source_cidrs(opts, 'client-sources', 'postgres-client-sources')
    ingress = [{'id': 'ssh', 'protocol': 'tcp', 'from_port': 22, 'to_port': 22, 'sources': ssh}]
    for name, port in [('primary', opts.get('haproxy-primary-port', 5432)), ('replica', opts.get('haproxy-replica-port', 5433))]:
        ingress.append({'id': name, 'protocol': 'tcp', 'from_port': port, 'to_port': port, 'sources': clients})
    for protocol in ('tcp', 'udp'):
        ingress.append({'id': 'private-' + protocol, 'protocol': protocol, 'from_port': 1, 'to_port': 65535, 'sources': ['private']})
    ingress.append({'id': 'ping', 'protocol': 'icmp', 'from_port': None, 'to_port': None, 'sources': [*ssh, 'private']})
    return {'security': {'ingress': ingress, 'egress': 'all', 'private_filter': True},
            'private': True, 'legacy_state_keys': [opts['profile'] + '/postgres-ha-infrastructure.tfstate']}


def resolved(opts):
    recorded = opts.get('colors-compute/cluster')
    if recorded is None:
        if opts.get('blue/event') == 'build' or opts.get('blue/dry-run'):
            return plan_deployment(opts, topology(opts), requirements(opts))['cluster']['nodes']
        raise ValueError('compute inventory unavailable')
    declarations = recorded['nodes'] if opts.get('blue/event') == 'delete' else expand(topology(opts))
    requests = [{**node, 'private': True, 'provider': opts['provider-compute']} for node in declarations]
    return collect(requests, recorded['nodes'], requests[0]['node_id'])['nodes']
