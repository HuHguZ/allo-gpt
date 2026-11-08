import {useEffect, useRef, type RefObject} from 'react';
import {measureElement, useStdin, useStdout, type DOMElement} from 'ink';
import type {Readable} from 'node:stream';
import type {WriteStream} from 'node:tty';

export type MouseDrag = (phase:'move'|'end',x:number,y:number)=>void;
export type MouseTargets = Map<string, {node: DOMElement; press: (x:number,y:number) => void;drag?:MouseDrag}>;

// Remove SGR reports before Ink sees them, including reports split across reads.
export function mouseFilter(press: (x: number, y: number) => void, scroll:(direction:number,x:number,y:number)=>void=()=>{},drag:MouseDrag=()=>{}) {
  const mouse = '\u001b[<';
  const pasteStart = '\u001b[200~';
  const pasteEnd = '\u001b[201~';
  let pending = '';
  let pasting = false;
  return {
    push(chunk: string) {
      const data = pending + chunk;
      pending = '';
      let output = '';
      for (let i = 0; i < data.length;) {
        const rest = data.slice(i);
        if (pasting) {
          const end = rest.indexOf(pasteEnd);
          if (end >= 0) {
            output += rest.slice(0, end + pasteEnd.length);
            i += end + pasteEnd.length;
            pasting = false;
            continue;
          }
          let tail = Math.min(rest.length, pasteEnd.length - 1);
          while (tail > 0 && !pasteEnd.startsWith(rest.slice(-tail))) tail--;
          output += tail ? rest.slice(0, -tail) : rest;
          pending = tail ? rest.slice(-tail) : '';
          break;
        }
        if (rest.startsWith(pasteStart)) {
          output += pasteStart;
          i += pasteStart.length;
          pasting = true;
        } else if (mouse.startsWith(rest) || pasteStart.startsWith(rest)) {
          pending = rest;
          break;
        } else if (rest.startsWith(mouse)) {
          const report = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
          if (report) {
            const button = Number(report[1]), x = Number(report[2]), y = Number(report[3]);
            if(x>0&&y>0&&Number.isSafeInteger(x)&&Number.isSafeInteger(y)){
              if(report[4]==='m'){if(button<64&&(button&3)===0)drag('end',x,y);}
              else if(button===0)press(x,y);
              else if(button===32)drag('move',x,y);
              else if(button===64||button===65)scroll(button===64?-1:1,x,y);
            }
            i += report[0].length;
          } else if (/^\u001b\[<[\d;]*$/.test(rest) && rest.length < 64) {
            pending = rest;
            break;
          } else {
            const end = rest.slice(mouse.length).search(/[@-~]/);
            i += end < 0 ? rest.length : mouse.length + end + 1;
          }
        } else {
          output += data[i];
          i++;
        }
      }
      return output;
    },
    flushKey() {
      if (pasting || pending.startsWith(mouse)) return '';
      const key = pending;
      pending = '';
      return key;
    },
  };
}

export function useMouse(root: RefObject<DOMElement | null>, targets: RefObject<MouseTargets>, onEscape: () => void, onScroll?:(direction:number,x:number,y:number)=>void) {
  const {stdin, isRawModeSupported} = useStdin();
  const {stdout} = useStdout();
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const scroll=useRef(onScroll);scroll.current=onScroll;
  const enabled = isRawModeSupported && Boolean((stdout as WriteStream).isTTY);
  useEffect(() => {
    if (!enabled) return;
    const input = stdin as Readable;
    const output = stdout as WriteStream;
    const originalRead = input.read;
    let queued = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draggedId:string|undefined;
    const filter = mouseFilter((x, y) => {
      queueMicrotask(() => {
        if (!root.current || x > output.columns || y > output.rows) return;
        // The CLI uses an alternate screen; overflowing frames scroll off its top.
        const row = y - 1 + Math.max(0, measureElement(root.current).height - (output.rows || 24));
        draggedId=undefined;
        for (const [id,{node, press,drag}] of targets.current) {
          const box = measureElement(node);
          if (x - 1 >= box.x && x - 1 < box.x + box.width && row >= box.y && row < box.y + box.height) {
            draggedId=drag?id:undefined;press(x-1,row);
            break;
          }
        }
      });
    },(direction,x,y)=>queueMicrotask(()=>{
      if(!root.current||x>output.columns||y>output.rows)return;
      scroll.current?.(direction,x-1,y-1+Math.max(0,measureElement(root.current).height-(output.rows||24)));
    }),(phase,x,y)=>queueMicrotask(()=>{
      if(!root.current||!draggedId)return;
      const target=targets.current.get(draggedId);
      if(!target?.drag){draggedId=undefined;return;}
      target.drag(phase,x-1,y-1+Math.max(0,measureElement(root.current).height-(output.rows||24)));
      if(phase==='end')draggedId=undefined;
    }));
    const read = (size?: number) => {
      if (queued) {const value = queued; queued = ''; return value;}
      const chunk = originalRead.call(input, size);
      if (chunk === null) return null;
      clearTimeout(timer);
      const value = filter.push(String(chunk));
      timer = setTimeout(() => {
        queued = filter.flushKey();
        // Dispatch plain Escape here so Ink's own escape timer adds no extra delay.
        if (queued === '\u001b') {queued = ''; escape.current();}
        if (queued) input.emit('readable');
      }, 20);
      return value;
    };
    input.read = read;
    output.write('\u001b[?1002h\u001b[?1006h');
    return () => {
      clearTimeout(timer);
      if (input.read === read) input.read = originalRead;
      if (!output.destroyed && !output.writableEnded) output.write('\u001b[?1002l\u001b[?1006l');
    };
  }, [enabled, stdin, stdout, root, targets]);
}
