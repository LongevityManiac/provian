import {createHash} from 'crypto';
import type {Firestore, Transaction, DocumentData} from 'firebase-admin/firestore';
import {hashProposedMonetaryPolicyTemplate} from './policy/proposed-monetary-policy';

const COLLECTION = 'pvt_policy_activations';
const DOCUMENT = 'genesis';
function canonical(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
 if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
 return JSON.stringify(value);
}
export function genesisActivationSourceHash(value: unknown): string {
 return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}
export function genesisActivationStageDocument(): string {
 return 'genesis-template-' + hashProposedMonetaryPolicyTemplate().slice(7);
}
export function stageGenesisActivation(source: DocumentData, activation: DocumentData): DocumentData {
 const {approval_signature: _oldSignature, approved_monetary_policy_template_hash: _oldHash, ...oldFields} = source;
 const {approval_signature: _signature, approved_monetary_policy_template_hash: _hash, ...fields} = activation;
 if (canonical(oldFields) !== canonical(fields) || _hash !== hashProposedMonetaryPolicyTemplate()) {
  throw new Error('staged Genesis activation changed operational fields or template');
 }
 return {schema_version: 'genesis-activation-stage/v1', source_sha256: genesisActivationSourceHash(source), activation};
}
export function selectGenesisActivation(source: DocumentData | undefined, stage: DocumentData | undefined): DocumentData | undefined {
 if (!source || !stage || source.approved_monetary_policy_template_hash === hashProposedMonetaryPolicyTemplate()) return source;
 try {
  if (stage.schema_version !== 'genesis-activation-stage/v1' || stage.source_sha256 !== genesisActivationSourceHash(source)) return source;
  const expected = stageGenesisActivation(source, stage.activation);
  return canonical(expected) === canonical(stage) ? stage.activation as DocumentData : source;
 } catch {return source;}
}
export interface GenesisActivationSnapshot {
 readonly exists: boolean;
 data(): DocumentData | undefined;
}
/** Both reads join the caller's transaction. Canonical controls can never be bypassed by a stale stage. */
export async function readGenesisActivation(db: Firestore, transaction?: Transaction): Promise<GenesisActivationSnapshot> {
 const sourceRef = db.collection(COLLECTION).doc(DOCUMENT);
 const sourceSnap = transaction ? await transaction.get(sourceRef) : await sourceRef.get();
 const source = sourceSnap.data();
 if (!sourceSnap.exists || source?.approved_monetary_policy_template_hash === hashProposedMonetaryPolicyTemplate()) return sourceSnap;
 const stageRef = db.collection(COLLECTION).doc(genesisActivationStageDocument());
 const stageSnap = transaction ? await transaction.get(stageRef) : await stageRef.get();
 const selected = selectGenesisActivation(source, stageSnap.data());
 return {exists: sourceSnap.exists, data: () => selected};
}
