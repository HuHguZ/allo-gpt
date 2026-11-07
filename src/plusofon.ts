import {normalizeNumber} from './config.js';

export async function getOwnNumber(token:string,configuredNumber:string):Promise<string>{
  const selected=normalizeNumber(configuredNumber);
  if(!token.trim())throw new Error('Не задан PLUSOFON_API_TOKEN.');
  const response=await fetch('https://restapi.plusofon.ru/api/v1/number',{headers:{Accept:'application/json',Client:'10553',Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();throw new Error(`Плюсофон API: HTTP ${response.status}.`);}
  const body:any=await response.json();
  if(body.success===false||!Array.isArray(body.data))throw new Error('Плюсофон API вернул некорректный список номеров.');
  for(const item of body.data){if(typeof item?.number==='string'&&normalizeNumber(item.number)===selected)return selected;}
  throw new Error('Настроенный входящий номер не найден в списке Плюсофона.');
}
