// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianPVT9EligibilityVerifier} from "../src/ProvianPVT9EligibilityVerifier.sol";
import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";

/**
 * M4 item 9 — the settlement gas curve, MEASURED.
 *
 * The cost question is not "what does a batch cost" but "what does the SAME
 * population cost when it is settled seven times as often". That needs two
 * numbers this suite measures rather than assumes:
 *
 *   a — the FIXED per-transaction overhead, paid once per settlement call no
 *       matter how many recipients ride in it. This is what a shorter cadence
 *       multiplies.
 *   b — the MARGINAL cost per recipient. This is what a larger population
 *       multiplies, and it is cadence-invariant.
 *
 * Both are extracted from a two-point fit over real `settleGenesisPEBatch`
 * calls at different recipient counts, then CHECKED against a third, larger
 * size — a two-point fit always fits its own two points, so the third point is
 * what makes linearity a finding rather than an assumption.
 *
 * Measurement only: nothing here changes a contract, a gate, or an economic
 * value, and every settlement is against a locally deployed test kernel.
 */
/// EIP-2028: 16 gas per non-zero calldata byte, 4 per zero byte. Counted over the
/// ACTUAL encoding rather than assumed, because the zero/non-zero split is what
/// decides the number and hashes are dense in non-zero bytes. ONE definition,
/// shared by both suites below — two copies would be two things to drift.
library CalldataGas {
    function forBytes(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i = 0; i < data.length; i++) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }
}

contract ProvianPVT9SettlementGasCurveTest is ProvianPVT9TestBase {
    /// Sizes measured. 500 is the kernel's `MAX_RECIPIENTS_PER_BATCH`.
    uint256 internal constant N_SMALL = 1;
    uint256 internal constant N_MID = 100;
    uint256 internal constant N_MAX = 500;

    /// Encoded calldata bytes for the last measured batch, and its execution gas.
    uint256 internal lastCalldataBytes;
    /// EIP-2028 intrinsic calldata gas for the last measured batch.
    uint256 internal lastCalldataGas;
    uint256 internal lastCalldataGas1;

    function _calldataGasOfLastBatch() internal view returns (uint256) {
        return lastCalldataGas;
    }

    /// One settlement of `n` distinct recipients, returning EXECUTION gas used.
    /// `gasleft()` deltas exclude the 21,000 intrinsic cost and the calldata
    /// gas a REAL transaction pays, so `lastCalldataBytes` is recorded too —
    /// calldata is a per-recipient (marginal) term and omitting it would make
    /// the marginal coefficient badly wrong at batch sizes that matter.
    function _settleBatchOfSize(uint256 n, uint256 seed) internal returns (uint256 gasUsed) {
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](n);
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](n);
        for (uint256 i = 0; i < n; i++) {
            // Strictly ascending: the kernel requires recipient addresses in
            // ascending order (RecipientsNotStrictlyOrdered otherwise).
            address contributor = address(uint160(seed * 1_000_000 + i + 1));
            recipients[i] = ProvianPVT9.GenesisRecipient({contributor: contributor, claimCount: 1});
            claims[i] = ProvianPVT9.GenesisPEClaim({
                claimId: keccak256(abi.encode(seed, i, "claim")),
                walletId: keccak256(abi.encode(seed, i, "wallet")),
                oneTimeAnchor: keccak256(abi.encode(seed, i, "anchor")),
                grantType: 0,
                qualifiedAt: epochStart,
                reservedGrossAtomic: 75 ether
            });
        }
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = keccak256(abi.encode("batch", seed));
        bytes memory encoded = abi.encodeCall(
            ProvianPVT9.settleGenesisPEBatch,
            (batchId, epoch, policyHash, cursor, cursor + n, recipients, claims)
        );
        lastCalldataBytes = encoded.length;
        lastCalldataGas = CalldataGas.forBytes(encoded);
        if (n == N_SMALL) lastCalldataGas1 = lastCalldataGas;
        vm.prank(MINTER);
        uint256 before = gasleft();
        pvt.settleGenesisPEBatch(batchId, epoch, policyHash, cursor, cursor + n, recipients, claims);
        gasUsed = before - gasleft();
    }

    function test_settlementGasIsAffineInRecipientCount() public {
        uint256 g1 = _settleBatchOfSize(N_SMALL, 1);
        uint256 cd1 = lastCalldataBytes;
        uint256 g100 = _settleBatchOfSize(N_MID, 2);
        uint256 cd100 = lastCalldataBytes;
        uint256 g500 = _settleBatchOfSize(N_MAX, 3);
        uint256 cd500 = lastCalldataBytes;
        // EIP-2028 intrinsic calldata gas: 16 per non-zero byte, 4 per zero
        // byte. `gasleft()` deltas EXCLUDE this, and at n=500 it is on the order
        // of 1M gas — omitting it understates the marginal cost per recipient.
        emit log_named_uint("EIP-2028 calldata gas n=1", lastCalldataGas1);
        emit log_named_uint("EIP-2028 calldata gas n=500", _calldataGasOfLastBatch());
        emit log_named_uint("calldata bytes n=1", cd1);
        emit log_named_uint("calldata bytes n=100", cd100);
        emit log_named_uint("calldata bytes n=500", cd500);
        emit log_named_uint("calldata bytes per recipient", (cd500 - cd1) / (N_MAX - N_SMALL));

        // Two-point fit over (1, g1) and (100, g100).
        uint256 marginalPerRecipient = (g100 - g1) / (N_MID - N_SMALL);
        uint256 fixedOverhead = g1 - marginalPerRecipient;

        emit log_named_uint("gas n=1", g1);
        emit log_named_uint("gas n=100", g100);
        emit log_named_uint("gas n=500", g500);
        emit log_named_uint("FIT marginal gas per recipient", marginalPerRecipient);
        emit log_named_uint("FIT fixed gas per settlement tx", fixedOverhead);

        uint256 predicted500 = fixedOverhead + marginalPerRecipient * N_MAX;
        emit log_named_uint("PREDICTED exec gas n=500 (fit)", predicted500);
        // What a transaction actually costs: 21,000 intrinsic + EIP-2028
        // calldata + execution. Reported so nothing downstream quotes the
        // execution-only figure as the whole cost.
        emit log_named_uint("TOTAL tx gas n=1   (21k + calldata + exec)", 21_000 + lastCalldataGas1 + g1);
        emit log_named_uint("TOTAL tx gas n=500 (21k + calldata + exec)", 21_000 + lastCalldataGas + g500);

        // The third point is the test. Allow 15%: settlement touches storage
        // slots whose warm/cold status genuinely varies with batch size, so an
        // exactly-linear demand would be a false precision.
        uint256 tolerance = predicted500 / 100 * 15;
        assertApproxEqAbs(g500, predicted500, tolerance, "settlement gas is not affine in recipient count");

        // Both coefficients must be REAL, or the fit says nothing.
        assertGt(marginalPerRecipient, 0, "marginal cost per recipient measured as zero");
        assertGt(fixedOverhead, 0, "fixed per-transaction overhead measured as zero");

        // The load-bearing economic fact: a bigger batch is cheaper PER
        // RECIPIENT, which is exactly why cadence (not population) drives cost.
        assertLt(g500 / N_MAX, g1, "a 500-recipient batch is not cheaper per recipient than a 1-recipient batch");
    }

    /// The batch ceiling is a kernel CONSTANT, not configuration.
    function test_maxRecipientsPerBatchIsAProtocolConstant() public view {
        assertEq(pvt.MAX_RECIPIENTS_PER_BATCH(), 500, "batch ceiling moved");
    }

    /// RED CONTROL: one over the ceiling reverts, so 500 is a real bound.
    function test_batchAboveTheCeilingReverts() public {
        uint256 n = 501;
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](n);
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = ProvianPVT9.GenesisRecipient({
                contributor: address(uint160(9_000_000 + i + 1)),
                claimCount: 1
            });
            claims[i] = ProvianPVT9.GenesisPEClaim({
                claimId: keccak256(abi.encode("over-claim", i)),
                walletId: keccak256(abi.encode("over-wallet", i)),
                oneTimeAnchor: keccak256(abi.encode("over-anchor", i)),
                grantType: 0,
                qualifiedAt: epochStart,
                reservedGrossAtomic: 75 ether
            });
        }
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        vm.prank(MINTER);
        vm.expectRevert(ProvianPVT9.TooManyRecipients.selector);
        pvt.settleGenesisPEBatch(
            keccak256("over-batch"), epoch, policyHash, cursor, cursor + 1, recipients, claims
        );
    }
}

/**
 * The TWO-KEY pair, measured against the REAL verifier.
 *
 * The first version of this suite settled through the test base's mock verifier
 * and priced the approver from the forge gas-report MEDIAN over small batches —
 * 34,929 + 21,000 + a 1,600-byte calldata guess. That was wrong twice over, and
 * wrong in exactly the way this file was written to stop:
 *
 *   - `approveGenesisBatch` takes the SAME seven parameters as
 *     `settleGenesisPEBatch`, including the full `recipients` and `claims`
 *     arrays. Its calldata is the same ~128 KB at n=500, and its execution runs
 *     two keccak passes over both arrays plus `_validateGenesisShape`. It is
 *     n-DEPENDENT, not a fixed per-batch term.
 *   - It is MANDATORY: `_verifyEligibility` is unconditional on the settle path.
 *     A settlement measured without it is not a settlement.
 *
 * So it is measured here, against the real `ProvianPVT9EligibilityVerifier`,
 * with a real appointed batch approver.
 */
contract ProvianPVT9TwoKeyGasCurveTest is ProvianPVT9TestBase {
    ProvianPVT9EligibilityVerifier internal realVerifier;
    address internal constant APPROVER = address(0xA9A9);

    uint256 internal constant N_SMALL = 1;
    uint256 internal constant N_MAX = 500;

    function setUp() public override {
        pvt = new ProvianPVT9();
        realVerifier = new ProvianPVT9EligibilityVerifier(pvt, ELIGIBILITY_ID, ELIGIBILITY_VERSION);
        epochStart = uint64(block.timestamp + 1 days);
        genesisEnd = epochStart + uint64(365 days);
        vm.startPrank(ADMIN);
        pvt.appointOperationalMinter(MINTER);
        pvt.armEpochZero(
            ProvianPVT9.EpochZeroConfig({
                epochZeroStartsAt: epochStart,
                genesisStartsAt: epochStart,
                genesisEndsAt: genesisEnd,
                initialMintRate: 1 ether,
                provianTreasury: PROVIAN_TREASURY,
                foundationTreasury: FOUNDATION_TREASURY,
                eligibilityVerifier: ProvianPVT9.VerifierConfig({
                    verifier: address(realVerifier),
                    configurationId: ELIGIBILITY_ID,
                    version: ELIGIBILITY_VERSION
                }),
                initialFinalizedCursor: 100,
                combinedCapMode: ProvianPVT9.CombinedCapMode.Automatic,
                genesisCap: 7_500_000 ether,
                fixedCombinedCap: 0
            })
        );
        vm.stopPrank();
        vm.prank(ProvianPVT9EligibilityVerifier(realVerifier).BOOTSTRAP_ADMIN());
        realVerifier.appointBatchApprover(APPROVER);
        vm.warp(epochStart);
    }

    struct PairGas {
        uint256 approveExec;
        uint256 approveCalldata;
        uint256 settleExec;
        uint256 settleCalldata;
    }

    function _approveAndSettle(uint256 n, uint256 seed) internal returns (PairGas memory g) {
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](n);
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](n);
        for (uint256 i = 0; i < n; i++) {
            recipients[i] = ProvianPVT9.GenesisRecipient({
                contributor: address(uint160(seed * 1_000_000 + i + 1)), claimCount: 1
            });
            claims[i] = ProvianPVT9.GenesisPEClaim({
                claimId: keccak256(abi.encode(seed, i, "claim")),
                walletId: keccak256(abi.encode(seed, i, "wallet")),
                oneTimeAnchor: keccak256(abi.encode(seed, i, "anchor")),
                grantType: 0,
                qualifiedAt: epochStart,
                reservedGrossAtomic: 75 ether
            });
        }
        uint64 epoch = pvt.currentEpoch();
        bytes32 policyHash = _policy(epoch).policyHash;
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 batchId = keccak256(abi.encode("pair", seed));

        bytes memory approveData = abi.encodeCall(
            ProvianPVT9EligibilityVerifier.approveGenesisBatch,
            (batchId, epoch, policyHash, cursor, cursor + n, recipients, claims)
        );
        g.approveCalldata = CalldataGas.forBytes(approveData);
        vm.prank(APPROVER);
        uint256 before = gasleft();
        realVerifier.approveGenesisBatch(batchId, epoch, policyHash, cursor, cursor + n, recipients, claims);
        g.approveExec = before - gasleft();

        bytes memory settleData = abi.encodeCall(
            ProvianPVT9.settleGenesisPEBatch,
            (batchId, epoch, policyHash, cursor, cursor + n, recipients, claims)
        );
        g.settleCalldata = CalldataGas.forBytes(settleData);
        vm.prank(MINTER);
        before = gasleft();
        pvt.settleGenesisPEBatch(batchId, epoch, policyHash, cursor, cursor + n, recipients, claims);
        g.settleExec = before - gasleft();
    }

    function test_twoKeyPairTotalGas() public {
        PairGas memory g1 = _approveAndSettle(N_SMALL, 11);
        PairGas memory g500 = _approveAndSettle(N_MAX, 12);

        uint256 approveTotal1 = 21_000 + g1.approveCalldata + g1.approveExec;
        uint256 approveTotal500 = 21_000 + g500.approveCalldata + g500.approveExec;
        uint256 pairTotal1 = approveTotal1 + 21_000 + g1.settleCalldata + g1.settleExec;
        uint256 pairTotal500 = approveTotal500 + 21_000 + g500.settleCalldata + g500.settleExec;

        emit log_named_uint("APPROVE total tx gas n=1", approveTotal1);
        emit log_named_uint("APPROVE total tx gas n=500", approveTotal500);
        emit log_named_uint("PAIR    total tx gas n=1", pairTotal1);
        emit log_named_uint("PAIR    total tx gas n=500", pairTotal500);
        emit log_named_uint("PAIR    marginal per recipient", (pairTotal500 - pairTotal1) / (N_MAX - N_SMALL));
        emit log_named_uint("PAIR    fixed per batch",
            pairTotal1 - (pairTotal500 - pairTotal1) / (N_MAX - N_SMALL));

        // THE CLAIM THIS SUITE EXISTS TO STOP: the approver is NOT a fixed
        // per-batch term. If it were, its n=500 cost would be within a few
        // percent of its n=1 cost. It is not, by more than an order of magnitude.
        assertGt(approveTotal500, approveTotal1 * 10,
            "approveGenesisBatch priced as fixed - it scales with recipient count");
        // And it is a material share of the pair, not a rounding term.
        assertGt(approveTotal500 * 100 / pairTotal500, 3,
            "approve is under 3% of the pair - check the measurement, not the assertion");
    }
}
