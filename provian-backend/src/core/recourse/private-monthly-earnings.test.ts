import { emptyPrivateMonthlyEarnings, planPrivateMonthlyEarnings } from './private-monthly-earnings';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const row=(n:number,gross:string,contributor=gross)=>({occurrence:h(n),account:a(n),grossAtomic:gross,contributorAtomic:contributor});
test('one owner across addresses pays the exact combined percentage, not independent rounded-down percentages',()=>{
 const first=planPrivateMonthlyEarnings(emptyPrivateMonthlyEarnings(100),[row(1,'199')]);
 const second=planPrivateMonthlyEarnings(first.next,[row(2,'1')]);
 expect(first.contributions[0].contributionAtomic).toBe('1');expect(second.contributions[0].contributionAtomic).toBe('1');
 expect(second.next).toEqual({grossAtomic:'200',dueAtomic:'2',paidAtomic:'2',remainder:0,earningsBps:100});
 // Counterexample: independent per-address flooring would collect only one unit.
 expect(199n*100n/10000n+1n*100n/10000n).toBe(1n);
});
test('arbitrary batch partitions preserve cumulative exactness without exposing totals in per-address output',()=>{
 const rows=Array.from({length:1000},(_,i)=>row(i+1,String(i%23)));
 const whole=planPrivateMonthlyEarnings(emptyPrivateMonthlyEarnings(137),rows);
 let state=emptyPrivateMonthlyEarnings(137);const contributions=[];
 for(let start=0;start<rows.length;start+=17){const next=planPrivateMonthlyEarnings(state,rows.slice(start,start+17));state=next.next;contributions.push(...next.contributions);}
 expect(state).toEqual(whole.next);expect(contributions).toEqual(whole.contributions);
 expect(BigInt(state.dueAtomic)).toBe(rows.reduce((sum,r)=>sum+BigInt(r.grossAtomic),0n)*137n/10000n);
 for(const contribution of contributions)expect(Object.keys(contribution).sort()).toEqual(['account','contributionAtomic','contributorAtomic','grossAtomic','occurrence']);
});
test('institution floors are untouched when a configured rate exceeds available contributor issuance',()=>{
 const planned=planPrivateMonthlyEarnings(emptyPrivateMonthlyEarnings(10000),[row(1,'10000','9900')]);
 expect(planned.contributions[0].contributionAtomic).toBe('9900');expect(planned.next.dueAtomic).toBe('10000');expect(planned.next.paidAtomic).toBe('9900');
});
test('planning neither mutates prior state nor commits a failed settlement',()=>{
 const prior=Object.freeze(emptyPrivateMonthlyEarnings(100));const rows=Object.freeze([Object.freeze(row(1,'99'))]);
 expect(planPrivateMonthlyEarnings(prior,rows)).toEqual(planPrivateMonthlyEarnings(prior,rows));
 expect(prior).toEqual(emptyPrivateMonthlyEarnings(100));
 expect(planPrivateMonthlyEarnings(prior,[row(2,'1')]).contributions[0].contributionAtomic).toBe('0');
});
test('corrupt totals, duplicate occurrences, negative amounts, oversized on-chain amounts and empty batches fail closed',()=>{
 const good=emptyPrivateMonthlyEarnings(100);
 for(const prior of [{...good,paidAtomic:'1'},{...good,dueAtomic:'1'},{...good,remainder:1},{...good,earningsBps:10001}])expect(()=>planPrivateMonthlyEarnings(prior,[row(1,'100')])).toThrow('invalid');
 for(const rows of [[],[row(1,'1'),row(1,'2')],[row(1,'-1')],[row(1,'01')],[row(1,'1','2')],[row(1,String(1n<<256n))]])expect(()=>planPrivateMonthlyEarnings(good,rows)).toThrow('invalid');
 const max=String((1n<<256n)-1n),state=planPrivateMonthlyEarnings(good,[row(1,max)]).next;
 // Private owner totals are not uint256 token balances: cumulative issuance
 // may cross that boundary over time without introducing a new earnings cap.
 expect(planPrivateMonthlyEarnings(state,[row(2,'1')]).next.grossAtomic).toBe(String(1n<<256n));
});

test('public-ticket projection never copies extra private owner or invoice fields',()=>{
 const privateInput={...row(1,'100'),ownerId:'private owner',ownerGrossAtomic:'99999',invoiceId:'private invoice'};
 const result=planPrivateMonthlyEarnings(emptyPrivateMonthlyEarnings(100),[privateInput]);
 expect(result.contributions).toEqual([{...row(1,'100'),contributionAtomic:'1'}]);
 for(const secret of ['private owner','99999','private invoice'])expect(JSON.stringify(result.contributions)).not.toContain(secret);
});
