//SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.12;

pragma experimental ABIEncoderV2;

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

abstract contract UniswapV2Factory  {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    function allPairsLength() external view virtual returns (uint);
}

// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashBotsUniswapQuery {
    function getReservesByPairs(IUniswapV2Pair[] calldata _pairs) external view returns (uint256[3][] memory) {
        uint256[3][] memory result = new uint256[3][](_pairs.length);
        for (uint i = 0; i < _pairs.length; i++) {
            (result[i][0], result[i][1], result[i][2]) = _pairs[i].getReserves();
        }
        return result;
    }

    // eg: get trading pairs in batches with a single eth_call (by index range 'start', 'stop')
    //  this is faster and more effecient than getting them one at time with multiple eth_calls
    function getPairsByIndexRange(UniswapV2Factory _uniswapFactory, uint256 _start, uint256 _stop) external view returns (address[3][] memory)  {
        
        // eg: get total number of pairs (~44k as of 061921) and
        //  perform sanity check that '_stop' param is not higher than total # of pairs
        uint256 _allPairsLength = _uniswapFactory.allPairsLength();
        if (_stop > _allPairsLength) {
            _stop = _allPairsLength;
        }
        
        // eg: perform sanity check that '_start' param is not higher than '_stop'
        require(_stop >= _start, "start cannot be higher than stop");
        
        // eg: calculate total number of pairs we want
        uint256 _qty = _stop - _start;
        
        // eg: initialize 'result' array of size '_qty', to save and return pair addresses
        //  allocate using 'memory' (ref: https://ethereum.stackexchange.com/a/1705)
        //  allocate with 2D array... each primary index in array will store:
        //      [0] 1st token symbol address from uniswap paired object
        //      [1] 2nd token symbol address from uniswap paired object
        //      [2] address of uniswap pair object
        address[3][] memory result = new address[3][](_qty);
        
        // eg: loop through total # of pairs we want
        for (uint i = 0; i < _qty; i++) {
            // eg: call factory 'allPairs' to get pair for each index ('_start' +)
            //  'allPairs' takes an uint256 index (ref: addresses.ts)
            //  wrap pair in IUniswapV2Pair interface
            IUniswapV2Pair _uniswapPair = IUniswapV2Pair(_uniswapFactory.allPairs(_start + i));
            
            // eg: call factory 'token0()' and save address of 1st token symbol
            result[i][0] = _uniswapPair.token0();
            
            // eg: call factory 'token1()' and save address of 2nd token symbol
            result[i][1] = _uniswapPair.token1();
            
            // eg: save uniswap pair address
            result[i][2] = address(_uniswapPair);
        }
        
        // eg: return 2D array (batch of all pairs & tokens in these pairs, for this query)
        return result;
    }
}
