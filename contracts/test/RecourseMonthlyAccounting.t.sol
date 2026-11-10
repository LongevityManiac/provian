// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RecourseMonthlyAccounting} from "../src/RecourseMonthlyAccounting.sol";
contract MonthlyHarness is RecourseMonthlyAccounting {
    constructor() { _scheduleMonthlyRule(MonthlyRule(0, 100 ether, 100 ether, 100, bytes32(uint256(1))), 0); }
    function join(bytes32 id, uint256 month) external { _joinMonthly(id, month); }
    function leave(bytes32 id, uint256 month) external { _leaveMonthly(id, month); }
    function assess(bytes32 id, uint256 month) external { _assessMonthly(id, month); }
    function credit(bytes32 id, uint256 nowMonth, uint256 month, uint256 burn, uint256 reserve) external { _creditMonthly(id, nowMonth, month, burn, reserve); }
    function earn(bytes32 id, uint256 month, uint256 gross) external returns (uint256) { return _recordMonthlyEarnings(id, month, gross); }
    function protected(bytes32 id, uint256 month) external view returns (bool) { return _protectedMonthly(id, month); }
    function status(bytes32 id, uint256 month) external view returns (bool, bool, uint256) { return _monthlyStatus(id, month); }
    function rule(MonthlyRule memory next, uint256 month) external { _scheduleMonthlyRule(next, month); }
    function invoice(bytes32 id, uint256 generation, uint256 month) external view returns (MonthlyObligation memory) { return obligations[id][generation][month]; }
}
contract RecourseMonthlyAccountingTest is Test {
    MonthlyHarness ledger;
    bytes32 constant ID = bytes32(uint256(1));
    function setUp() public { ledger = new MonthlyHarness(); ledger.join(ID, 10); }
    function testEarnersStillBurnAndContributionIsOnePercentGross() public {
        assertEq(ledger.earn(ID, 10, 1000 ether), 10 ether);
        MonthlyHarness.MonthlyObligation memory o = ledger.invoice(ID, 1, 10);
        assertEq(o.burnDue, 100 ether);
        assertEq(o.reserveDue, 10 ether);
        ledger.credit(ID, 10, 10, 100 ether, 10 ether);
        ledger.assess(ID, 11);
        o = ledger.invoice(ID, 1, 10);
        assertEq(o.reserveDue, 10 ether);
        assertTrue(ledger.protected(ID, 12));
    }
    function testReadOnlyStatusDistinguishesPaidGraceAndLapsedWithoutKeeper() public {
        ledger.earn(ID, 10, 1000 ether);
        ledger.credit(ID, 10, 10, 100 ether, 10 ether);
        (bool active, bool grace, uint256 end) = ledger.status(ID, 11);
        assertTrue(active); assertFalse(grace); assertEq(end, 0);
        (active, grace, end) = ledger.status(ID, 12);
        assertTrue(active); assertTrue(grace); assertEq(end, 13);
        (active, grace, end) = ledger.status(ID, 13);
        assertFalse(active); assertFalse(grace); assertEq(end, 13);
    }
    function testNoEarningsRequiresBothSeparateAmountsAndGraceExpiresWithoutKeeper() public {
        ledger.credit(ID, 10, 10, 100 ether, 0);
        assertTrue(ledger.protected(ID, 11));
        assertFalse(ledger.protected(ID, 12));
        ledger.assess(ID, 11);
        MonthlyHarness.MonthlyObligation memory o = ledger.invoice(ID, 1, 10);
        assertEq(o.burnPaid, 100 ether);
        assertEq(o.reserveDue, 100 ether);
        ledger.credit(ID, 11, 10, 0, 100 ether);
        assertTrue(ledger.protected(ID, 12));
    }
    function testLatePaymentCannotReopenButRejoinStartsNewInterval() public {
        ledger.assess(ID, 40);
        assertFalse(ledger.protected(ID, 40));
        vm.expectRevert(RecourseMonthlyAccounting.InvalidMonthlyAccounting.selector);
        ledger.credit(ID, 40, 10, 100 ether, 100 ether);
        ledger.join(ID, 40);
        assertTrue(ledger.protected(ID, 40));
        assertFalse(ledger.protected(ID, 39));
        vm.expectRevert(RecourseMonthlyAccounting.InvalidMonthlyAccounting.selector);
        ledger.credit(ID, 40, 10, 100 ether, 100 ether);
    }
    function testProspectiveRulesDoNotRepriceOldMonthsAndBurnIsNotReserveCredit() public {
        ledger.rule(RecourseMonthlyAccounting.MonthlyRule(11, 150 ether, 75 ether, 200, bytes32(uint256(2))), 10);
        ledger.assess(ID, 11);
        assertEq(ledger.invoice(ID, 1, 10).burnDue, 100 ether);
        assertEq(ledger.invoice(ID, 1, 10).reserveDue, 100 ether);
        assertEq(ledger.invoice(ID, 1, 11).burnDue, 150 ether);
        assertEq(ledger.earn(ID, 11, 1000 ether), 20 ether);
        vm.expectRevert(RecourseMonthlyAccounting.InvalidMonthlyAccounting.selector);
        ledger.credit(ID, 11, 10, 200 ether, 0);
        vm.expectRevert(RecourseMonthlyAccounting.InvalidMonthlyAccounting.selector);
        ledger.rule(RecourseMonthlyAccounting.MonthlyRule(10, 1, 1, 100, bytes32(uint256(2))), 11);
    }
    function testSameMonthLeaveRejoinDoesNotDoubleChargeAndDustCarries() public {
        ledger.credit(ID, 10, 10, 100 ether, 0);
        for (uint256 i; i < 99; ++i) assertEq(ledger.earn(ID, 10, 1), 0);
        assertEq(ledger.earn(ID, 10, 1), 1);
        ledger.credit(ID, 10, 10, 0, 1);
        ledger.leave(ID, 10);
        ledger.join(ID, 10);
        assertEq(ledger.invoice(ID, 2, 10).burnPaid, 100 ether);
        assertEq(ledger.invoice(ID, 2, 10).reservePaid, 1);
    }
    function testLeaveStillFinalizesLastMonthWithoutRejoining() public {
        ledger.leave(ID, 10);
        ledger.assess(ID, 11);
        assertEq(ledger.invoice(ID, 1, 10).reserveDue, 100 ether);
        assertFalse(ledger.protected(ID, 11));
    }
    function testRejoinNextMonthPreservesClosedInvoice() public {
        ledger.leave(ID, 10);
        ledger.join(ID, 11);
        assertEq(ledger.invoice(ID, 1, 10).reserveDue, 100 ether);
        assertEq(ledger.invoice(ID, 2, 11).burnDue, 100 ether);
        assertTrue(ledger.protected(ID, 11));
    }

}
