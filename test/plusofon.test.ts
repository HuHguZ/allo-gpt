import test from 'node:test';
import assert from 'node:assert/strict';
import {getOwnNumber} from '../src/plusofon.js';

test('Plusofon reads the configured connected number with authenticated GET only',async t=>{
  t.mock.method(globalThis,'fetch',async(url:unknown,options:any)=>{
    assert.equal(String(url),'https://restapi.plusofon.ru/api/v1/number');assert.equal(options.headers.Authorization,'Bearer private-key');assert.equal(options.headers.Client,'10553');assert.equal(options.redirect,'error');assert.ok(!options.method||options.method==='GET');
    return Response.json({success:true,data:[{number:'79990000001'},{number:'70000000000'}]});
  });
  assert.equal(await getOwnNumber('private-key','+70000000000'),'+70000000000');
});

test('Plusofon rejects failed or malformed responses and never selects another number',async t=>{
  for(const response of [Response.json({message:'private-key'},{status:401}),Response.json({success:true,data:[{number:'79990000001'}]}),Response.json({success:true,data:'invalid'})]){
    t.mock.method(globalThis,'fetch',async()=>response);await assert.rejects(getOwnNumber('private-key','+70000000000'),e=>e instanceof Error&&!e.message.includes('private-key'));t.mock.restoreAll();
  }
});
