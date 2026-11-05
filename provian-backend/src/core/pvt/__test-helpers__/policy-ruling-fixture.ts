/** Stored operator inputs only. The production writer lives in the private service. */
import type {Firestore} from 'firebase-admin/firestore';
import {actionPolicyDocumentId} from '../policy/pending-policy-queue';
import {POLICY_RULINGS_COLLECTION,type SetPolicyRulingInput,type PolicyRulingDoc} from '../policy/policy-rulings';
export async function setPolicyRuling(db:Firestore,input:SetPolicyRulingInput):Promise<PolicyRulingDoc>{
 const row:PolicyRulingDoc={action_type:input.actionType,ruling:input.ruling,reason_code:input.reasonCode??null,canonical_type:input.canonicalType??null,issue_url:input.issueUrl??null,proposed_disposition:input.proposedDisposition??null,proposed_weight_bps:input.proposedWeightBps??null,proposed_category:(input.proposedCategory??null) as PolicyRulingDoc['proposed_category'],reviewer_notes:input.reviewerNotes??null,ruled_at:input.now??Date.now(),ruled_by:input.operatorId,live_at:null,activation_fanout_at:null};
 await db.collection(POLICY_RULINGS_COLLECTION).doc(actionPolicyDocumentId(input.actionType)).set(row);
 return row;
}
