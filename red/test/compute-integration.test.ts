import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {run} from 'red/workflow';
import {postgresHaWorkflow} from '../src/workflow.ts';
import * as tools from '../src/tools.ts';import * as compute from '../src/compute.ts';
const fixture=()=>({...Bun.YAML.parse(readFileSync(join(import.meta.dir,'../../test/fixtures/colors.yml'),'utf8')) as any,'provider-backend':'r2'});
test('native SDK build renders one shared stack plus three nodes without SSH files',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'postgres-ha-build-'));try{
  const opts={...fixture(),workdir:dir,'red/event':'build'};
  const result=await run(postgresHaWorkflow,opts);expect(result['red/exit']).toBe(0);
  const stages=tools.toolDir(opts,tools.infrastructureTool);expect(readdirSync(join(stages,'nodes')).sort()).toEqual(['0','1','2']);expect(existsSync(join(stages,'shared'))).toBe(true);
  const inventory=JSON.parse(readFileSync(join(tools.toolDir(opts,tools.clusterTool),'inventory.json'),'utf8'));
  expect(Object.keys(inventory.all.children.postgres.hosts)).toHaveLength(3);expect(existsSync(join(dir,'.ssh'))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('inventory readers refuse unknown or partial state and propagate destruction',async()=>{
 const opts={...fixture(),'red/event':'delete'};
 expect((await tools.loadInfrastructureStep(opts,async()=>({status:'error'}) as any))['red/exit']).toBe(1);
 expect((await tools.loadInfrastructureStep(opts,async()=>({status:'destroyed'}) as any))['postgres-ha/already-destroyed']).toBe(true);
 expect(()=>compute.resolved({...opts,'red/event':'create'})).toThrow('unavailable');
 const nodes=[{node_id:'0',role:null,index:0,provider:'digitalocean',name:'first',ip:'192.0.2.1',vpc_ip:'10.0.0.1',user:'root',sudoer:'root'}];
 expect(()=>compute.resolved({...opts,'red/event':'create','colors-compute/cluster':{provider:'digitalocean',nodes}})).toThrow('missing node');
 const policy=compute.requirements(opts).security.ingress;expect(policy.find(r=>r.protocol==='icmp').sources).toContain('private');
});
