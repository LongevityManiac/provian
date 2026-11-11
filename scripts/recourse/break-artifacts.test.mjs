import { test, expect } from 'vitest';
import { carryBreakArtifacts, assembleSuccessionArtifact } from './break-artifacts.mjs';
const a=n=>`0x${n.toString(16).padStart(40,'0')}`,h=n=>`0x${n.toString(16).padStart(64,'0')}`;
const snapshot=n=>({format:'provian-break-ownership-snapshot',root:h(n),predecessor:a(n),block:100*n,
 entries:[{kind:'owner',identity:h(20),amount:'100',accounts:[{account:a(20),amount:'100'}],proof:[h(30)]}]});
test('repeated unclaimed breaks retain complete origin candidates and ordinary succession does not duplicate them',()=>{
 const first={origin:a(1),snapshot:snapshot(1)},one=carryBreakArtifacts(first,undefined);
 const two=carryBreakArtifacts({origin:a(2),snapshot:snapshot(2)},{breakArtifacts:one});
 expect(two.map(x=>x.origin)).toEqual([a(2),a(1)]);
 expect(two[1].ownership.entries).toEqual(first.snapshot.entries);
 expect(carryBreakArtifacts({origin:a(2),snapshot:snapshot(2)},{breakArtifacts:two})).toEqual(two);
 first.snapshot.entries[0].amount='999';expect(one[0].ownership.entries[0].amount).toBe('100');
 expect(carryBreakArtifacts(null,undefined)).toEqual([]);
});
test('conflicting domains and malformed ancestry cannot silently replace the retained origin',()=>{
 const pending={origin:a(1),snapshot:snapshot(1)};
 for(const old of [{origin:a(1),ownership:{...snapshot(1),root:h(2)}},
  {origin:a(1),ownership:{...snapshot(1),block:99}}, {origin:a(1),ownership:{...snapshot(1),predecessor:a(2)}},
  {origin:a(0),ownership:snapshot(1)}])expect(()=>carryBreakArtifacts(pending,{breakArtifacts:[old]})).toThrow();
 expect(()=>carryBreakArtifacts(pending,{breakArtifacts:{}})).toThrow('ancestry_invalid');
});

test('the actual snapshot assembly preserves prior artifacts in both ordinary and repeated-break output',()=>{
 const monetary={block:200,blockHash:h(200),supply:'50'},pool={format:'test-pool'},priorArtifact={breakArtifacts:[{origin:a(1),ownership:snapshot(1)}]};
 const pendingBreak={origin:a(2),snapshot:snapshot(2),owners:[{identity:h(20),amount:'11'}],amount:'11'};
 const ordinary=assembleSuccessionArtifact({monetary,pool,pendingBreak,priorArtifact});
 expect(ordinary.snapshotTotal).toBe('61');expect(ordinary.breakArtifacts.map(x=>x.origin)).toEqual([a(2),a(1)]);
 const ownership={...snapshot(3),snapshotBalance:'61'};
 const broken=assembleSuccessionArtifact({monetary,pool,ownership,pendingBreak,priorArtifact:ordinary});
 expect(broken.format).toBe('provian-break-snapshot');expect(broken.breakArtifacts).toEqual(ordinary.breakArtifacts);
 expect(broken.ownership).toEqual(ownership);expect(broken.snapshotTotal).toBe('61');
 expect(assembleSuccessionArtifact({monetary})).toBe(monetary);
 expect(()=>assembleSuccessionArtifact({monetary,ownership})).toThrow('pool_required');
});
