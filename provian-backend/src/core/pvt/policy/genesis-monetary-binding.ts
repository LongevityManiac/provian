import {hashProposedMonetaryPolicyTemplate} from './proposed-monetary-policy';
/** Only the exact policy template running on this revision is admitted. */
export function hasGenesisMonetaryBinding(activation: {approved_monetary_policy_template_hash: unknown; approved_policy_manifest_hash: unknown}): boolean {
 return activation.approved_monetary_policy_template_hash === hashProposedMonetaryPolicyTemplate();
}
