// eg: ethereum market exchange contract addresses
//  each of these is a different fork of uniswap (or uniswap itself)
//  inside each of these contract source codes has a function that lets us get pairs: 'getPair or allPairs'
//    test getting pairs (uniswap v2): https://etherscan.io/address/0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f#readContract
//
//  Note: how uniswap v2 & v3 works
//      - they have a 'factory contract' that will deploy a bunch of 'little contracts' that stand on their own
//      - these 'little contracts' are what you are trading on
//          its where you can find prices & data of different assets (not in the factory contract itself)
//          an example of important data we need is trading 'pairs' (i.e. PAX-USDC)
//      - test getting pairs (uniswap v2): https://etherscan.io/address/0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f#readContract
export const UNISWAP_LOOKUP_CONTRACT_ADDRESS = '0x5EF1009b9FCD4fec3094a5564047e190D72Bd511'
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const SUSHISWAP_FACTORY_ADDRESS = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac';
export const UNISWAP_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
export const CRO_FACTORY_ADDRESS = "0x9DEB29c9a4c7A88a3C0257393b7f3335338D9A9D";
export const ZEUS_FACTORY_ADDRESS = "0xbdda21dd8da31d5bee0c9bb886c044ebb9b8906a";
export const LUA_FACTORY_ADDRESS = "0x0388c1e0f210abae597b7de712b9510c6c36c857";

export const FACTORY_ADDRESSES = [
  CRO_FACTORY_ADDRESS,  // uniswap v2 fork
  ZEUS_FACTORY_ADDRESS, // uniswap v2 fork
  LUA_FACTORY_ADDRESS,  // uniswap v2 fork
  SUSHISWAP_FACTORY_ADDRESS,
  UNISWAP_FACTORY_ADDRESS,
]
