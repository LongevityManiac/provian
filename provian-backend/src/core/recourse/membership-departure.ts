import type { Firestore } from 'firebase-admin/firestore';
import { sha256, getBytes } from 'ethers';
import { ownedMembershipTransition, prepareMembershipTransition } from './membership-preparation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
import { pendingMembershipConsents } from './membership-progress';
import { readRecoursePoolState } from './pool-state';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readMembershipWiring } from './membership-wiring';
import { breakDeploymentChain } from './break-deployment-queue';
import { STANDING_MEMBERSHIP_ABI, authenticatedDepartureSigningHash, parseAddressMembershipConsent,
  parseMembershipAuthorizationDomain, type AddressMembershipConsent, type MembershipAuthorizationDomain } from './membership-authorization';
import { assertMembershipDepartureAttestation } from './membership-departure-attestation';
import { queueMembershipConsent } from './membership-consent-operation';

export interface DepartureCredentialChallenge {
  readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
  readonly exitSalt: string | null; readonly exitCommitment: string | null;
}
export interface DepartureCredential {
  readonly challenge: DepartureCredentialChallenge; readonly exitSecret: string | null; readonly ownerSignature: string | null;
}
const fail = (): never => { throw Error('recourse_departure_invalid'); };
const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
function key(c: DepartureCredentialChallenge): string { return JSON.stringify([c.domain,c.consent.binding,c.consent.account,c.consent.nonce,c.exitSalt,c.exitCommitment]); }
export function parseDepartureCredential(value: unknown): DepartureCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as Record<string,unknown>, raw = r.challenge;
  if (Object.keys(r).sort().join(',') !== 'challenge,exitSecret,ownerSignature' || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const c = raw as Record<string,unknown>;
  if (Object.keys(c).sort().join(',') !== 'consent,domain,exitCommitment,exitSalt') return fail();
  const challenge = {domain:parseMembershipAuthorizationDomain(c.domain),consent:parseAddressMembershipConsent(c.consent),
    exitSalt:c.exitSalt as string|null,exitCommitment:c.exitCommitment as string|null};
  if (challenge.consent.joined) return fail();
  if (c.exitCommitment === null && c.exitSalt === null && r.exitSecret === null && typeof r.ownerSignature === 'string'
    && /^0x(?:[0-9a-fA-F]{2})+$/.test(r.ownerSignature)) return {challenge,exitSecret:null,ownerSignature:r.ownerSignature};
  if (!hash(c.exitCommitment) || !hash(c.exitSalt) || !hash(r.exitSecret) || r.ownerSignature !== null
    || sha256(r.exitSecret) !== c.exitCommitment) return fail();
  return {challenge,exitSecret:r.exitSecret,ownerSignature:null};
}

/** Private read: include both the current mandate and every retained admission
 * that could still land. Returning a challenge never exposes a preimage. */
export async function prepareDepartureCredentials(db:Firestore,ownerIdentity:string,id:string, includePast = false):Promise<readonly DepartureCredentialChallenge[]> {
  const operation=await ownedMembershipTransition(db,ownerIdentity,id);
  if (operation.kind !== 'leave' && !operation.departureRequested) return fail();
  if (operation.status==='complete') return [];
  const retainedAdmissions=await pendingMembershipConsents(db,id,true);
  const deployment=await currentProtocolDeployment(), chain=breakDeploymentChain(), wiring=await readMembershipWiring(chain,deployment);
  const domain:MembershipAuthorizationDomain={chainId:'8453',pointer:deployment.pointer.toLowerCase(),kernel:deployment.addresses.kernel.toLowerCase(),pool:deployment.addresses.recoursePool.toLowerCase()};
  if(operation.pool!==domain.pool||operation.kernel!==domain.kernel)return fail();
  const result:DepartureCredentialChallenge[]=[], nonces=new Map<string,bigint>(), accounts=new Map<string,string>();
  for(const b of operation.bindings){
    const state=await readRecoursePoolState(b.binding,deployment);
    if(state.pool!==domain.pool||state.kernel!==domain.kernel||state.blockHash!==deployment.blockHash)return fail();
    nonces.set(b.binding,BigInt(state.consentNonce)); accounts.set(b.binding,state.currentAddress);
    if(!state.addressConsent)continue;
    const raw=await chain.agree('eth_call',[{to:wiring.standingMembership,data:STANDING_MEMBERSHIP_ABI.encodeFunctionData('standingMandate',[b.binding])},wiring.pin]);
    if(typeof raw!=='string')return fail();
    const m=STANDING_MEMBERSHIP_ABI.decodeFunctionResult('standingMandate',raw);
    if(String(m.consentNonce)!==state.consentNonce)return fail();
    result.push({domain,consent:{binding:b.binding,account:state.currentAddress,nonce:state.consentNonce,joined:false,
      revision:String(deployment.revision),ruleHash:state.signedRuleHash,expiresAt:String(state.timestamp+300)},
      exitSalt:m.active?String(m.exitSalt):null,exitCommitment:m.active?String(m.exitCommitment):null});
  }
  for(const pending of retainedAdmissions){
    if(!pending.standing || pending.operation.status === 'failed')continue;
    const c=pending.consent;
    if(c.account !== accounts.get(c.binding) || (!includePast && BigInt(c.nonce) !== (nonces.get(c.binding)??0n)))continue;
    if(JSON.stringify(pending.domain)!==JSON.stringify(domain)||!operation.bindings.some(b=>b.binding===c.binding))return fail();
    result.push({domain,consent:{...c,nonce:String(BigInt(c.nonce)+1n),joined:false},exitSalt:pending.standing.exitSalt,exitCommitment:pending.standing.exitCommitment});
  }
  if((await currentProtocolDeployment()).manifestHash!==deployment.manifestHash)return fail();
  return [...new Map(result.map(c=>[key(c),c])).values()];
}

/** Only revocation credentials are retained, in the existing encrypted private
 * transition store. The transaction fence makes a concurrent admission fail. */
export async function retainDepartureCredentials(db:Firestore,ownerIdentity:string,id:string,value:unknown):Promise<void>{
  if(!Array.isArray(value)||value.length===0)return fail();
  const credentials=value.map(parseDepartureCredential), expected=await prepareDepartureCredentials(db,ownerIdentity,id);
  const useful=credentials.filter(p=>expected.some(c=>key(p.challenge)===key(c)));
  if(new Set(credentials.map(p=>key(p.challenge))).size!==credentials.length
    ||expected.some(c=>!credentials.some(p=>key(p.challenge)===key(c))))return fail();
  const chain=breakDeploymentChain(),deployment=await chain.deployment();
  for(const p of useful)if(p.ownerSignature)await assertMembershipDepartureAttestation(chain,p.challenge.consent.account,deployment.blockHash,
    getBytes(authenticatedDepartureSigningHash(p.challenge.domain,p.challenge.consent)),p.ownerSignature);
  await db.runTransaction(async tx=>{
    const ref=db.collection(T).doc(id),row=await tx.get(ref);
    if(row.get('ownerIdentity')!==ownerIdentity||(!row.get('departureRequested')&&row.get('kind')!=='leave')||row.get('status')==='complete')return fail();
    const previous:unknown=row.get('departureCredentials');
    const merged=new Map((Array.isArray(previous)?previous.map(parseDepartureCredential):[]).map(p=>[key(p.challenge),p]));
    for(const p of useful)merged.set(key(p.challenge),p);
    tx.update(ref,{departureCredentials:[...merged.values()]});
  });
}

/** The scheduler retries these exact proofs after every retained admission has
 * reconciled, including when the member has closed the app. */
export async function advanceMembershipDeparture(db:Firestore,ownerIdentity:string,id:string):Promise<void>{
  const view=await prepareMembershipTransition(db,ownerIdentity,{id});
  if(view.kind!=='leave'||!view.challenges.length)return;
  const row=await db.collection(T).doc(id).get(),raw:unknown=row.get('departureCredentials');
  if(!Array.isArray(raw))return;
  const credentials=raw.map(parseDepartureCredential), current=await prepareDepartureCredentials(db,ownerIdentity,id);
  for(const c of view.challenges){
    const slot=current.find(p=>p.consent.binding===c.consent.binding&&p.consent.nonce===c.consent.nonce);
    const p=slot&&credentials.find(p=>key(p.challenge)===key(slot));
    if(!p)continue;
    await queueMembershipConsent(db,ownerIdentity,{transitionId:id,domain:c.domain,consent:c.consent,
      standing:null,exitSecret:p.exitSecret,ownerSignature:p.ownerSignature});
  }
}
