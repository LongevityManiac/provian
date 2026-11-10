// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Calendar-month obligation ledger, independent of keeper execution time.
/// The integrating pool performs and verifies actual token burns/transfers before
/// calling credit. Monthly amounts are frozen from their prospective signed rule.
abstract contract RecourseMonthlyAccounting {
    struct MonthlyRule {
        uint256 firstMonth;
        uint256 participationBurn;
        uint256 noEarningsContribution;
        uint16 earningsBps;
        bytes32 signedRuleHash;
    }
    struct MonthlyObligation {
        bool initialized;
        bool earnings;
        uint256 burnDue;
        uint256 reserveDue;
        uint256 burnPaid;
        uint256 reservePaid;
        uint256 noEarningsAmount;
        uint16 earningsBps;
        uint256 earningsRemainder;
    }
    struct Enrollment {
        bool joined;
        uint256 startMonth;
        uint256 lastAssessedMonth;
        uint256 firstUnpaidMonth;
        uint256 endMonthExclusive;
        uint256 generation;
    }
    MonthlyRule[] internal monthlyRules;
    mapping(bytes32 => Enrollment) public enrollment;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => MonthlyObligation))) public obligations;
    error InvalidMonthlyAccounting();
    event MonthlyRuleScheduled(uint256 indexed firstMonth, uint256 burn, uint256 contribution, uint16 bps, bytes32 signedRuleHash);
    event MonthlyObligationRecorded(bytes32 indexed identity, uint256 indexed generation, uint256 indexed month, uint256 burn, uint256 contribution);
    event MonthlyObligationCredited(bytes32 indexed identity, uint256 indexed generation, uint256 indexed month, uint256 burn, uint256 contribution);

    function _scheduleMonthlyRule(MonthlyRule memory rule, uint256 nowMonth) internal {
        if (rule.signedRuleHash == bytes32(0) || rule.earningsBps > 10000
            || (monthlyRules.length != 0 && (rule.firstMonth <= nowMonth
                || rule.firstMonth <= monthlyRules[monthlyRules.length - 1].firstMonth))) revert InvalidMonthlyAccounting();
        monthlyRules.push(rule);
        emit MonthlyRuleScheduled(rule.firstMonth, rule.participationBurn, rule.noEarningsContribution, rule.earningsBps, rule.signedRuleHash);
    }
    function monthlyRule(uint256 month) public view returns (MonthlyRule memory) {
        for (uint256 i = monthlyRules.length; i > 0; --i) if (monthlyRules[i - 1].firstMonth <= month) return monthlyRules[i - 1];
        revert InvalidMonthlyAccounting();
    }
    function _initializeMonth(bytes32 identity, uint256 month) private {
        Enrollment storage e = enrollment[identity];
        MonthlyObligation storage o = obligations[identity][e.generation][month];
        if (o.initialized) return;
        MonthlyRule memory rule = monthlyRule(month);
        o.initialized = true;
        o.burnDue = rule.participationBurn;
        o.noEarningsAmount = rule.noEarningsContribution;
        o.earningsBps = rule.earningsBps;
        emit MonthlyObligationRecorded(identity, e.generation, month, o.burnDue, 0);
    }
    function _joinMonthly(bytes32 identity, uint256 nowMonth) internal {
        _assessMonthly(identity, nowMonth);
        Enrollment storage e = enrollment[identity];
        if (identity == bytes32(0) || _protectedMonthly(identity, nowMonth)) revert InvalidMonthlyAccounting();
        MonthlyObligation memory sameMonth = obligations[identity][e.generation][nowMonth];
        ++e.generation;
        e.joined = true;
        e.startMonth = nowMonth;
        e.lastAssessedMonth = nowMonth;
        e.firstUnpaidMonth = nowMonth;
        e.endMonthExclusive = 0;
        if (sameMonth.initialized) obligations[identity][e.generation][nowMonth] = sameMonth;
        _initializeMonth(identity, nowMonth);
    }
    function _leaveMonthly(bytes32 identity, uint256 nowMonth) internal {
        _assessMonthly(identity, nowMonth);
        enrollment[identity].joined = false;
        enrollment[identity].endMonthExclusive = nowMonth;
    }
    /// @dev Chronological assessment stops at expiry even if the keeper arrives years late.
    function _assessMonthly(bytes32 identity, uint256 nowMonth) internal {
        Enrollment storage e = enrollment[identity];
        // A closed episode still owes its final completed month's no-earnings
        // contribution. Closing or rejoining cannot erase this invoice.
        if (!e.joined) {
            if (e.generation != 0 && e.lastAssessedMonth < nowMonth) {
                MonthlyObligation storage closed = obligations[identity][e.generation][e.lastAssessedMonth];
                if (closed.initialized && !closed.earnings) closed.reserveDue = closed.noEarningsAmount;
            }
            return;
        }
        uint256 cursor = e.lastAssessedMonth;
        while (cursor < nowMonth) {
            MonthlyObligation storage previous = obligations[identity][e.generation][cursor];
            if (!previous.earnings) previous.reserveDue = previous.noEarningsAmount;
            ++cursor;
            _advancePaid(identity, cursor);
            if (e.firstUnpaidMonth + 1 < cursor) {
                e.joined = false;
                e.endMonthExclusive = e.firstUnpaidMonth + 2;
                e.lastAssessedMonth = cursor;
                return;
            }
            _initializeMonth(identity, cursor);
        }
        e.lastAssessedMonth = nowMonth;
        _advancePaid(identity, nowMonth);
    }
    function _advancePaid(bytes32 identity, uint256 nowMonth) private {
        Enrollment storage e = enrollment[identity];
        while (e.firstUnpaidMonth < nowMonth) {
            MonthlyObligation storage o = obligations[identity][e.generation][e.firstUnpaidMonth];
            if (!o.initialized || o.burnPaid != o.burnDue || o.reservePaid != o.reserveDue) break;
            ++e.firstUnpaidMonth;
        }
    }
    /// @dev Gross attributable issuance is supplied by the kernel settlement path,
    /// not the already-reduced contributor payout. 100bps therefore leaves 98% of
    /// human gross after the two immutable 0.5% allocations.
    function _recordMonthlyEarnings(bytes32 identity, uint256 nowMonth, uint256 gross) internal returns (uint256 contribution) {
        _assessMonthly(identity, nowMonth);
        if (!_protectedMonthly(identity, nowMonth) || gross == 0) return 0;
        Enrollment storage e = enrollment[identity];
        MonthlyObligation storage o = obligations[identity][e.generation][nowMonth];
        o.earnings = true;
        // Split quotient/remainder avoids overflowing gross * bps.
        uint256 remainder = (gross % 10000) * o.earningsBps + o.earningsRemainder;
        contribution = (gross / 10000) * o.earningsBps + remainder / 10000;
        o.earningsRemainder = remainder % 10000;
        o.reserveDue += contribution;
    }
    function _creditMonthly(bytes32 identity, uint256 nowMonth, uint256 month, uint256 burn, uint256 reserve) internal {
        _assessMonthly(identity, nowMonth);
        Enrollment storage e = enrollment[identity];
        // No payment after expiry can restore the expired interval.
        if (!_protectedMonthly(identity, nowMonth) || month < e.startMonth || month > nowMonth) revert InvalidMonthlyAccounting();
        MonthlyObligation storage o = obligations[identity][e.generation][month];
        if (burn > o.burnDue - o.burnPaid || reserve > o.reserveDue - o.reservePaid) revert InvalidMonthlyAccounting();
        o.burnPaid += burn;
        o.reservePaid += reserve;
        _advancePaid(identity, nowMonth);
        emit MonthlyObligationCredited(identity, e.generation, month, burn, reserve);
    }
    function _monthlyStatus(bytes32 identity, uint256 nowMonth) internal view
        returns (bool protectedNow, bool grace, uint256 endMonthExclusive)
    {
        Enrollment storage e = enrollment[identity];
        if (!e.joined || nowMonth < e.startMonth) return (false, false, e.endMonthExclusive);
        // Project completed calendar invoices even when no keeper has assessed
        // them yet. A paid month never becomes grace merely because time passed.
        for (uint256 m = e.firstUnpaidMonth; m < nowMonth; ++m) {
            MonthlyObligation storage o = obligations[identity][e.generation][m];
            if (!o.initialized || o.burnPaid < o.burnDue
                || o.reservePaid < (o.earnings ? o.reserveDue : o.noEarningsAmount)) {
                uint256 expiry = m + 2;
                return (nowMonth < expiry, nowMonth < expiry, expiry);
            }
        }
        return (true, false, 0);
    }
    function _protectedMonthly(bytes32 identity, uint256 nowMonth) internal view returns (bool protectedNow) {
        (protectedNow,,) = _monthlyStatus(identity, nowMonth);
    }
}
