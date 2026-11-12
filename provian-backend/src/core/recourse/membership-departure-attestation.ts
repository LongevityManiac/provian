import {Interface,hashMessage} from 'ethers';
import type {OwnerOperationChain} from './owner-operation-queue';
import {assertIdentityAttestation} from './identity-attestor';
const DEPARTURE=new Interface(['function isValidMembershipDepartureSignature(bytes32,bytes) view returns(bytes4)']);
/** Only the suspended-membership departure path accepts the account's durable
 * revocation domain. Join, renewal, identity and spending remain current-key. */
export async function assertMembershipDepartureAttestation(chain:OwnerOperationChain,address:string,
  blockHash:string,message:Uint8Array,signature:string):Promise<void>{
  if(!/^0x[0-9a-fA-F]{40}$/.test(address)||!/^0x[0-9a-f]{64}$/.test(blockHash)
    ||!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature))throw Error('recourse_identity_attestation_invalid');
  const pin={blockHash,requireCanonical:true};
  const code=await chain.agree('eth_getCode',[address,pin]);
  if(typeof code!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(code))throw Error('recourse_identity_attestation_invalid');
  if(code!=='0x'){
    let result:unknown;
    try{result=await chain.agree('eth_call',[{to:address,data:DEPARTURE.encodeFunctionData('isValidMembershipDepartureSignature',[hashMessage(message),signature])},pin]);}
    catch{/* Other contract wallets can still use their current EIP-1271 authority. */}
    if(typeof result==='string'&&result.toLowerCase()===DEPARTURE.encodeFunctionResult('isValidMembershipDepartureSignature',['0x1626ba7e']))return;
  }
  await assertIdentityAttestation(chain,address,blockHash,message,signature);
}
