import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

test('unit tests cannot write or delete project files',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const permission=(process as typeof process&{permission?:{has:(scope:string,path?:string)=>boolean}}).permission;
  assert.ok(permission,'Run tests through npm test to enable filesystem isolation.');
  assert.equal(permission.has('fs.write',root),false);
  assert.equal(permission.has('fs.write',tmpdir()),true);
  const probe=join(root,'recordings','.unit-test-permission-probe.tmp');
  assert.throws(()=>writeFileSync(probe,'must never be written'),{code:'ERR_ACCESS_DENIED'});
  assert.throws(()=>unlinkSync(probe),{code:'ERR_ACCESS_DENIED'});
});
