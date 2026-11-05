/** Independent representation transactions; finish the batch even if one refuses. */
export async function forEachPrivateMigrationPage<T>(rows:readonly T[],visit:(row:T)=>Promise<void>):Promise<void> {
 for(let start=0;start<rows.length;start+=8){
  const results=await Promise.allSettled(rows.slice(start,start+8).map(row=>Promise.resolve().then(()=>visit(row))));
  const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(failure)throw failure.reason;
 }
}
