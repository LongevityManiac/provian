// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {FullPrecisionMath} from "./libraries/FullPrecisionMath.sol";

interface IRecourseReserveToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Member-owned reserve shares and irrevocable, directly withdrawable outcomes.
/// The integrating pool authenticates membership, authority and recovered destinations.
/// No admin receives a reserve share or has a withdrawal path.
abstract contract RecourseReserveAccounting {
    using FullPrecisionMath for uint256;
    IRecourseReserveToken internal immutable reserveToken;
    uint256 public reserveGeneration;
    uint256 public totalReserveShares;
    uint256 public allocatedRestorations;
    uint256 public accountedBacking;
    mapping(uint256 => mapping(bytes32 => uint256)) public reserveShares;
    struct RestorationAllocation { bytes32 identity; uint256 amount; bool withdrawn; }
    mapping(bytes32 => RestorationAllocation) public restorationAllocations;
    error InvalidReserveAccounting();
    event ReserveContributed(bytes32 indexed identity, uint256 indexed generation, uint256 amount, uint256 shares);
    event ReserveRedeemed(bytes32 indexed identity, uint256 indexed generation, address destination, uint256 amount, uint256 shares);
    event RestorationAllocated(bytes32 indexed request, bytes32 indexed identity, uint256 requested, uint256 assigned);
    event RestorationWithdrawn(bytes32 indexed request, address indexed destination, uint256 amount);

    constructor(IRecourseReserveToken token_) { reserveToken = token_; }
    function availableReserve() public view returns (uint256) {
        uint256 balance = reserveToken.balanceOf(address(this));
        if (balance < allocatedRestorations) revert InvalidReserveAccounting();
        return balance - allocatedRestorations;
    }
    /// @dev Called after owner authorization; transfer is measured rather than trusting a return flag.
    function _contributeReserve(bytes32 identity, address payer, uint256 amount) internal returns (uint256 shares) {
        if (identity == bytes32(0) || amount == 0) revert InvalidReserveAccounting();
        uint256 available = accountedBacking;
        if (available == 0 && totalReserveShares != 0) {
            ++reserveGeneration;
            totalReserveShares = 0;
        }
        shares = totalReserveShares == 0 ? amount : amount.mulDiv(totalReserveShares, available);
        // No silently rounded-to-zero ownership, including after unsolicited token donations.
        if (shares == 0) revert InvalidReserveAccounting();
        uint256 beforeBalance = reserveToken.balanceOf(address(this));
        if (!reserveToken.transferFrom(payer, address(this), amount)
            || reserveToken.balanceOf(address(this)) != beforeBalance + amount) revert InvalidReserveAccounting();
        accountedBacking += amount;
        reserveShares[reserveGeneration][identity] += shares;
        totalReserveShares += shares;
        emit ReserveContributed(identity, reserveGeneration, amount, shares);
    }
    /// @dev Only the integrating kernel's synchronous mint callback may invoke
    /// this credit; that transaction must immediately mint exactly amount to pool.
    function _creditIssuanceReserve(bytes32 identity, uint256 amount) internal {
        if (amount == 0) return;
        uint256 available = accountedBacking;
        if (available == 0 && totalReserveShares != 0) { ++reserveGeneration; totalReserveShares = 0; }
        uint256 shares = totalReserveShares == 0 ? amount : amount.mulDiv(totalReserveShares, available);
        if (shares == 0) revert InvalidReserveAccounting();
        accountedBacking += amount;
        reserveShares[reserveGeneration][identity] += shares;
        totalReserveShares += shares;
        emit ReserveContributed(identity, reserveGeneration, amount, shares);
    }
    /// @dev Caller verifies current bound destination, and can close membership separately.
    /// All allocated restoration funds are already excluded. No relay or authority is needed.
    function _redeemReserve(bytes32 identity, address destination, uint256 shares) internal returns (uint256 amount) {
        uint256 owned = reserveShares[reserveGeneration][identity];
        if (identity == bytes32(0) || destination == address(0) || destination == address(this)
            || shares == 0 || shares > owned) revert InvalidReserveAccounting();
        amount = shares.mulDiv(accountedBacking, totalReserveShares);
        accountedBacking -= amount;
        reserveShares[reserveGeneration][identity] = owned - shares;
        totalReserveShares -= shares;
        if (amount != 0 && !reserveToken.transfer(destination, amount)) revert InvalidReserveAccounting();
        emit ReserveRedeemed(identity, reserveGeneration, destination, amount, shares);
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
        for (uint256 i; i < requests.length; ++i) {
            uint256 amount = shortfalls[i].mulDiv(distributable, liabilities);
            restorationAllocations[requests[i]] = RestorationAllocation(identities[i], amount, false);
            allocatedRestorations += amount;
            emit RestorationAllocated(requests[i], identities[i], shortfalls[i], amount);
        }
        // Unsolicited donations fund determinations first; they never inflate
        // the share price or force an earned contribution to round to zero.
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
