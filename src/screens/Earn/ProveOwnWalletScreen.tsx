/**
 * ProveOwnWalletScreen — a PERSON proves a wallet they already hold (MetaMask,
 * Coinbase Wallet, a Safe …) is theirs, from Earn. No agent, no code: one message
 * signed in that wallet, over WalletConnect or as a pasted signature.
 *
 * It is the person mode of the agent "Link a wallet" flow
 * (LinkExternalWalletScreen): the same two channels and helpers, bound to
 * POST /v1/wallet/external-address/{challenge,verify} and
 * GET /v1/wallet/external-addresses under the person's own wallet auth.
 */

import React from 'react';
import { ExternalWalletProofFlow } from '../Agent/LinkExternalWalletScreen';

const PERSON_MODE = { kind: 'person' } as const;

const ProveOwnWalletScreen = (): React.JSX.Element => <ExternalWalletProofFlow mode={PERSON_MODE} />;

export default ProveOwnWalletScreen;
