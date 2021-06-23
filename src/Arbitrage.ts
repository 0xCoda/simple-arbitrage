import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
]

// eg: traverse through all pairs of markets w/ sell price > buy price (for this token)
//    find the best pair of markets to swap with, and add to 'bestCrossedMarkets'
//
// note: should read and review 'An Analysis of Uniswap markets'
//      ref: https://arxiv.org/pdf/1911.03380.pdf
//  helps you to price things in more optimal way
//  lays out 'how uniswap works and why'
//  lays out how to derive a mathematical equation for optimal arbitrage
export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  
  // eg: loop through pairs of markets with greater sell prices than buy prices
  //    trying to find the best markets to buy & sell, that yields the most profit
  for (const crossedMarket of crossedMarkets) {
    // eg: sell to pricedMarket w/ lower buyTokenPrice
    const sellToMarket = crossedMarket[0]
    
    // eg: buy from pricedMarket w/ higher sellTokenPrice
    const buyFromMarket = crossedMarket[1]
    
    // eg: check profits againts different markets (find best market)
    //  loop through TEST_VOLUMES array,
    //  comparing profitability of this sellToMarket & buyFromMarket w/ each volume size
    for (const size of TEST_VOLUMES) {
    
      // eg: get # of tokens out (received 'tokenAddress'), if put WETH 'size' amount in (paid)
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      
      // eg: get # of WETH out (received ether), if put buy-market token receieved amount in (paid)
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
      
      // eg: subtract original 'size' (WETH amount) paid, to get net profit
      const profit = proceedsFromSellingTokens.sub(size);
      
      // eg: IF this volume's profit < current best market volume profit
      //    THEN try comparing profitability using an 'altered' volume:
      //        this volume + (current best market volume / 2)
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        
        // eg: get # of tokens out (received 'tokenAddress'), if put WETH 'size' amount in (paid)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        
        // eg: get # of WETH out (received ether), if put buy-market token receieved amount in (paid)
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
        
        // eg: subtract original 'size' (WETH amount) paid, to get net profit
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        
        // eg: if this 'altered' volume's profit is now greater than current best volume profit
        //    set this market as best current best market
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
      
      // eg: ELSE, this volume's profit >= current best market volume profit
      //    so, set this market as current best market
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  // eg: print crosses markets
  //    invoked after 'evaluateMarkets' in provider 'block' update event handler
  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }

  // eg: traverse through marketsByToken to return array of best crossed markets
  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
  
    // eg: initialize array of CrossedMarketDetails
    //  stores list of best pair of markets for each token to swap with
    const bestCrossedMarkets = new Array<CrossedMarketDetails>()

    // eg: loop through all token addresses in marketsByToken
    for (const tokenAddress in marketsByToken) {

      // eg: get markets array for this token address
      const markets = marketsByToken[tokenAddress]
      
      // eg: traverse through markets array & parse out an array of dicts
      //    containing...
      //        - the market itself (EthMarket)
      //        - token buy price
      //        - token sell price
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          
          /*
           ETHER = 10^18
           reserveIn = 'tokenAddress' reserve balance
           reserveOut = 'WETH_ADDRESS' reserve balance
           amountOut = 'ETHER'/100
           997 = accounts for the 0.3% UniswapV2 fee
           buyTokenPrice = ( (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) ) + 1
          */
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
          
          /*
           ETHER = 10^18
           reserveIn = 'WETH_ADDRESS' reserve balance
           reserveOut = 'tokenAddress' reserve balance
           amountIn = 'ETHER'/100
           amountInWithFee = 'amountIn' * 997
           997 = accounts for the 0.3% UniswapV2 fee
           sellTokenPrice = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee)
          */
          sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
          
          /* Note regarding '* 997' & '+ 1'
           ref: https://discord.com/channels/755466764501909692/855195699019644958/856620262997098616
           chair#4648
             30 basis point fee charged by UniV2, right?
             So 997 is just accounting for the 0.3% fee
          
           ref: https://discord.com/channels/755466764501909692/855195699019644958/856622416347529227
           chair#4648
             Yeah, it comes out of the algebra... it's like when there is a 3% interest rate so you multiply the principal amount by (1+3%) to get how much there will be next period, right? Same thing here, you need the + 1...
          */
        }
      });

      // eg: check for arbitrage opportunity to take advantage of
      //    initialize 2D array to store 'pairs of markets'
      //    that we can do a buy & sell for profit
      const crossedMarkets = new Array<Array<EthMarket>>()

      // eg: compare each market's sell price vs each market's buy price
      //    if a sell price is ever greater than a buy price,
      //     then add those 2 markets to crossMarkets array
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      // eg: traverse through all pairs of markets w/ sell price > by price (for this token)
      //    find the best pair of markets to swap with, and add to 'bestCrossedMarkets'
      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(ETHER.div(1000))) {
        bestCrossedMarkets.push(bestCrossedMarket)
      }
    }
    
    // eg: sort all pairs of markets by greatest to least profit, and return
    //
    // note: typesript '.sort()'
    //  return negative if the first item is smaller; positive if it it's larger, or zero if they're equal.
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
    return bestCrossedMarkets
  }

  // eg: do stuff with markets analyzed off chain
  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    for (const bestCrossedMarket of bestCrossedMarkets) {

      console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
      
      // eg: generate uniswap v2 low-level flash swap transaction, to sign & submit to network for on-chain execution (does not submit now)
      //    sends 'volume' amount of WETH to 'sellToMarket' address
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      
      // eg: get # of tokens out (received 'tokenAddress'), for WETH 'volume' amount in (paid)
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
      
      // eg: generate uniswap v2 low-level flash swap transaction, to sign & submit to network for on-chain execution (does not submit now)
      //    sends 'inter' amount of non-WETH to our bundle execute address
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

      // eg: create targets array (buy market pair address & sell market pair address)
      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      
      // eg: create raw data payloads for buy & sell executions (on-chain invocations of uniswap v2 low-level flash swaps)
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      console.log({targets, payloads})
      
      // eg: calculate minor reward
      const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      
      // eg: generate uniswap v2 low-level flash swap transaction, to sign & submit to network for on-chain execution (does not submit now)
      //    execute swaps for this pair of markets (include
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, {
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(1000000),
      });

      // eg: perform sanity checks, before creating bundled transactions
      try {
        const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
          {
            ...transaction,
            from: this.executorWallet.address
          })
        if (estimateGas.gt(1400000)) {
          console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
          continue
        }
        transaction.gasLimit = estimateGas.mul(2)
      } catch (e) {
        console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
        continue
      }
      
      // eg: create array of bundle transcations (as many as we want)
      //    transcations need to be executed all or non, and in-order
      //    can also include signed transactions ('signedTransaction') from the mempool (doesn't have to belong to us)
      //     note: this is how they 'snipe liquidity events' on the same block that they're deployed
      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      
      // eg: print out the bundle
      console.log(bundledTransactions)
      
      // eg: sign the bundle
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      //
      
      // eg: simulate bundle w/ flashbots relay to make sure we are not just sending junk
      //   returns info (how much gas is used, how much paid to minor, etc.)
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
      
      // eg: check for 'error' in simulation
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
        continue
      }
      
      // eg: sending bundle 2 blocks into the future (because minors sometimes mine blocks really quickly; average = every 14sec)
      //    i.e. if blocks are mined in 1 second,
      //        we want our bundle to be there and valid 2 blocks into the future,
      //        so it can executed at that time (in addition to the next block)
      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      await Promise.all(bundlePromises)
      return
    }
    throw new Error("No arbitrage submitted to relay")
  }
}
