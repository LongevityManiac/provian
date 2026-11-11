// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public prospective amounts. Owner-month invoices and accumulated
/// earnings are private relay records, never fields in this schedule.
abstract contract RecourseMembershipRules {
    struct MonthlyRule {
        uint256 firstMonth;
        uint256 participationBurn;
        uint256 noEarningsContribution;
        uint16 earningsBps;
        bytes32 signedRuleHash;
    }
    MonthlyRule[] internal monthlyRules;
    error InvalidMonthlyAccounting();
    event MonthlyRuleScheduled(uint256 indexed firstMonth, uint256 burn, uint256 contribution, uint16 bps, bytes32 signedRuleHash);
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
    function monthlyRuleCount() external view returns (uint256) { return monthlyRules.length; }
    function monthlyRuleAt(uint256 index) external view returns (MonthlyRule memory) { return monthlyRules[index]; }
}
