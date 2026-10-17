const test=require('node:test');
const assert=require('node:assert/strict');
const {PlatformService}=require('../src/operations/platform.service');
const {SambaService}=require('../src/samba/samba.service');
const {actions,bulkCreateSchema}=require('../src/samba/contracts');
test('asset-only readers retain activity access with ticket references redacted',async()=>{
  const entries=[{action:'LINK_TICKET',after:{ticketId:'hidden'}},{action:'EDIT',after:{name:'public'}}];
  const platform=new PlatformService({asset:{findUnique:async()=>({id:'asset'})},businessActivity:{findMany:async()=>entries},ticket:{findMany:()=>{throw Error('Must not query hidden tickets')}}});
  const result=await platform.activity({id:'asset-reader',permissions:['asset:read']},'asset','asset');
  assert.deepEqual(result,[{action:'LINK_TICKET',after:{ticketHidden:true}},{action:'EDIT',after:{name:'public'}}]);
});
test('bulk API accepts metadata in profile and rejects accidentally flattened attributes',()=>{
  const row={name:'review',display_name:'Review',password:'Only-For-Test!234'};
  assert(bulkCreateSchema.safeParse({rows:[{...row,profile:{department:'Sales',email:'review@example.test'}}]}).success);
  assert(!bulkCreateSchema.safeParse({rows:[{...row,department:'Sales'}]}).success);
});
test('recycle settings use audited commands and do not hide service failures',async()=>{
  const service=new SambaService({});let recorded;
  service.command=async(user,command)=>{recorded={user,command};return{state:'queued'}};
  const result=await service.setRecycle({id:'admin'}, {retention_days:7});
  assert.equal(recorded.command.action,'recycle.configure');assert.equal(result.state,'queued');
  assert.deepEqual(recorded.command.args,{retention_days:7});
  assert(!actions['recycle.configure'].safeParse({retention_days:0}).success);
  await assert.rejects(()=>service.setRecycle({id:'admin'},{retention_days:1.5}));
  const before=process.env.SAMBA_ENABLED;process.env.SAMBA_ENABLED='true';
  try {service.agent=async()=>{throw Error('Disconnected')};await assert.rejects(()=>service.recycle(),/Disconnected/);}
  finally {if(before===undefined)delete process.env.SAMBA_ENABLED;else process.env.SAMBA_ENABLED=before;}
});
