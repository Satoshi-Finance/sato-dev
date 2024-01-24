// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IPriceFeed.sol";
import "./Dependencies/IBinanceOracle.sol";
import "./Dependencies/AggregatorV3Interface.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/BaseMath.sol";
import "./Dependencies/LiquityMath.sol";
import "./Dependencies/console.sol";

/*
* PriceFeed for mainnet deployment, to be connected to Chainlink's live BTC:USD aggregator reference 
* contract, and a backup feed which connects to Binance Oracle registry.
*
* The PriceFeed uses Chainlink as primary oracle, and Binance Oracle as fallback. It contains logic for
* switching oracles based on oracle failures, timeouts, and conditions for returning to the primary
* Chainlink oracle.
*/
contract PriceFeed is Ownable, CheckContract, BaseMath, IPriceFeed {
    using SafeMath for uint256;

    string constant public NAME = "PriceFeed";

    AggregatorV3Interface public priceAggregator;  // Mainnet Chainlink aggregator
    IBinanceOracle public backupFeed;  // backup oracle feed

    address public BTCUSD_BNO_BASE;
    address public BTCUSD_BNO_QUOTE;

    // Use to convert a price answer to an 18-digit precision uint
    uint constant public TARGET_DIGITS = 18;  

    // Maximum time period allowed since Chainlink's latest round data timestamp, beyond which Chainlink is considered frozen.
    uint constant public TIMEOUT = 14400;  // 4 hours: 60 * 60 * 4
    
    // Maximum deviation allowed between two consecutive Chainlink oracle prices. 18-digit precision.
    uint constant public MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND =  5e17; // 50%

    /* 
    * The maximum relative price difference between two oracle responses allowed in order for the PriceFeed
    * to return to using the Chainlink oracle. 18-digit precision.
    */
    uint constant public MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES = 5e16; // 5%

    // The last good price seen from an oracle by Liquity
    uint public lastGoodPrice;

    struct ChainlinkResponse {
        uint80 roundId;
        int256 answer;
        uint256 timestamp;
        bool success;
        uint8 decimals;
    }

    enum Status {
        chainlinkWorking, 
        usingBnOChainlinkUntrusted, 
        bothOraclesUntrusted,
        usingBnOChainlinkFrozen, 
        usingChainlinkBnOUntrusted
    }

    // The current status of the PricFeed, which determines the conditions for the next price fetch attempt
    Status public status;

    event LastGoodPriceUpdated(uint _lastGoodPrice);
    event PriceFeedStatusChanged(Status newStatus);

    // --- Dependency setters ---
    
    function setAddresses(
        address _priceAggregatorAddress,
        address _bnOracleAddress,
        address _bnOracleBTCAddress,
        address _bnOracleUSDAddress
    )
        external
        onlyOwner
    {
        checkContract(_priceAggregatorAddress);
        checkContract(_bnOracleAddress);
       
        priceAggregator = AggregatorV3Interface(_priceAggregatorAddress);
        backupFeed = IBinanceOracle(_bnOracleAddress);
        BTCUSD_BNO_BASE = _bnOracleBTCAddress;
        BTCUSD_BNO_QUOTE = _bnOracleUSDAddress;

        // Explicitly set initial system status
        status = Status.chainlinkWorking;

        // Get an initial price from Chainlink to serve as first reference for lastGoodPrice
        ChainlinkResponse memory chainlinkResponse = _getCurrentChainlinkResponse();
        ChainlinkResponse memory prevChainlinkResponse = _getPrevChainlinkResponse(chainlinkResponse.roundId, chainlinkResponse.decimals);
        
        require(!_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse) && !_chainlinkIsFrozen(chainlinkResponse), 
            "PriceFeed: Chainlink must be working and current");

        _storeChainlinkPrice(chainlinkResponse);

        _renounceOwnership();
    }

    // --- Functions ---

    /*
    * fetchPrice():
    * Returns the latest price obtained from the Oracle. Called by Liquity functions that require a current price.
    *
    * Also callable by anyone externally.
    *
    * Non-view function - it stores the last good price seen by Liquity.
    *
    * Uses a main oracle (Chainlink) and a fallback oracle (Binance Oracle) in case Chainlink fails. If both fail, 
    * it uses the last good price seen by Liquity.
    *
    */
    function fetchPrice() external override returns (uint) {
        // Get current and previous price data from Chainlink, and current price data from backup
        ChainlinkResponse memory chainlinkResponse = _getCurrentChainlinkResponse();
        ChainlinkResponse memory prevChainlinkResponse = _getPrevChainlinkResponse(chainlinkResponse.roundId, chainlinkResponse.decimals);
        ChainlinkResponse memory backupResponse = _getCurrentBackupResponse();

        // --- CASE 1: System fetched last price from Chainlink  ---
        if (status == Status.chainlinkWorking) {
            // If Chainlink is broken, try backup
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                // If backup is broken then both oracles are untrusted, so return the last good price
                if (_backupIsBroken(backupResponse)) {
                    _changeStatus(Status.bothOraclesUntrusted);
                    return lastGoodPrice; 
                }
                /*
                * If backup is only frozen but otherwise returning valid data, return the last good price.
                */
                if (_chainlinkIsFrozen(backupResponse)) {
                    _changeStatus(Status.usingBnOChainlinkUntrusted);
                    return lastGoodPrice;
                }
                
                // If Chainlink is broken and backup is working, switch to backup and return current backup price
                _changeStatus(Status.usingBnOChainlinkUntrusted);
                return _storeChainlinkPrice(backupResponse);
            }

            // If Chainlink is frozen, try backup
            if (_chainlinkIsFrozen(chainlinkResponse)) {          
                // If backup is broken too, remember backup broke, and return last good price
                if (_backupIsBroken(backupResponse)) {
                    _changeStatus(Status.usingChainlinkBnOUntrusted);
                    return lastGoodPrice;     
                }

                // If backup is frozen or working, remember Chainlink froze, and switch to backup
                _changeStatus(Status.usingBnOChainlinkFrozen);
               
                if (_chainlinkIsFrozen(backupResponse)) {return lastGoodPrice;}

                // If backup is working, use it
                return _storeChainlinkPrice(backupResponse);
            }

            // If Chainlink price has changed by > 50% between two consecutive rounds, compare it to backup's price
            if (_chainlinkPriceChangeAboveMax(chainlinkResponse, prevChainlinkResponse)) {
                // If backup is broken, both oracles are untrusted, and return last good price
                 if (_backupIsBroken(backupResponse)) {
                    _changeStatus(Status.bothOraclesUntrusted);
                    return lastGoodPrice;     
                }

                // If backup is frozen, switch to backup and return last good price 
                if (_chainlinkIsFrozen(backupResponse)) { 
                    _changeStatus(Status.usingBnOChainlinkUntrusted);
                    return lastGoodPrice;
                }

                /* 
                * If backup is live and both oracles have a similar price, conclude that Chainlink's large price deviation between
                * two consecutive rounds was likely a legitmate market price movement, and so continue using Chainlink 
                */
                if (_bothOraclesSimilarPrice(chainlinkResponse, backupResponse)) {
                    return _storeChainlinkPrice(chainlinkResponse);
                }               

                // If backup is live but the oracles differ too much in price, conclude that Chainlink's initial price deviation was
                // an oracle failure. Switch to backup, and use backup price
                _changeStatus(Status.usingBnOChainlinkUntrusted);
                return _storeChainlinkPrice(backupResponse);
            }

            // If Chainlink is working and backup is broken, remember backup is broken
            if (_backupIsBroken(backupResponse)) {
                _changeStatus(Status.usingChainlinkBnOUntrusted);    
            }   

            // If Chainlink is working, return Chainlink current price (no status change)
            return _storeChainlinkPrice(chainlinkResponse);
        }


        // --- CASE 2: The system fetched last price from backup --- 
        if (status == Status.usingBnOChainlinkUntrusted) { 
            // If both backup and Chainlink are live, unbroken, and reporting similar prices, switch back to Chainlink
            if (_bothOraclesLiveAndUnbrokenAndSimilarPrice(chainlinkResponse, prevChainlinkResponse, backupResponse)) {
                _changeStatus(Status.chainlinkWorking);
                return _storeChainlinkPrice(chainlinkResponse);
            }

            if (_backupIsBroken(backupResponse)) {
                _changeStatus(Status.bothOraclesUntrusted);
                return lastGoodPrice; 
            }

            /*
            * If backup is only frozen but otherwise returning valid data, just return the last good price.
            */
            if (_chainlinkIsFrozen(backupResponse)) {return lastGoodPrice;}
            
            // Otherwise, use backup price
            return _storeChainlinkPrice(backupResponse);
        }

        // --- CASE 3: Both oracles were untrusted at the last price fetch ---
        if (status == Status.bothOraclesUntrusted) {
            /*
            * If both oracles are now live, unbroken and similar price, we assume that they are reporting
            * accurately, and so we switch back to Chainlink.
            */
            if (_bothOraclesLiveAndUnbrokenAndSimilarPrice(chainlinkResponse, prevChainlinkResponse, backupResponse)) {
                _changeStatus(Status.chainlinkWorking);
                return _storeChainlinkPrice(chainlinkResponse);
            } 

            // Otherwise, return the last good price - both oracles are still untrusted (no status change)
            return lastGoodPrice;
        }

        // --- CASE 4: Using backup, and Chainlink is frozen ---
        if (status == Status.usingBnOChainlinkFrozen) {
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                // If both Oracles are broken, return last good price
                if (_backupIsBroken(backupResponse)) {
                    _changeStatus(Status.bothOraclesUntrusted);
                    return lastGoodPrice;
                }

                // If Chainlink is broken, remember it and switch to using backup
                _changeStatus(Status.usingBnOChainlinkUntrusted);

                if (_chainlinkIsFrozen(backupResponse)) {return lastGoodPrice;}

                // If backup is working, return backup current price
                return _storeChainlinkPrice(backupResponse);
            }

            if (_chainlinkIsFrozen(chainlinkResponse)) {
                // if Chainlink is frozen and backup is broken, remember backup broke, and return last good price
                if (_backupIsBroken(backupResponse)) {
                    _changeStatus(Status.usingChainlinkBnOUntrusted);
                    return lastGoodPrice;
                }

                // If both are frozen, just use lastGoodPrice
                if (_chainlinkIsFrozen(backupResponse)) {return lastGoodPrice;}

                // if Chainlink is frozen and backup is working, keep using backup (no status change)
                return _storeChainlinkPrice(backupResponse);
            }

            // if Chainlink is live and backup is broken, remember backup is broke, and return Chainlink price
            if (_backupIsBroken(backupResponse)) {
                _changeStatus(Status.usingChainlinkBnOUntrusted);
                return _storeChainlinkPrice(chainlinkResponse);
            }

             // If Chainlink is live and backup is frozen, just use last good price (no status change) since we have no basis for comparison
            if (_chainlinkIsFrozen(backupResponse)) {return lastGoodPrice;}

            // If Chainlink is live and backup is working, compare prices. Switch to Chainlink
            // if prices are within 5%, and return Chainlink price.
            if (_bothOraclesSimilarPrice(chainlinkResponse, backupResponse)) {
                _changeStatus(Status.chainlinkWorking);
                return _storeChainlinkPrice(chainlinkResponse);
            }

            // Otherwise if Chainlink is live but price not within 5% of backup, distrust Chainlink, and return backup price
            _changeStatus(Status.usingBnOChainlinkUntrusted);
            return _storeChainlinkPrice(backupResponse);
        }

        // --- CASE 5: Using Chainlink, backup is untrusted ---
         if (status == Status.usingChainlinkBnOUntrusted) {
            // If Chainlink breaks, now both oracles are untrusted
            if (_chainlinkIsBroken(chainlinkResponse, prevChainlinkResponse)) {
                _changeStatus(Status.bothOraclesUntrusted);
                return lastGoodPrice;
            }

            // If Chainlink is frozen, return last good price (no status change)
            if (_chainlinkIsFrozen(chainlinkResponse)) {
                return lastGoodPrice;
            }

            // If Chainlink and backup are both live, unbroken and similar price, switch back to chainlinkWorking and return Chainlink price
            if (_bothOraclesLiveAndUnbrokenAndSimilarPrice(chainlinkResponse, prevChainlinkResponse, backupResponse)) {
                _changeStatus(Status.chainlinkWorking);
                return _storeChainlinkPrice(chainlinkResponse);
            }

            // If Chainlink is live but deviated >50% from it's previous price and backup is still untrusted, switch 
            // to bothOraclesUntrusted and return last good price
            if (_chainlinkPriceChangeAboveMax(chainlinkResponse, prevChainlinkResponse)) {
                _changeStatus(Status.bothOraclesUntrusted);
                return lastGoodPrice;
            }

            // Otherwise if Chainlink is live and deviated <50% from it's previous price and backup is still untrusted, 
            // return Chainlink price (no status change)
            return _storeChainlinkPrice(chainlinkResponse);
        }
    }

    // --- Helper functions ---

    /* Chainlink is considered broken if its current or previous round data is in any way bad. We check the previous round
    * for two reasons:
    *
    * 1) It is necessary data for the price deviation check in case 1,
    * and
    * 2) Chainlink is the PriceFeed's preferred primary oracle - having two consecutive valid round responses adds
    * peace of mind when using or returning to Chainlink.
    */
    function _chainlinkIsBroken(ChainlinkResponse memory _currentResponse, ChainlinkResponse memory _prevResponse) internal view returns (bool) {
        return _badChainlinkResponse(_currentResponse) || _badChainlinkResponse(_prevResponse);
    }

    function _badChainlinkResponse(ChainlinkResponse memory _response) internal view returns (bool) {
         // Check for response call reverted
        if (!_response.success) {return true;}
        // Check for an invalid roundId that is 0
        if (_response.roundId == 0) {return true;}
        // Check for an invalid timeStamp that is 0, or in the future
        if (_response.timestamp == 0 || _response.timestamp > block.timestamp) {return true;}
        // Check for non-positive price
        if (_response.answer <= 0) {return true;}

        return false;
    }

    function _chainlinkIsFrozen(ChainlinkResponse memory _response) internal view returns (bool) {
        return block.timestamp.sub(_response.timestamp) > TIMEOUT;
    }

    function _chainlinkPriceChangeAboveMax(ChainlinkResponse memory _currentResponse, ChainlinkResponse memory _prevResponse) internal pure returns (bool) {
        uint currentScaledPrice = _scaleChainlinkPriceByDigits(uint256(_currentResponse.answer), _currentResponse.decimals);
        uint prevScaledPrice = _scaleChainlinkPriceByDigits(uint256(_prevResponse.answer), _prevResponse.decimals);

        uint minPrice = LiquityMath._min(currentScaledPrice, prevScaledPrice);
        uint maxPrice = LiquityMath._max(currentScaledPrice, prevScaledPrice);

        /*
        * Use the larger price as the denominator:
        * - If price decreased, the percentage deviation is in relation to the the previous price.
        * - If price increased, the percentage deviation is in relation to the current price.
        */
        uint percentDeviation = maxPrice.sub(minPrice).mul(DECIMAL_PRECISION).div(maxPrice);

        // Return true if price has more than doubled, or more than halved.
        return percentDeviation > MAX_PRICE_DEVIATION_FROM_PREVIOUS_ROUND;
    }

    function _backupIsBroken(ChainlinkResponse memory _response) internal view returns (bool) {
        // Check for response call reverted
        if (!_response.success) {return true;}
        // Check for an invalid timeStamp that is 0, or in the future
        if (_response.timestamp == 0 || _response.timestamp > block.timestamp) {return true;}
        // Check for zero price
        if (_response.answer == 0) {return true;}

        return false;
    }

    function _bothOraclesLiveAndUnbrokenAndSimilarPrice
    (
        ChainlinkResponse memory _chainlinkResponse,
        ChainlinkResponse memory _prevChainlinkResponse,
        ChainlinkResponse memory _backupResponse
    )
        internal
        view
        returns (bool)
    {
        // Return false if either oracle is broken or frozen
        if
        (
            _backupIsBroken(_backupResponse) ||
            _chainlinkIsFrozen(_backupResponse) ||
            _chainlinkIsBroken(_chainlinkResponse, _prevChainlinkResponse) ||
            _chainlinkIsFrozen(_chainlinkResponse)
        )
        {
            return false;
        }

        return _bothOraclesSimilarPrice(_chainlinkResponse, _backupResponse);
    }

    function _bothOraclesSimilarPrice( ChainlinkResponse memory _chainlinkResponse, ChainlinkResponse memory _backupResponse) internal pure returns (bool) {
        uint scaledChainlinkPrice = _scaleChainlinkPriceByDigits(uint256(_chainlinkResponse.answer), _chainlinkResponse.decimals);
        uint scaledBackupPrice = _scaleChainlinkPriceByDigits(uint256(_backupResponse.answer), _backupResponse.decimals);

        // Get the relative price difference between the oracles. Use the lower price as the denominator, i.e. the reference for the calculation.
        uint minPrice = LiquityMath._min(scaledBackupPrice, scaledChainlinkPrice);
        uint maxPrice = LiquityMath._max(scaledBackupPrice, scaledChainlinkPrice);
        uint percentPriceDifference = maxPrice.sub(minPrice).mul(DECIMAL_PRECISION).div(minPrice);

        /*
        * Return true if the relative price difference is <= 3%: if so, we assume both oracles are probably reporting
        * the honest market price, as it is unlikely that both have been broken/hacked and are still in-sync.
        */
        return percentPriceDifference <= MAX_PRICE_DIFFERENCE_BETWEEN_ORACLES;
    }

    function _scaleChainlinkPriceByDigits(uint _price, uint _answerDigits) internal pure returns (uint) {
        /*
        * Convert the price returned by the Chainlink oracle to an 18-digit decimal for use by Liquity.
        * At date of Liquity launch, Chainlink uses an 8-digit price, but we also handle the possibility of
        * future changes.
        *
        */
        uint price;
        if (_answerDigits >= TARGET_DIGITS) {
            // Scale the returned price value down to Liquity's target precision
            price = _price.div(10 ** (_answerDigits - TARGET_DIGITS));
        }
        else if (_answerDigits < TARGET_DIGITS) {
            // Scale the returned price value up to Liquity's target precision
            price = _price.mul(10 ** (TARGET_DIGITS - _answerDigits));
        }
        return price;
    }

    function _changeStatus(Status _status) internal {
        status = _status;
        emit PriceFeedStatusChanged(_status);
    }

    function _storePrice(uint _currentPrice) internal {
        lastGoodPrice = _currentPrice;
        emit LastGoodPriceUpdated(_currentPrice);
    }

    function _storeChainlinkPrice(ChainlinkResponse memory _chainlinkResponse) internal returns (uint) {
        uint scaledChainlinkPrice = _scaleChainlinkPriceByDigits(uint256(_chainlinkResponse.answer), _chainlinkResponse.decimals);
        _storePrice(scaledChainlinkPrice);

        return scaledChainlinkPrice;
    }

    // --- Oracle response wrapper functions ---

    function _getCurrentBackupResponse() internal view returns (ChainlinkResponse memory backupResponse) {
        // First, try to get current decimal precision:
        try backupFeed.decimals(BTCUSD_BNO_BASE, BTCUSD_BNO_QUOTE) returns (uint8 decimals) {
            // If call to Binance Oracle succeeds, record the current decimal precision
            backupResponse.decimals = decimals;
        } catch {
            // If reverts, return a zero response with success = false
            return backupResponse;
        }
		
        try backupFeed.latestRoundData(BTCUSD_BNO_BASE, BTCUSD_BNO_QUOTE) returns
        (
            uint80 roundId,
            int256 answer,
            uint256 /* startedAt */,
            uint256 timestamp,
            uint80 /* answeredInRound */
        )
        {
            // If call to Chainlink succeeds, return the response and success = true
            backupResponse.roundId = roundId;
            backupResponse.answer = answer;
            backupResponse.timestamp = timestamp;
            backupResponse.success = true;
            return (backupResponse);
        } catch {
             // If call to backup reverts, return a zero response with success = false
            return (backupResponse);
        }
    }

    function _getCurrentChainlinkResponse() internal view returns (ChainlinkResponse memory chainlinkResponse) {
        // First, try to get current decimal precision:
        try priceAggregator.decimals() returns (uint8 decimals) {
            // If call to Chainlink succeeds, record the current decimal precision
            chainlinkResponse.decimals = decimals;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return chainlinkResponse;
        }

        // Secondly, try to get latest price data:
        try priceAggregator.latestRoundData() returns
        (
            uint80 roundId,
            int256 answer,
            uint256 /* startedAt */,
            uint256 timestamp,
            uint80 /* answeredInRound */
        )
        {
            // If call to Chainlink succeeds, return the response and success = true
            chainlinkResponse.roundId = roundId;
            chainlinkResponse.answer = answer;
            chainlinkResponse.timestamp = timestamp;
            chainlinkResponse.success = true;
            return chainlinkResponse;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return chainlinkResponse;
        }
    }

    function _getPrevChainlinkResponse(uint80 _currentRoundId, uint8 _currentDecimals) internal view returns (ChainlinkResponse memory prevChainlinkResponse) {
        /*
        * NOTE: Chainlink only offers a current decimals() value - there is no way to obtain the decimal precision used in a 
        * previous round.  We assume the decimals used in the previous round are the same as the current round.
        */

        // Try to get the price data from the previous round:
        try priceAggregator.getRoundData(_currentRoundId - 1) returns 
        (
            uint80 roundId,
            int256 answer,
            uint256 /* startedAt */,
            uint256 timestamp,
            uint80 /* answeredInRound */
        )
        {
            // If call to Chainlink succeeds, return the response and success = true
            prevChainlinkResponse.roundId = roundId;
            prevChainlinkResponse.answer = answer;
            prevChainlinkResponse.timestamp = timestamp;
            prevChainlinkResponse.decimals = _currentDecimals;
            prevChainlinkResponse.success = true;
            return prevChainlinkResponse;
        } catch {
            // If call to Chainlink aggregator reverts, return a zero response with success = false
            return prevChainlinkResponse;
        }
    }
}

