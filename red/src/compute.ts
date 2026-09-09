import type {Opts} from 'red/workflow';
import {collect,expand,source_cidrs,plan_deployment} from 'colors-compute-red';
export const topology=(opts:Opts)=>[{role:null,count:opts['cluster-nodes']??3}];
export function requirements(opts:Opts){
 const ssh=source_cidrs(opts,'ssh-sources','postgres-ssh-sources'),clients=source_cidrs(opts,'client-sources','postgres-client-sources');
 const ingress:any[]=[{id:'ssh',protocol:'tcp',from_port:22,to_port:22,sources:ssh}];
 for(const [id,port] of [['primary',opts['haproxy-primary-port']??5432],['replica',opts['haproxy-replica-port']??5433]])ingress.push({id,protocol:'tcp',from_port:port,to_port:port,sources:clients});
 for(const protocol of ['tcp','udp'])ingress.push({id:'private-'+protocol,protocol,from_port:1,to_port:65535,sources:['private']});
 ingress.push({id:'ping',protocol:'icmp',from_port:null,to_port:null,sources:[...ssh,'private']});
 return {security:{ingress,egress:'all',private_filter:true},private:true,legacy_state_keys:[opts.profile+'/postgres-ha-infrastructure.tfstate']};
}
export function resolved(opts:Opts):any[]{
 const recorded=opts['colors-compute/cluster'];if(!recorded){if(opts['red/event']==='build'||opts['red/dry-run'])return plan_deployment(opts,topology(opts),requirements(opts)).cluster.nodes;throw Error('compute inventory unavailable');}
 const declarations=opts['red/event']==='delete'?recorded.nodes:expand(topology(opts));
 const requests=declarations.map((node:any)=>({...node,private:true,provider:opts['provider-compute']}));
 return collect(requests,recorded.nodes,requests[0].node_id).nodes;
}
