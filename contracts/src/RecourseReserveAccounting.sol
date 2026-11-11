// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {FullPrecisionMath} from "./libraries/FullPrecisionMath.sol";

interface IRecourseReserveToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Nonrefundable member contributions and irrevocable restoration allocations.
/// The integrating pool authenticates membership, authority and recovered destinations.
/// Contributions confer no redemption right. Only allocated restorations can leave.
abstract contract RecourseReserveAccounting {
    using FullPrecisionMath for uint256;
    IRecourseReserveToken internal immutable reserveToken;
    uint256 public allocatedRestorations;
    uint256 public accountedBacking;
    struct RestorationAllocation { bytes32 identity; uint256 amount; bool withdrawn; }
    mapping(bytes32 => RestorationAllocation) public restorationAllocations;
    error InvalidReserveAccounting();
    event ReserveContributed(bytes32 indexed identity, uint256 amount);
    event RestorationRatio(uint256 availableReserve, uint256 acceptedShortfall, uint256 distributable);
    event RestorationAllocated(bytes32 indexed request, bytes32 indexed identity, uint256 requested, uint256 assigned);
    event RestorationWithdrawn(bytes32 indexed request, address indexed destination, uint256 amount);

    constructor(IRecourseReserveToken token_) { reserveToken = token_; }
    function availableReserve() public view returns (uint256) {
        uint256 balance = reserveToken.balanceOf(address(this));
        if (balance < allocatedRestorations) revert InvalidReserveAccounting();
        return balance - allocatedRestorations;
    }
    /// @dev Contributions are permanent funding, never refundable deposits.
    function _contributeReserve(bytes32 identity, address payer, uint256 amount) internal {
        if (identity == bytes32(0) || amount == 0) revert InvalidReserveAccounting();
        uint256 beforeBalance = reserveToken.balanceOf(address(this));
        if (!reserveToken.transferFrom(payer, address(this), amount)
            || reserveToken.balanceOf(address(this)) != beforeBalance + amount) revert InvalidReserveAccounting();
        accountedBacking += amount;
        emit ReserveContributed(identity, amount);
    }
    /// @dev Only the integrating kernel's synchronous mint callback may invoke
    /// this credit; that transaction must immediately mint exactly amount to pool.
    function _creditIssuanceReserve(bytes32 identity, uint256 amount) internal {
        if (amount == 0) return;
        if (identity == bytes32(0)) revert InvalidReserveAccounting();
        accountedBacking += amount;
        emit ReserveContributed(identity, amount);
    }
    /// @dev The authority executes one published determination batch. All accepted
    /// requests in the batch share exactly the same available reserve and denominator.
    /// Allocation is final and withdrawable by the current bound owner without relay.
    function _allocateRestorations(bytes32[] memory requests, bytes32[] memory identities,
        uint256[] memory shortfalls) internal {
        if (requests.length == 0 || requests.length != identities.length || requests.length != shortfalls.length) revert InvalidReserveAccounting();
        uint256 liabilities;
        for (uint256 i; i < requests.length; ++i) {
            if (requests[i] == bytes32(0) || identities[i] == bytes32(0) || shortfalls[i] == 0
                || restorationAllocations[requests[i]].identity != bytes32(0)) revert InvalidReserveAccounting();
            for (uint256 j; j < i; ++j) if (requests[i] == requests[j]) revert InvalidReserveAccounting();
            liabilities += shortfalls[i];
        }
        uint256 reserve = availableReserve();
        uint256 distributable = reserve < liabilities ? reserve : liabilities;
        emit RestorationRatio(reserve, liabilities, distributable);
        for (uint256 i; i < requests.length; ++i) {
            uint256 amount = shortfalls[i].mulDiv(distributable, liabilities);
            restorationAllocations[requests[i]] = RestorationAllocation(identities[i], amount, false);
            allocatedRestorations += amount;
            emit RestorationAllocated(requests[i], identities[i], shortfalls[i], amount);
        }
        // Unsolicited transfers fund determinations before recorded contributions.
        uint256 remaining = availableReserve();
        if (accountedBacking > remaining) accountedBacking = remaining;
    }
    function _withdrawRestoration(bytes32 request, bytes32 identity, address destination) internal returns (uint256 amount) {
        RestorationAllocation storage allocation = restorationAllocations[request];
        if (identity == bytes32(0) || allocation.identity != identity || allocation.withdrawn
            || destination == address(0) || destination == address(this)) revert InvalidReserveAccounting();
        amount = allocation.amount;
        allocation.withdrawn = true;
        allocatedRestorations -= amount;
        if (amount != 0 && !reserveToken.transfer(destination, amount)) revert InvalidReserveAccounting();
        emit RestorationWithdrawn(request, destination, amount);
    }
}
