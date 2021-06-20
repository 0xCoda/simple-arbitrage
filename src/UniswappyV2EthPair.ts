import * as _ from "lodash";
import { BigNumber, Contract, providers } from "ethers";
import { UNISWAP_PAIR_ABI, UNISWAP_QUERY_ABI } from "./abi";
import { UNISWAP_LOOKUP_CONTRACT_ADDRESS, WETH_ADDRESS } from "./addresses";
import { CallDetails, EthMarket, MultipleCallData, TokenBalances } from "./EthMarket";
import { ETHER } from "./utils";
import { MarketsByToken } from "./Arbitrage";

// batch count limit helpful for testing, loading entire set of uniswap markets takes a long time to load
const BATCH_COUNT_LIMIT = 100;
const UNISWAP_BATCH_SIZE = 1000

// Not necessary, slightly speeds up loading initialization when we know tokens are bad
// Estimate gas will ensure we aren't submitting bad bundles, but bad tokens waste time
const blacklistTokens = [
  '0xD75EA151a61d06868E31F8988D28DFE5E9df57B4'
]

interface GroupedMarkets {
  marketsByToken: MarketsByToken;
  allMarketPairs: Array<UniswappyV2EthPair>;
}

export class UniswappyV2EthPair extends EthMarket {
  static uniswapInterface = new Contract(WETH_ADDRESS, UNISWAP_PAIR_ABI);
  
  // eg: (ref: EthMarket.ts)
  //  a list of all token addresses mapped to their current reserve balances,
  //    for this 'EthMarket' object (factory address)
  private _tokenBalances: TokenBalances

  constructor(marketAddress: string, tokens: Array<string>, protocol: string) {
    super(marketAddress, tokens, protocol);
    this._tokenBalances = _.zipObject(tokens,[BigNumber.from(0), BigNumber.from(0)])
  }

  receiveDirectly(tokenAddress: string): boolean {
    return tokenAddress in this._tokenBalances
  }

  async prepareReceive(tokenAddress: string, amountIn: BigNumber): Promise<Array<CallDetails>> {
    if (this._tokenBalances[tokenAddress] === undefined) {
      throw new Error(`Market does not operate on token ${tokenAddress}`)
    }
    if (! amountIn.gt(0)) {
      throw new Error(`Invalid amount: ${amountIn.toString()}`)
    }
    // No preparation necessary
    return []
  }

  // eg: get market pairs from a factory address (using ethereum RPC provider)
  //    a factoryAddress is an ethereum market exchange contract addresses
  //     each of these is a different fork of uniswap (or uniswap itself)
  static async getUniswappyMarkets(provider: providers.JsonRpcProvider, factoryAddress: string): Promise<Array<UniswappyV2EthPair>> {
    
    // eg: initialize contract object (UniswapFlashQuery.sol) w/ ABI (abi.ts) and provider (Ethereum RPC URL)
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);

    // eg: initialize array of market pairs that we will ultimately use and interact with
    //  we will only add pairs that pass filtering in below for loop
    const marketPairs = new Array<UniswappyV2EthPair>()
    
    // eg: search all 'factories' (factories?)... factory contract addresses, i think
    //  i.e. uniswap v2: 0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f
    //      ref: https://etherscan.io/address/0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f#readContract
    for (let i = 0; i < BATCH_COUNT_LIMIT * UNISWAP_BATCH_SIZE; i += UNISWAP_BATCH_SIZE) {
    
      // eg: get batch of pairs by index range for designated factory (market exchange contract address)
      //    invoke on chain contract 'UniswapFlashQuery.sol' (getPairsByIndexRange)
      //    returns 2D array (batch of all pairs & tokens in these pairs, for this query)
      //
      //    note: below we filter pairs with WETH (i.e. tokens paired w/ ether; since ERC20 to ERC20 likely doesn't have value)
      const pairs: Array<Array<string>> = (await uniswapQuery.functions.getPairsByIndexRange(factoryAddress, i, i + UNISWAP_BATCH_SIZE))[0];
      
      // eg: loop through batch of pairs received and deconstruct
      //    get pair address, and pair token addresses (ref: UniswapFlashQuery.sol)
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const marketAddress = pair[2];
        let tokenAddress: string;

        // eg: filter for only ETH in the pair, because we pay our cost in WETH
        //      (simpler to pay out of our profit types; less math to do)
        if (pair[0] === WETH_ADDRESS) {
          tokenAddress = pair[1]
        } else if (pair[1] === WETH_ADDRESS) {
          tokenAddress = pair[0]
        } else {
          continue;
        }
        
        // eg: check for blacklisted token
        //  if not, then create 'UniswappyV2EthPair' & append to marketPairs array
        if (!blacklistTokens.includes(tokenAddress)) {
          const uniswappyV2EthPair = new UniswappyV2EthPair(marketAddress, [pair[0], pair[1]], "");
          marketPairs.push(uniswappyV2EthPair);
        }
      }
      if (pairs.length < UNISWAP_BATCH_SIZE) {
        break
      }
    }

    return marketPairs
  }

  // eg: use input provider to get market data from factory addresses (market exchange contract addresses)
  static async getUniswapMarketsByToken(provider: providers.JsonRpcProvider, factoryAddresses: Array<string>): Promise<GroupedMarkets> {
  
    // eg: take all factory addresses from 'addresses.ts',
    //  and in parrallel executues 'getUniswappyMarkets' for each factory address to our RPC provider
    //    factoryAddresses are ethereum market exchange contract addresses ('addresses.ts')
    //     each of these is a different fork of uniswap (or uniswap itself)
    const allPairs = await Promise.all(
      _.map(factoryAddresses, factoryAddress => UniswappyV2EthPair.getUniswappyMarkets(provider, factoryAddress))
    )

    // eg: NEED SCOTT VALIDATION (for this comment)
    //  parse marketsByTokenAll dict from market pairs array (received from on-chain; ref: UniswapFlashQuery.sol)
    //  lambda function in groupBy: organizes dict by token name (i.e. HEXWETH, not WETHHEX)
    const marketsByTokenAll = _.chain(allPairs)
      .flatten()
      .groupBy(pair => pair.tokens[0] === WETH_ADDRESS ? pair.tokens[1] : pair.tokens[0])
      .value()

    // eg: NEED SCOTT VALIDATION (for this comment)
    //  sanity check, w/ lambda checking length of each dict in marketsByTokenAll
    const allMarketPairs = _.chain(
      _.pickBy(marketsByTokenAll, a => a.length > 1) // weird TS bug, chain'd pickBy is Partial<>
    )
      .values()
      .flatten()
      .value()

    // eg: update reserves (during this initial setup)
    //  passing in provider (Ethereum RPC), so we can get the data
    await UniswappyV2EthPair.updateReserves(provider, allMarketPairs);
        // note: we need continuous data for these pairs ('every single block')
        //  i.e. this function also invoked from index.ts on provider 'block' event handler

    // eg: NEED SCOTT VALIDATION (for this comment)
    //  parse marketsByToken dict from allMarketPairs (now updated w/ reserves from on-chain; ref: UniswapFlashQuery.sol)
    //  lambda function in filter: filter out pairs that are less than 1 ether (ref: utils.ts)
    //  lambda function in groupBy: organizes dict by token name (i.e. HEXWETH, not WETHHEX)
    const marketsByToken = _.chain(allMarketPairs)
      .filter(pair => (pair.getBalance(WETH_ADDRESS).gt(ETHER)))
      .groupBy(pair => pair.tokens[0] === WETH_ADDRESS ? pair.tokens[1] : pair.tokens[0])
      .value()

    // eg: return marketsByToken dict & allMarketPairs dict
    return {
      marketsByToken,
      allMarketPairs
    }
  }

  // eg: updates reserves (reserves? ref: https://uniswap.org/docs/v2/advanced-topics/pricing/)
  //    a 'reserve' is the amount of tokens that are available for a pair
  //        we need this to figure out the price of an asset
  //    invoked from index.ts on initial setup, via 'getUniswapMarketsByToken' (above)
  //    invoked from index.ts on provider 'block' event handler
  static async updateReserves(provider: providers.JsonRpcProvider, allMarketPairs: Array<UniswappyV2EthPair>): Promise<void> {
  
    // eg: initialize contract object (UniswapFlashQuery.sol) w/ ABI (abi.ts) and provider (Ethereum RPC URL)
    const uniswapQuery = new Contract(UNISWAP_LOOKUP_CONTRACT_ADDRESS, UNISWAP_QUERY_ABI, provider);
    
    // eg: parse out market pair addresses & create simple object
    //  to invoke on-chain function for getting reserves
    const pairAddresses = allMarketPairs.map(marketPair => marketPair.marketAddress);
    
    // eg: print how many addresses we have
    console.log("Updating markets, count:", pairAddresses.length)
    
    // eg: 'this is where the magic happens for getting data'
    //  invoke on-chain function to get reserves (UniswapFlashQuery.sol)
    //  returns 2D array batch of all token pair reserves
    //
    //  note: indices in reserves array returned from on-chain, must stay in sync with allMarketPairs indices
    //      i.e. the for loop (below) depends on this
    const reserves: Array<Array<BigNumber>> = (await uniswapQuery.functions.getReservesByPairs(pairAddresses))[0];
    
    // eg: loop through allMarketPairs, setting reserves for each market pair
    for (let i = 0; i < allMarketPairs.length; i++) {
      const marketPair = allMarketPairs[i];
      const reserve = reserves[i]
      
      // eg: compares new reserves receieved from on-chain, against old reservers stored in 'this._tokenBalances'
      //    updates 'this._tokenBalances' if new reserves are different
      //
      //  note: (ref: EthMarket.ts)
      //   'this._tokenBalances' is a list of all token addresses
      //     mapped to their current reserve balances, for this EthMarket object (factory address)
      marketPair.setReservesViaOrderedBalances([reserve[0], reserve[1]])
    }
  }

  getBalance(tokenAddress: string): BigNumber {
    const balance = this._tokenBalances[tokenAddress]
    if (balance === undefined) throw new Error("bad token")
    return balance;
  }

  setReservesViaOrderedBalances(balances: Array<BigNumber>): void {
    this.setReservesViaMatchingArray(this._tokens, balances)
  }

  setReservesViaMatchingArray(tokens: Array<string>, balances: Array<BigNumber>): void {
    const tokenBalances = _.zipObject(tokens, balances)
    if (!_.isEqual(this._tokenBalances, tokenBalances)) {
      this._tokenBalances = tokenBalances
    }
  }

  getTokensIn(tokenIn: string, tokenOut: string, amountOut: BigNumber): BigNumber {
    const reserveIn = this._tokenBalances[tokenIn]
    const reserveOut = this._tokenBalances[tokenOut]
    return this.getAmountIn(reserveIn, reserveOut, amountOut);
  }

  getTokensOut(tokenIn: string, tokenOut: string, amountIn: BigNumber): BigNumber {
    const reserveIn = this._tokenBalances[tokenIn]
    const reserveOut = this._tokenBalances[tokenOut]
    return this.getAmountOut(reserveIn, reserveOut, amountIn);
  }

  getAmountIn(reserveIn: BigNumber, reserveOut: BigNumber, amountOut: BigNumber): BigNumber {
    const numerator: BigNumber = reserveIn.mul(amountOut).mul(1000);
    const denominator: BigNumber = reserveOut.sub(amountOut).mul(997);
    return numerator.div(denominator).add(1);
  }

  getAmountOut(reserveIn: BigNumber, reserveOut: BigNumber, amountIn: BigNumber): BigNumber {
    const amountInWithFee: BigNumber = amountIn.mul(997);
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(1000).add(amountInWithFee);
    return numerator.div(denominator);
  }

  async sellTokensToNextMarket(tokenIn: string, amountIn: BigNumber, ethMarket: EthMarket): Promise<MultipleCallData> {
    if (ethMarket.receiveDirectly(tokenIn) === true) {
      const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress)
      return {
        data: [exchangeCall],
        targets: [this.marketAddress]
      }
    }

    const exchangeCall = await this.sellTokens(tokenIn, amountIn, ethMarket.marketAddress)
    return {
      data: [exchangeCall],
      targets: [this.marketAddress]
    }
  }

  async sellTokens(tokenIn: string, amountIn: BigNumber, recipient: string): Promise<string> {
    // function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external lock {
    let amount0Out = BigNumber.from(0)
    let amount1Out = BigNumber.from(0)
    let tokenOut: string;
    if (tokenIn === this.tokens[0]) {
      tokenOut = this.tokens[1]
      amount1Out = this.getTokensOut(tokenIn, tokenOut, amountIn)
    } else if (tokenIn === this.tokens[1]) {
      tokenOut = this.tokens[0]
      amount0Out = this.getTokensOut(tokenIn, tokenOut, amountIn)
    } else {
      throw new Error("Bad token input address")
    }
    const populatedTransaction = await UniswappyV2EthPair.uniswapInterface.populateTransaction.swap(amount0Out, amount1Out, recipient, []);
    if (populatedTransaction === undefined || populatedTransaction.data === undefined) throw new Error("HI")
    return populatedTransaction.data;
  }
}
