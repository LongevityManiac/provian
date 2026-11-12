import { Interface } from 'ethers';
import { boundedGasEstimate, BASE_TRANSACTION_GAS_LIMIT } from './transaction-gas-limit.mjs';
const ensure=(value,reason)=>{if(!value)throw Error('import_gas_'+reason);};
// Gross execution ceilings include cold storage/access charges; no refunds.
// Every proof iteration is charged more than both compiled branches combined.
export const PROOF_ITERATION_GAS=8192n;
export const IMPORT_EXECUTION_GAS=Object.freeze({importEntry:131072n,importBatch:524288n,
 importBalance:262144n,importCustodySeed:393216n,importEconomicEntry:655360n});
/** Final artifact hashes must match the full-plan certificate. These formulas
 * alone do not certify a different implementation or a different ABI shape. */
export function importLeafBound(row,artifact){
 const iface=new Interface(artifact.abi),parsed=iface.parseTransaction({data:row.data});
 ensure(parsed&&Object.hasOwn(IMPORT_EXECUTION_GAS,parsed.name),'uncovered_family');
 ensure(iface.encodeFunctionData(parsed.fragment,parsed.args)===row.data,'noncanonical_calldata');
 const proof=parsed.args[parsed.args.length-1];ensure(Array.isArray(proof)&&proof.length<=256,'proof_length');
 if(['importCustodySeed','importEconomicEntry'].includes(parsed.name)){
  const bytes=(parsed.args[1].length-2)/2;
  ensure(bytes===(parsed.name==='importCustodySeed'?224:608),'record_size');
 }
 return {execution:IMPORT_EXECUTION_GAS[parsed.name]+PROOF_ITERATION_GAS*BigInt(proof.length),
  memoryBytes:16384n+512n*BigInt(proof.length)};
}
export function importGasUpper(leaves,calldata){
 ensure(leaves.length>0&&/^0x(?:[0-9a-f]{2})+$/.test(calldata),'empty_or_invalid');
 const words=(1024n+leaves.reduce((n,leaf)=>n+leaf.memoryBytes,0n)+31n)/32n;
 return leaves.reduce((n,leaf)=>n+leaf.execution,0n)+3n*words+words*words/512n
  +21000n+16n*BigInt((calldata.length-2)/2);
}
export function importGroupFits(upper,maximum=BASE_TRANSACTION_GAS_LIMIT){
 try{boundedGasEstimate(upper,maximum);return true;}catch{return false;}
}
