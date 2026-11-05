// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {MockPVT9Verifier} from "./ProvianPVT9TestBase.sol";

/**
 * the successor kernel's two arming changes, and nothing else.
 *
 * 1. The epoch-zero cap policy is an arming input. The kernel hard-coded
 * epoch zero to Automatic / 7.5M / 10M, and `scheduleCapPolicy` can never reach
 * epoch zero, so the live kernel ran every epoch so far on those defaults even
 * though (Fixed, MAX, MAX) was the ruled policy. Armed Fixed/MAX, the
 * successor opens EVERY epoch uncapped: epoch zero from the arming input, and each
 * later epoch because `_activeCombinedCapMode` persists across opens.
 * 2. `genesisStartsAt` may precede `epochZeroStartsAt`, so the successor carries the
 * Genesis window that opened on 2026-08-03 under its predecessor. Qualification
 * is still bounded by [genesisStartsAt, genesisEndsAt] and block time.
 *
 * Every guard below is also fed the input that violates it.
 */
contract KernelArmingInputsTest is Test {
    address internal constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    address internal constant MINTER = address(0xBEEF);
    address internal constant PROVIAN_TREASURY = address(0xA001);
    address internal constant FOUNDATION_TREASURY = address(0xA002);
    bytes32 internal constant ELIGIBILITY_ID = keccak256("eligibility-v1");
    uint64 internal constant ELIGIBILITY_VERSION = 1;

    /// Hand-written, never read back from the contract (a read-back would make the
    /// comparison vacuous): 2026-08-03T00:00:00Z and 2027-01-01T00:00:00Z.
    uint64 internal constant GENESIS_START = 1785715200;
    uint64 internal constant GENESIS_END = 1798761600;
    /// 2026-10-26T00:00:00Z — where the kernel's Genesis window closes.
    uint64 internal constant OLD_GENESIS_END = 1792972800;

    MockPVT9Verifier internal verifier;
    ProvianPVT9 internal pvt;
    uint64 internal epochStart;
    uint256 internal nonce;

    function setUp() public {
        // "Now" is the migration day: 2026-09-26T00:00:00Z.
        vm.warp(1790380800);
        verifier = new MockPVT9Verifier(ELIGIBILITY_ID, ELIGIBILITY_VERSION, keccak256("b"), 1);
        pvt = new ProvianPVT9();
        epochStart = uint64(block.timestamp + 1 hours);
        vm.prank(ADMIN);
        pvt.appointOperationalMinter(MINTER);
    }

    function _config() internal view returns (ProvianPVT9.EpochZeroConfig memory) {
        return ProvianPVT9.EpochZeroConfig({
            epochZeroStartsAt: epochStart,
            genesisStartsAt: GENESIS_START,
            genesisEndsAt: GENESIS_END,
            initialMintRate: 1 ether,
            provianTreasury: PROVIAN_TREASURY,
            foundationTreasury: FOUNDATION_TREASURY,
            eligibilityVerifier: ProvianPVT9.VerifierConfig({
                verifier: address(verifier), configurationId: ELIGIBILITY_ID, version: ELIGIBILITY_VERSION
            }),
            initialFinalizedCursor: 0,
            combinedCapMode: ProvianPVT9.CombinedCapMode.Fixed,
            genesisCap: type(uint256).max,
            fixedCombinedCap: type(uint256).max
        });
    }

    function _arm(ProvianPVT9.EpochZeroConfig memory config) internal {
        vm.prank(ADMIN);
        pvt.armEpochZero(config);
    }

    // ------------------------------------------------------------------
    // 1. Cap policy
    // ------------------------------------------------------------------

    function test_armedUncapped_everyEpochOpensFixedMax() public {
        _arm(_config());
        ProvianPVT9.EpochPolicy memory p0 = pvt.getEpochPolicy(0);
        assertEq(uint8(p0.combinedCapMode), uint8(ProvianPVT9.CombinedCapMode.Fixed), "epoch 0 Fixed");
        assertEq(p0.genesisCap, type(uint256).max, "epoch 0 genesis cap MAX");
        assertEq(p0.combinedCap, type(uint256).max, "epoch 0 combined cap MAX");

        // Every later epoch, with no schedule at all, including the epoch-12 boundary
        // where Automatic mode would switch to the trailing average.
        for (uint64 e = 1; e <= 13; e++) {
            vm.warp(uint256(epochStart) + uint256(e) * 7 days);
            pvt.openNextEpoch();
            ProvianPVT9.EpochPolicy memory p = pvt.getEpochPolicy(e);
            assertEq(uint8(p.combinedCapMode), uint8(ProvianPVT9.CombinedCapMode.Fixed), "Fixed persists");
            assertEq(p.genesisCap, type(uint256).max, "genesis cap persists");
            assertEq(p.combinedCap, type(uint256).max, "combined cap persists");
        }
    }

    /// RED control for the input actually being read: the same kernel armed with the
    /// old defaults opens epoch zero on them, so the Fixed/MAX result above comes from
    /// the arming input and not from anything the kernel does on its own.
    function test_control_armedWithOldDefaults_epochZeroIsAutomatic10M() public {
        ProvianPVT9.EpochZeroConfig memory c = _config();
        c.combinedCapMode = ProvianPVT9.CombinedCapMode.Automatic;
        c.genesisCap = 7_500_000 ether;
        c.fixedCombinedCap = 0;
        _arm(c);
        ProvianPVT9.EpochPolicy memory p0 = pvt.getEpochPolicy(0);
        assertEq(uint8(p0.combinedCapMode), uint8(ProvianPVT9.CombinedCapMode.Automatic));
        assertEq(p0.genesisCap, 7_500_000 ether);
        assertEq(p0.combinedCap, 10_000_000 ether);
    }

    function test_automaticWithFixedCap_refused() public {
        ProvianPVT9.EpochZeroConfig memory c = _config();
        c.combinedCapMode = ProvianPVT9.CombinedCapMode.Automatic;
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.InvalidConfiguration.selector);
        pvt.armEpochZero(c);
    }

    // ------------------------------------------------------------------
    // 2. Genesis window
    // ------------------------------------------------------------------

    function test_genesisMayStartBeforeEpochZero() public {
        _arm(_config());
        assertEq(pvt.genesisStartsAt(), GENESIS_START);
        assertEq(pvt.genesisEndsAt(), GENESIS_END);
        assertLt(pvt.genesisStartsAt(), pvt.epochZeroStartsAt());
    }

    function test_datesRefused() public {
        ProvianPVT9.EpochZeroConfig memory c = _config();
        c.epochZeroStartsAt = uint64(block.timestamp);
        _expectDates(c);

        c = _config();
        c.genesisStartsAt = 0;
        _expectDates(c);

        c = _config();
        c.genesisEndsAt = c.genesisStartsAt;
        _expectDates(c);

        c = _config();
        c.genesisEndsAt = c.epochZeroStartsAt; // closes before anything can settle
        _expectDates(c);

        // Complement: one second later is admissible.
        c = _config();
        c.genesisEndsAt = c.epochZeroStartsAt + 1;
        _arm(c);
        assertTrue(pvt.epochZeroArmed());
    }

    function _expectDates(ProvianPVT9.EpochZeroConfig memory c) internal {
        vm.prank(ADMIN);
        vm.expectRevert(ProvianPVT9.InvalidActivationDates.selector);
        pvt.armEpochZero(c);
    }

    /// A grant that qualified in August (before this kernel's epoch zero) settles here;
    /// one that qualified a second before the window does not.
    function test_augustQualificationSettles_preWindowRefused() public {
        _arm(_config());
        vm.warp(epochStart);
        _settleGenesis(address(0xC1), keccak256("wallet-aug"), keccak256("anchor-aug"), GENESIS_START + 86400, 0);

        _settleGenesisExpect(ProvianPVT9.GenesisQualificationOutsideWindow.selector, address(0xC2), keccak256("wallet-early"), keccak256("anchor-early"), GENESIS_START - 1, 0);
    }

    /// The window runs through 2026-12-31: a grant qualified on 2026-11-10 settles on
    /// 2026-11-15 and one qualified at 2027-01-01T00:00:00Z (inclusive end) settles,
    /// while one qualified a second later is refused.
    function test_postOctober26GrantSettles_windowEndInclusive() public {
        _arm(_config());
        vm.warp(1794700800); // 2026-11-15
        _openThrough(uint64((block.timestamp - epochStart) / 7 days));
        _settleGenesis(address(0xD1), keccak256("wallet-nov"), keccak256("anchor-nov"), 1794268800, 1); // 2026-11-10
        assertGt(uint256(1794268800), uint256(OLD_GENESIS_END), "qualified after the old close");

        vm.warp(uint256(GENESIS_END) + 1 days);
        _openThrough(uint64((block.timestamp - epochStart) / 7 days));
        _settleGenesis(address(0xD2), keccak256("wallet-end"), keccak256("anchor-end"), GENESIS_END, 1);
        _settleGenesisExpect(ProvianPVT9.GenesisQualificationOutsideWindow.selector, address(0xD3), keccak256("wallet-late"), keccak256("anchor-late"), GENESIS_END + 1, 1);
    }

    /// A wallet already granted is refused a second grant on the same anchor.
    function test_sameAnchorRefusedTwice() public {
        _arm(_config());
        vm.warp(epochStart);
        _settleGenesis(address(0xE1), keccak256("wallet-x"), keccak256("anchor-x"), GENESIS_START + 1, 1);
        _settleGenesisExpect(ProvianPVT9.GenesisAnchorAlreadyUsed.selector, address(0xE1), keccak256("wallet-x"), keccak256("anchor-x"), GENESIS_START + 2, 1);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _openThrough(uint64 target) internal {
        while (pvt.lastOpenedEpoch() < target) {
            pvt.openNextEpoch();
        }
    }

    function _settleGenesis(address contributor, bytes32 walletId, bytes32 anchor, uint64 qualifiedAt, uint8 grantType)
        internal
    {
        _settleGenesisExpect(bytes4(0), contributor, walletId, anchor, qualifiedAt, grantType);
    }

    /// @dev Builds every argument first, so `expectRevert` binds to the settle call and
    ///      not to one of the view reads that assemble it.
    function _settleGenesisExpect(
        bytes4 expected,
        address contributor,
        bytes32 walletId,
        bytes32 anchor,
        uint64 qualifiedAt,
        uint8 grantType
    ) internal {
        ProvianPVT9.GenesisRecipient[] memory recipients = new ProvianPVT9.GenesisRecipient[](1);
        recipients[0] = ProvianPVT9.GenesisRecipient({contributor: contributor, claimCount: 1});
        ProvianPVT9.GenesisPEClaim[] memory claims = new ProvianPVT9.GenesisPEClaim[](1);
        claims[0] = ProvianPVT9.GenesisPEClaim({
            claimId: keccak256(abi.encode("claim", ++nonce)),
            walletId: walletId,
            oneTimeAnchor: anchor,
            grantType: grantType,
            qualifiedAt: qualifiedAt,
            reservedGrossAtomic: pvt.genesisGrantMaximum(grantType)
        });
        uint64 epoch = pvt.currentEpoch();
        uint256 cursor = pvt.nextFinalizedCursor();
        bytes32 policyHash = pvt.getEpochPolicy(epoch).policyHash;
        bytes32 batchId = keccak256(abi.encode("batch", ++nonce));
        if (expected != bytes4(0)) vm.expectRevert(expected);
        vm.prank(MINTER);
        pvt.settleGenesisPEBatch(
            batchId, epoch, policyHash, cursor, cursor + 1, recipients, claims
        );
    }
}
