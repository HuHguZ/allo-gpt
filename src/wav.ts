import {open} from 'node:fs/promises';

export async function wavDuration(file:string,size:number):Promise<number>{
  const handle=await open(file,'r');
  try{
    const header=Buffer.alloc(16);await handle.read(header,0,12,0);
    if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE')throw new Error('Запись не является WAV.');
    let byteRate=0,dataBytes=0;
    for(let offset=12;offset+8<=size;){
      await handle.read(header,0,8,offset);const tag=header.toString('ascii',0,4),length=header.readUInt32LE(4);
      if(offset+8+length>size)throw new Error('WAV повреждён или ещё записывается.');
      if(tag==='fmt '&&length>=16){await handle.read(header,0,16,offset+8);if(header.readUInt16LE(0)!==1||header.readUInt16LE(14)!==16)throw new Error('Поддерживаются телефонные записи PCM WAV 16 bit.');byteRate=header.readUInt32LE(8);}
      if(tag==='data')dataBytes=length;
      if(byteRate&&dataBytes)return dataBytes/byteRate;
      offset+=8+length+(length%2);
    }
    throw new Error('В WAV отсутствует звук или длительность.');
  }finally{await handle.close();}
}
