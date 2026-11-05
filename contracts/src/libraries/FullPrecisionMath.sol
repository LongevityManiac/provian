// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 512-bit multiplication followed by exact floor division.
library FullPrecisionMath {
    error DivisionByZero();
    error MulDivOverflow();

    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            if (denominator == 0) revert DivisionByZero();

            uint256 productLow;
            uint256 productHigh;
            assembly ("memory-safe") {
                let mm := mulmod(x, y, not(0))
                productLow := mul(x, y)
                productHigh := sub(sub(mm, productLow), lt(mm, productLow))
            }

            if (productHigh == 0) return productLow / denominator;
            if (denominator <= productHigh) revert MulDivOverflow();

            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(x, y, denominator)
                productHigh := sub(productHigh, gt(remainder, productLow))
                productLow := sub(productLow, remainder)
            }

            uint256 powerOfTwo = denominator & (0 - denominator);
            assembly ("memory-safe") {
                denominator := div(denominator, powerOfTwo)
                productLow := div(productLow, powerOfTwo)
                powerOfTwo := add(div(sub(0, powerOfTwo), powerOfTwo), 1)
            }
            productLow |= productHigh * powerOfTwo;

            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;

            result = productLow * inverse;
        }
    }
}
