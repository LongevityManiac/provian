const ensure=(value,reason)=>{if(!value)throw Error('snapshot_historical_'+reason);};

/** Read-only coalescing. Each operator has its own bounded queue. Partial
 * groups flush on the next event-loop turn; sequential callers cannot deadlock. */
export function historicalReadBatcher(requestBatch) {
  const queues=new Map();
  return (operator,method,params)=>new Promise((resolve,reject)=>{
    ensure(['eth_call','eth_getCode'].includes(method),'method');
    let queue=queues.get(operator);
    if(!queue){queue={pending:[],running:false,timer:null};queues.set(operator,queue);}
    queue.pending.push({method,params:structuredClone(params),resolve,reject});
    const flush=async()=>{
      if(queue.running)return;
      queue.running=true;queue.timer=null;
      try{
        while(queue.pending.length){
          const group=queue.pending.splice(0,8);
          try{
            const results=await requestBatch(operator,group.map(({method,params})=>({method,params})));
            ensure(Array.isArray(results)&&results.length===group.length,'batch_size');
            group.forEach((row,index)=>row.resolve(results[index]));
          }catch(error){group.forEach(row=>row.reject(error));}
        }
      }finally{queue.running=false;}
    };
    if(!queue.running&&queue.timer===null)queue.timer=setTimeout(()=>void flush(),0);
  });
}

/** Only exact cutoff state is reusable. Entry and exit authenticate the cutoff
 * afresh through both providers; the scoped capability expires on return.
 * Current signing, simulation, receipt and broadcast ports are never wrapped. */
export function historicalSnapshotScope(port,operators,requestBatch) {
  ensure(Array.isArray(operators)&&operators.length===2&&operators[0]!==operators[1],'operators');
  const request=historicalReadBatcher(requestBatch),caches=operators.map(()=>new Map()),transactions=new Map();
  return async ({block,blockHash},read)=>{
    ensure(Number.isSafeInteger(block)&&block>0&&/^0x[0-9a-f]{64}$/.test(blockHash)
      &&typeof read==='function','checkpoint');
    const finalized=await port.finalizedBlock();
    ensure(finalized.number>=block&&await port.blockHash(block)===blockHash,'checkpoint_changed');
    let active=true;
    const cached=async(method,params)=>{
      ensure(active,'scope_closed');
      const key=JSON.stringify([method,params]);
      const values=await Promise.all(operators.map((operator,index)=>caches[index].has(key)
        ?structuredClone(caches[index].get(key)):request(operator,method,params)));
      ensure(active,'scope_closed');
      ensure(values.every(value=>typeof value==='string'&&/^0x(?:[0-9a-fA-F]{2})*$/.test(value)),'result');
      ensure(values[0]===values[1],'provider_disagreement');
      values.forEach((value,index)=>caches[index].set(key,structuredClone(value)));
      return values[0];
    };
    const scoped={...port,withHistoricalSnapshot:undefined,
      transaction:async hash=>{
        ensure(active,'scope_closed');
        ensure(/^0x[0-9a-f]{64}$/.test(hash),'transaction_hash');
        const key=JSON.stringify([blockHash,hash]);
        if(transactions.has(key))return structuredClone(transactions.get(key));
        // The underlying port compares both providers. Only mined transactions
        // inside this finalized prefix can be reused; pending reads stay fresh.
        const value=await port.transaction(hash);
        ensure(active,'scope_closed');
        if(value===null||value.blockHash===null||value.blockNumber===null)return value;
        ensure(value.hash===hash&&/^0x[0-9a-f]{64}$/.test(value.blockHash)
          &&/^0x[0-9a-fA-F]+$/.test(value.blockNumber),'transaction_record');
        const height=Number(BigInt(value.blockNumber));
        ensure(Number.isSafeInteger(height)&&height>=0,'transaction_block');
        if(height>block)return value;
        ensure(await port.blockHash(height)===value.blockHash,'transaction_not_canonical');
        ensure(active,'scope_closed');
        transactions.set(key,structuredClone(value));
        return structuredClone(value);
      },
      call:(to,data,hash)=>{ensure(active,'scope_closed');return hash===blockHash
        ?cached('eth_call',[{to,data},{blockHash,requireCanonical:true}]):port.call(to,data,hash);},
      code:(to,hash)=>{ensure(active,'scope_closed');return hash===blockHash
        ?cached('eth_getCode',[to,{blockHash,requireCanonical:true}]):port.code(to,hash);},
    };
    try{
      const result=await read(scoped);
      ensure(await port.blockHash(block)===blockHash,'checkpoint_changed');
      return result;
    }finally{active=false;}
  };
}

/** Batch responses may be reordered, but never incomplete or ambiguous. */
export function checkedHistoricalBatch(rows,reply) {
  ensure(Array.isArray(reply)&&reply.length===rows.length,'response_population');
  const byId=new Map();
  for(const item of reply){
    ensure(item&&item.jsonrpc==='2.0'&&Number.isSafeInteger(item.id)
      &&rows.some(row=>row.id===item.id)&&!byId.has(item.id),'response_id');
    const result=Object.hasOwn(item,'result'),error=Object.hasOwn(item,'error');
    ensure(result!==error,'response_shape');
    if(result)ensure(typeof item.result==='string'&&/^0x(?:[0-9a-fA-F]{2})*$/.test(item.result),'result');
    else ensure(item.error&&typeof item.error==='object'&&typeof item.error.code==='number','error');
    byId.set(item.id,item);
  }
  return rows.map(row=>byId.get(row.id));
}
