// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseMonthlyAccounting} from "../src/RecourseMonthlyAccounting.sol";
import {RecoursePoolHistory} from "../src/RecoursePoolHistory.sol";
import {ProvianMemberRecoursePool} from "../src/ProvianMemberRecoursePool.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
contract MemberAuthorizationMock {
    bool public cryptographicBreak;
    function lastGoodBlock() external pure returns (uint256) { return 100; }
    function predecessor() external pure returns (address) { return address(0x5555); }
    function reversalHistoryReady() external pure returns (bool) { return true; }
    mapping(bytes32 => bool) public restoredIdentity;
    function setBreak(bool enabled) external { cryptographicBreak = enabled; }
    function restore(bytes32 identity, address destination) external {
        restoredIdentity[identity] = true;
        ++ownerAuthorizationNonce[identity]; recoveredDestination[identity] = destination;
    }
    mapping(bytes32 => bytes32) public reversalOutcome;
    function setOutcome(bytes32 request, bytes32 digest) external { reversalOutcome[request] = digest; }
    mapping(bytes32 => uint256) public ownerAuthorizationNonce;
    mapping(bytes32 => address) public recoveredDestination;
    function recover(bytes32 identity, address destination) external {
        ++ownerAuthorizationNonce[identity]; recoveredDestination[identity] = destination;
    }
}
contract MemberTokenMock {
    address public immutable BOOTSTRAP_ADMIN;
    address public restorationAuthority;
    MemberAuthorizationMock public ownerAuthorization;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    constructor() { BOOTSTRAP_ADMIN = msg.sender; restorationAuthority = msg.sender; ownerAuthorization = new MemberAuthorizationMock(); }
    function mint(address who, uint256 amount) external { balanceOf[who] += amount; totalSupply += amount; }
    function mintWork(ProvianMemberRecoursePool pool, address who, uint256 gross, uint256 net) external {
        uint256 diverted = pool.divertIssuance(who, gross, net);
        balanceOf[who] += net - diverted;
        balanceOf[address(pool)] += diverted;
        totalSupply += net;
    }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true; }
    function burnFrom(address from, uint256 amount) external { allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; totalSupply -= amount; }
}
contract ProvianMemberRecoursePoolTest is Test {
    MemberTokenMock token;
    ProvianMemberRecoursePool pool;
    ProvianProtocolPointer pointer;
    bytes32 constant ID = bytes32(uint256(1));
    function setUp() public {
        vm.warp(1705276800); vm.roll(100); // January, then calendar boundaries below.
        token = new MemberTokenMock(); pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        pool = new ProvianMemberRecoursePool(ProvianPVT9(address(token)), address(this), address(this), pointer, RecourseMonthlyAccounting.MonthlyRule(0, 100 ether, 100 ether, 100, sha256("signed test rule")), RecoursePoolHistory.PoolSnapshot(address(0), 0, bytes32(0), 0, false));
        address[10] memory addresses; bytes32[10] memory hashes;
        for (uint256 i; i < 10; ++i) { addresses[i] = address(uint160(1000+i)); vm.etch(addresses[i], hex"00"); }
        addresses[0] = address(token); addresses[8] = address(pool); addresses[9] = address(pool.settlement());
        for (uint256 i; i < 10; ++i) hashes[i] = addresses[i].codehash;
        vm.prank(pointer.authority()); pointer.publish(0, addresses, hashes);
        pool.bind(ID, address(this)); token.approve(address(pool), type(uint256).max);
    }
    function testCustodyTokenAccessorMatchesReserveToken() public view {
        assertEq(pool.pvt(), address(token));
        assertEq(address(pool.token()), pool.pvt());
    }
    function testBurnAndNoEarningsContributionAreSeparateAndExitIsDirect() public {
        token.mint(address(this), 1000 ether); pool.enroll(ID);
        assertEq(token.totalSupply(), 900 ether); assertEq(pool.availableReserve(), 0);
        vm.warp(1706745600); pool.settleMonth(ID); // February 1
        assertEq(token.totalSupply(), 800 ether); // January and February participation burns.
        assertEq(pool.availableReserve(), 100 ether); // January no-earnings contribution.
        assertEq(token.balanceOf(address(this)), 700 ether);
        assertEq(pool.redeem(ID, 100 ether), 100 ether);
        assertEq(token.balanceOf(address(this)), 800 ether);
        assertEq(token.totalSupply(), 800 ether);
        (bool active,,,) = pool.membershipState(ID);
        assertFalse(active);
        pool.enroll(ID);
        (active,,,) = pool.membershipState(ID);
        assertTrue(active);
        assertEq(token.totalSupply(), 800 ether); // Same-month rejoining adds no second burn.
    }
    function testRecoveredAddressContributesOnItsFirstIssuanceWithoutAnotherMemberAction() public {
        token.mint(address(this), 1000 ether); pool.enroll(ID);
        address destination = address(0xBEEF);
        token.ownerAuthorization().recover(ID, destination);
        pool.bind(ID, destination); // Registry's atomic bindRecovered callback.
        assertEq(pool.primaryAddress(ID), destination);
        token.mintWork(pool, destination, 1000 ether, 990 ether);
        assertEq(token.balanceOf(destination), 980 ether);
        assertEq(pool.availableReserve(), 10 ether);
    }
    function testEarningsStillBurnAndRetain98PercentGrossAfterFloors() public {
        token.mint(address(this), 100 ether); pool.enroll(ID);
        token.mintWork(pool, address(this), 100 ether, 99 ether); // Kernel's contributor allocation of 100 gross.
        address adapter = address(pool.settlement());
        vm.prank(adapter); pool.collectMintContribution(address(this), 100 ether, 99 ether, 1);
        assertEq(token.balanceOf(address(this)), 98 ether);
        assertEq(pool.availableReserve(), 1 ether);
        vm.warp(1706745600); pool.settleMonth(ID);
        assertEq(pool.availableReserve(), 1 ether); // No extra no-earnings contribution for January.
    }
    function testGraceExpiresWithoutKeeperAndRejoinNeverCoversLapsedLoss() public {
        pool.enroll(ID);
        vm.warp(1706745600);
        (bool protectedNow, bool grace,,) = pool.membershipState(ID);
        assertTrue(protectedNow); assertTrue(grace);
        vm.warp(1709251200); // March 1
        (protectedNow,,,) = pool.membershipState(ID); assertFalse(protectedNow);
        pool.settleMonth(ID);
        token.mint(address(this), 500 ether);
        pool.enroll(ID);
        uint256 generation;
        (protectedNow,,generation,) = pool.membershipState(ID);
        assertTrue(protectedNow); assertEq(generation, 2);
        vm.roll(101);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1);
        ds[0] = ProvianMemberRecoursePool.Determination(bytes32(uint256(10)), ID, bytes32(uint256(11)), 1 ether, sha256("loss"), 0, 1, 100, pool.calendarMonth(block.timestamp));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
    }
    function testDeterminationAllocationsSurviveMemberExitAndRequireActualMembership() public {
        token.mint(address(this), 1000 ether); pool.enroll(ID);
        vm.warp(1706745600); pool.settleMonth(ID); vm.roll(101);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1);
        ds[0] = ProvianMemberRecoursePool.Determination(bytes32(uint256(10)), ID, bytes32(uint256(11)), 40 ether, sha256("loss"), 0, 1, 100, pool.calendarMonth(block.timestamp)-1);
        vm.prank(address(7)); vm.expectRevert(ProvianMemberRecoursePool.Unauthorized.selector); pool.determine(ds);
        token.ownerAuthorization().setOutcome(ds[0].request, sha256(abi.encode(ds[0].request, ID, address(this), ds[0].shortfall, ds[0].evidenceHash)));
        pool.determine(ds);
        pool.leave(ID);
        assertEq(pool.redeem(ID, 100 ether), 60 ether);
        assertEq(pool.withdrawRestoration(ds[0].request, ID), 40 ether);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
    }
    function testCompleteReversalRecordsFinalAcceptedOutcomeWithoutAllocatingReserves() public {
        token.mint(address(this),1000 ether);pool.enroll(ID);
        vm.warp(1706745600);pool.settleMonth(ID);vm.roll(101);
        ProvianMemberRecoursePool.Determination memory d = ProvianMemberRecoursePool.Determination(
            bytes32(uint256(10)),ID,bytes32(uint256(11)),0,sha256("loss"),0,1,100,pool.calendarMonth(block.timestamp)-1);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector);pool.recordReversalOnly(d);
        token.ownerAuthorization().setOutcome(d.request,sha256(abi.encode(d.request,ID,address(this),uint256(0),d.evidenceHash)));
        pool.recordReversalOnly(d);
        assertTrue(pool.determined(d.request));assertTrue(pool.occurrenceDetermined(ID,d.occurrence));
        assertEq(pool.allocatedRestorations(),0);assertEq(pool.availableReserve(),100 ether);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector);pool.recordReversalOnly(d);
    }
    function testPermissionlessDeliveryPaysOnlyTheIndependentlyRecoveredOwnerOnce() public {
        token.mint(address(this),1000 ether);pool.enroll(ID);
        vm.warp(1706745600);pool.settleMonth(ID);vm.roll(101);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1);
        ds[0] = ProvianMemberRecoursePool.Determination(bytes32(uint256(10)),ID,bytes32(uint256(11)),40 ether,sha256("loss"),0,1,100,pool.calendarMonth(block.timestamp)-1);
        token.ownerAuthorization().setOutcome(ds[0].request,sha256(abi.encode(ds[0].request,ID,address(this),40 ether,ds[0].evidenceHash)));
        pool.determine(ds);
        address recovered = address(0xAABB); address stranger = address(0xCCDD);
        token.ownerAuthorization().recover(ID,recovered);
        vm.prank(stranger);assertEq(pool.deliverRestoration(ds[0].request,ID),40 ether);
        assertEq(token.balanceOf(recovered),40 ether);assertEq(token.balanceOf(stranger),0);
        vm.prank(stranger);vm.expectRevert();pool.deliverRestoration(ds[0].request,ID);
        assertEq(pool.allocatedRestorations(),0);
    }
    function testBoundSecondaryIssuanceDivertsWithoutPrimaryFundsOrAllowance() public {
        token.mint(address(this), 100 ether); pool.enroll(ID);
        address secondary = address(0x999);
        pool.bind(ID, secondary);
        token.mintWork(pool, secondary, 100 ether, 99 ether);
        assertEq(token.balanceOf(secondary), 98 ether);
        assertEq(pool.availableReserve(), 1 ether);
        assertEq(token.balanceOf(address(this)), 0);
    }
    function testDonationAndUnpaidBurnCannotPreventCurrentIssuanceDiversion() public {
        pool.enroll(ID);
        token.mintWork(pool, address(this), 100 ether, 99 ether);
        token.mint(address(pool), 1000000000 ether);
        token.mintWork(pool, address(this), 100, 99);
        address adapter = address(pool.settlement());
        vm.prank(adapter); pool.collectMintContribution(address(this), 100, 99, 1);
        assertEq(pool.accountedBacking(), 1 ether + 1);
        assertEq(token.balanceOf(address(this)), 98 ether + 98);
    }
    function testPoolRestoresOnlyTheExactProvenReversalRemainder() public {
        token.mint(address(this), 1000 ether); pool.enroll(ID);
        token.mintWork(pool, address(this), 10000 ether, 9900 ether);
        vm.roll(102);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1);
        ds[0] = ProvianMemberRecoursePool.Determination(bytes32(uint256(10)), ID, bytes32(uint256(11)), 40 ether,
            sha256("canonical remainder TEST ONLY"), 0, 1, 101, pool.calendarMonth(block.timestamp));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
        token.ownerAuthorization().setOutcome(ds[0].request, sha256(abi.encode(ds[0].request, ID, address(this), uint256(40 ether), ds[0].evidenceHash)));
        ds[0].shortfall = 41 ether;
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
        ds[0].shortfall = 40 ether; pool.determine(ds);
        (bytes32 identity, uint256 assigned, bool withdrawn) = pool.restorationAllocations(ds[0].request);
        assertEq(identity, ID); assertEq(assigned, 40 ether); assertFalse(withdrawn);
        assertEq(pool.allocatedRestorations(), 40 ether);
    }
    function testRepeatedLeaveCannotMoveHistoricalClosurePastLoss() public {
        token.mint(address(this), 1000 ether); pool.enroll(ID);
        vm.roll(101); pool.leave(ID);
        vm.roll(103);
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.leave(ID);
        (, uint256 endBlock,) = pool.membershipPeriods(ID, 1);
        assertEq(endBlock, 101);
        ProvianMemberRecoursePool.Determination[] memory ds = new ProvianMemberRecoursePool.Determination[](1);
        ds[0] = ProvianMemberRecoursePool.Determination(bytes32(uint256(10)), ID, bytes32(uint256(11)), 40 ether,
            sha256("loss while left"), 0, 1, 102, pool.calendarMonth(block.timestamp));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector); pool.determine(ds);
    }

}
