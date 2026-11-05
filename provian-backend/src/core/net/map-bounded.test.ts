import {mapBounded} from './map-bounded';
it('keeps input order with bounded parallel reads',async()=>{
 let active=0,peak=0;
 const result=await mapBounded(Array.from({length:32},(_,i)=>i),4,async i=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,(31-i)%4));active--;return i*2;});
 expect(peak).toBe(4);expect(result).toEqual(Array.from({length:32},(_,i)=>i*2));
});
it('RED a failed batch stops dispatching more reads and drains only those already in flight',async()=>{
 const launched:number[]=[];
 await expect(mapBounded(Array.from({length:500},(_,i)=>i),4,async i=>{launched.push(i);if(i===0)throw new Error('provider down');await new Promise(r=>setTimeout(r,5));return i;})).rejects.toThrow('provider down');
 expect(launched.length).toBeLessThanOrEqual(4);
});
