# Isolated Recourse exercise

The exercise uses a local Anvil copy of Base, with a distinct signing domain:
chain **31337**, RPC **http://127.0.0.1:18545**. Transactions affect only that
copy. Every script that writes checks the chain ID and Anvil identity. The
sequence and workbench also require the exact simulator instance recorded by
bootstrap. Restarting the simulator requires a new exercise deployment.

All generated exercise recovery material is public test material. Never use
these signing roots, fixture keys, commitments, or deployment files on a public
network. The scripts do not request production wallet keys.

Fixture wallets derive from the simulator instance identifier and their role.
They are public test material. Bootstrap refuses fixture addresses with existing
code, including delegation code inherited from Base at widely reused test keys.

Start Anvil with a fixed Base fork block, then run:

```sh
node scripts/recourse/exercise-bootstrap.mjs /absolute/private/exercise-directory
node scripts/recourse/exercise-sequence.mjs /absolute/private/exercise-directory COPIED_FUNDER_ADDRESS
node scripts/recourse/exercise-workbench.mjs /absolute/private/exercise-directory COPIED_FUNDER_ADDRESS
```

Bootstrap needs two independently operated historical Base RPCs in
`BASE_RPC_URL` and `BASE_RPC_URL_SECONDARY`. It reads history through both,
reconciles balances and monetary history, and applies the shutdown, import,
and pointer publication only to the local copy. It checks compiled artifacts
against their source hashes. Compile before running it. Transaction hashes are
journaled before receipt polling; a failed partial deployment requires a fresh
fork and output directory. Do not treat the exercise as a production deployment
or migration command.

The fixture sequence binds a public test wallet, joins, verifies actual monthly
burns and a no-earnings contribution, simulates a loss, reverses the reachable
part and restores the remainder from the pool. Its protected exchange evidence
is explicitly synthetic. It verifies that reversal and restoration create no
new PVT. The fixture's starting PVT comes from the explicitly selected **copied**
balance. It is neither a grant nor a production transfer. If no funding address
is supplied, the administrator's copied address is used; the script refuses
insufficient funds instead of minting test supply.

Open **http://127.0.0.1:18546** for wallet binding and joining. A browser wallet
signs the binding with its own key, scoped explicitly to chain 31337. The
workbench supplies only the simulator's public test attestor signature and test
recovery commitment. Joining requires the wallet's address-consent signature and
an exact 100-PVT participation-debit signature, in addition to its simulator
transactions. No seed or private key is entered into the workbench. The copied balance
and membership state can be refreshed there. With an explicit copied funding
address, the top-up button transfers enough copied PVT to bring the selected
wallet to 500 PVT; it never mints. This is exercise funding, not a live transfer.
After binding and joining, **Exercise reversal and pool restoration** runs the
simulated loss and both restoration paths. The page shows each assertion and
the local transaction receipts. The sequence advances the shared simulator's
clock by a month; run one wallet at a time. It asks the wallet to sign the exact
100-PVT contribution for the closed no-earnings month and the next month's
100-PVT participation burn. Allowance alone cannot authorize either debit.
Connect or Refresh resumes a running job's signature requests after a page
reload or lost response, without starting another sequence. Each request is
short-lived; an expired or failed partial exercise requires a fresh fork and
output directory. Closing the workbench rejects a pending signature request.

An actual-address sequence requires those wallet signatures; the standalone
sequence command is for the generated fixture wallet. Anvil impersonation is
used solely inside the isolated copy for gas sponsorship and the simulated
loss, reversal, and restoration. It never substitutes for the owner's debit
signature. Recovery goes
to a distinct public test destination. Synthetic exchange evidence and public
test recovery material remain explicit. The sequence records its own result
file per address and does not change the owner's real wallet or balance.

For an agent wallet, request `/binding` from the local workbench with a JSON
`address` and the workbench Origin header. Copy that public challenge to the
agent's own machine. There, `exercise-sign-binding.mjs CHALLENGE OUTPUT SDK_DIST`
uses its existing encrypted keystore and signs only the fixed chain-31337
binding. Copy only the public signed output back and POST it to
`/submit-binding`; the simulator sponsors the transaction. The private key and
keystore stay on the agent's machine. A tunnel to the workbench, if used, must
remain a private connection. Do not expose this test service to the Internet.

Agent membership signatures use the same mechanism: `/membership` prepares a
`join` or `burn` challenge, and a running `/exercise` exposes its next public
challenge at `/exercise-status`. On the agent's own machine,
`exercise-sign-membership.mjs CHALLENGE OUTPUT SDK_DIST` validates the fixed
chain-31337 command before accessing its keystore. Return only the signed
output. Submit a pending exercise signature to `/exercise-signature` with the
address, pending request ID and signature. For initial consent/debit calls,
POST `/submit-membership` with `challenge`, `ownerSignature`, and the original
`attestorSignature` from `/membership`; the simulator sponsors the exact call.
The workbench's host and Origin restrictions apply to these routes as well.
When copying the signer to another machine, bundle its local module dependencies
first; the existing keystore modules are loaded from the explicit SDK directory.

The output directory contains the snapshot, contract manifest, transaction
receipts, and sequence assertions. These are exercise artifacts, not production
configuration. No script in this directory's exercise flow publishes a website,
relay, package, or store release, or changes the production discovery pointer.
