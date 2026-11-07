import assert from 'node:assert/strict';
import test from 'node:test';
import {mouseFilter} from '../src/mouse.js';

test('fragmented SGR reports never become keyboard input and only left presses click', () => {
  const clicks: number[][] = [];
  const filter = mouseFilter((x, y) => clicks.push([x, y]));
  let keyboard = '';
  for (const byte of '\u001b[<0;12;9M\u001b[<0;12;9m\u001b[<2;5;4M\u001b[<64;6;6M') keyboard += filter.push(byte);
  assert.equal(keyboard, '');
  assert.deepEqual(clicks, [[12, 9]]);
  assert.equal(filter.push('hello\u001b[A'), 'hello\u001b[A');
  assert.equal(filter.push('\u001b'), '');
  assert.equal(filter.flushKey(), '\u001b');
});

test('SGR-looking text inside a bracketed paste is literal, even with split paste markers', () => {
  const clicks: number[][] = [];
  const filter = mouseFilter((x, y) => clicks.push([x, y]));
  const chunks = ['\u001b[20', '0~pasted\u001b[', '<0;12;9M\u001b[2', '01~', '\u001b[<0;7;8M'];
  const keyboard = chunks.map(chunk => filter.push(chunk)).join('');
  assert.equal(keyboard, '\u001b[200~pasted\u001b[<0;12;9M\u001b[201~');
  assert.deepEqual(clicks, [[7, 8]]);
});

test('fragmented wheel reports scroll once, never click or become typed text',()=>{
  const clicks:number[][]=[],scrolls:number[][]=[];const filter=mouseFilter((x,y)=>clicks.push([x,y]),(direction,x,y)=>scrolls.push([direction,x,y]));
  let typed='';for(const byte of '\u001b[<64;20;12M\u001b[<65;20;12M\u001b[<65;20;12m')typed+=filter.push(byte);
  assert.equal(typed,'');assert.deepEqual(clicks,[]);assert.deepEqual(scrolls,[[-1,20,12],[1,20,12]]);
  assert.equal(filter.push('\u001b[200~\u001b[<64;20;12M\u001b[201~'),'\u001b[200~\u001b[<64;20;12M\u001b[201~');assert.equal(scrolls.length,2);
});
