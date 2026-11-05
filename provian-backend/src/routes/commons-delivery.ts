import type {Request,Response} from 'express';
import type {AgentBankDeps} from '../core/agent-bank/types';
import {rawPrivateFirestore} from '../core/provenance/private-store';
import {deliveryHead,deliverySequence,readDeliveryPage,deliveryCheckpoint,deliveryGeneration,scanPendingApprovals,DELIVERY_PAGE,type DeliveryEvent,type PendingDeliveryApproval} from '../core/commons/agent-delivery';

/**
 * Safety-net cadence for an idle consumer. The device heartbeat names waiting mail, so an idle
 * agent costs no poll between heartbeats; one poll answers at once and holds no instance.
 */
export const COMMONS_POLL_IDLE_MS = 3_600_000;
/** A full page means more is waiting; the consumer asks again right after processing it. */
export const COMMONS_POLL_DRAIN_MS = 1_000;

export interface CommonsPollResponse {
 checkpoint:{cursor:number};
 events:DeliveryEvent[];
 approvals:PendingDeliveryApproval[];
 next_poll_ms:number;
}

/**
 * The held event stream kept one instance billed for as long as any agent was connected and
 * took a request slot per agent. It now answers at once so an older daemon backs off and updates.
 */
export function refuseCommonsStream(_req:Request,res:Response):void {
 res.status(410).json({error:'Commons delivery is polled. Update the Provian daemon.',poll:'/v1/threads/events/poll'});
}

/** API-key authenticated, wallet-scoped poll. Idle: the credential index, the head and one empty pending query. */
export async function pollCommonsDelivery(req:Request,res:Response,deps:AgentBankDeps):Promise<void> {
 const wallet=req.agentWallet;
 if(!wallet){res.status(403).json({error:'Agent API credentials required'});return;}
 const input=req.body?.after??0;
 if(!Number.isSafeInteger(input)||input<0){res.status(400).json({error:'Invalid delivery cursor'});return;}
 const raw=rawPrivateFirestore(deps.db);
 const headRef=deliveryHead(deps.db,wallet.id);
 const authorized=async():Promise<boolean>=>{
  const [index,current]=await Promise.all([raw.collection('api_key_index').doc(wallet.api_key_prefix).get(),raw.collection('agent_wallets').doc(wallet.id).get()]);
  const row=current.data();
  return index.get('wallet_id')===wallet.id&&row?.status==='active'&&row.api_key_prefix===wallet.api_key_prefix
   &&row.api_key_hash===wallet.api_key_hash&&row.api_key_salt===wallet.api_key_salt;
 };
 try {
  const rollout=await raw.collection('commons_delivery_state_v1').doc('current').get();
  if(rollout.get('active')!==true){res.status(503).json({error:'Commons delivery is activating'});return;}
  const [head,scan]=await Promise.all([headRef.get(),scanPendingApprovals(deps.db,wallet.id,s=>s.ready.length>DELIVERY_PAGE)]);
  const sequence=deliverySequence(deps.db,head),generation=deliveryGeneration(deps.db,head),checkpoint=deliveryCheckpoint(deps.db,head);
  const cursor=Math.max(Number(input),checkpoint.cursor);
  if(cursor>sequence){res.status(409).json({error:'Delivery cursor is ahead of the log'});return;}
  const events=await readDeliveryPage(deps.db,wallet.id,cursor,sequence,generation);
  // A pending row bound to another agent's approval is a corrupt binding, never a delivery.
  if(scan.foreign){res.status(403).json({error:'Approval is not bound to your delivery'});return;}
  // A vanished approval has nothing to deliver; its row would otherwise wake every heartbeat.
  for(let i=0;i<scan.orphans.length;i+=500){const batch=raw.batch();for(const ref of scan.orphans.slice(i,i+500))batch.delete(ref);await batch.commit();}
  // Paged within the consumer's bound; the rest follow on the drain poll.
  const approvals:PendingDeliveryApproval[]=scan.ready.slice(0,DELIVERY_PAGE);
  // A revoked credential never receives a page, even within the short wallet cache.
  if((events.length||approvals.length)&&!await authorized()){res.status(401).json({error:'Credentials revoked'});return;}
  const more=cursor+events.length<sequence||scan.ready.length>approvals.length;
  const body:CommonsPollResponse={checkpoint,events,approvals,next_poll_ms:more?COMMONS_POLL_DRAIN_MS:COMMONS_POLL_IDLE_MS};
  res.set('Cache-Control','no-store').json(body);
 }catch{
  res.status(503).json({error:'Delivery temporarily unavailable'});
 }
}
