// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/// @dev https://oracle.binance.com/docs/price-feeds/feed-registry/feed-registry-api-reference
interface IBinanceOracle {
    function latestRoundData(address base, address quote) external view returns (
        uint80 roundId, 
        int256 answer, 
        uint256 startedAt, 
        uint256 updatedAt, 
        uint80 answeredInRound
    );
    function decimals(address base, address quote) external view returns (uint8);
}