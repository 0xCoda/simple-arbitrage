import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https"
import { getDefaultRelaySigningKey } from "./utils";

// eg: Ethereum node, to get data off the ethereum chain
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545"

// eg: your own private key (for wallet to sign arbitrage transactions)
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""

// eg: address of your deployed contract (need to deploy contract first; .sol files)
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || ""

// eg: random private key (just 'a private' key to sign bundles with, so flashbots knows who you are)
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

// eg: how much profits you want to pay to the minor
const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "80")

if (PRIVATE_KEY === "") {
  console.warn("Must provide PRIVATE_KEY environment variable")
  process.exit(1)
}
if (BUNDLE_EXECUTOR_ADDRESS === "") {
  console.warn("Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md")
  process.exit(1)
}

if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
  console.warn("Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md")
  process.exit(1)
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || ""

// eg: initialize 'provider' to get data off the chain
const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

// eg: initialize wallet to sign arbitrage transactions
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);

// eg: intiialzie wallet to sign bundles to flashbox (identify yourself to flashbots relay)
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

function healthcheck() {
  if (HEALTHCHECK_URL === "") {
    return
  }
  get(HEALTHCHECK_URL).on('error', console.error);
}

// eg: start running code after importing everything
async function main() {
  console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress())
  console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress())
  
  // eg: init flashbots provider: to create bundles and send to flashbots relay
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
  
  // eg: first 'initialize' arbitrage object with stuff that will be used over and over again (for every transaction you send)
  //        arbitrageSigningWallet: address that you send bundles with
  //        flashbotsProvider: your flashbots bundle provider
  //        Contract: initialze your contract (w/ your contract address, ABI/JSON interface, and ethereum RPC provider)
  //    then we 'use' this arb object to evaluate markets & keep pumping data into it for new blocks
  const arbitrage = new Arbitrage(
    arbitrageSigningWallet,
    flashbotsProvider,
    new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider) )

  // eg: init markets, the thing we use to pull data off the chain (w/ all of our factory addresses, using our ethereum RPC provider)
  //    FACTORY_ADDRESSES are ethereum market exchange contract addresses ('addresses.ts')
  //     each of these is a different fork of uniswap (or uniswap itself)
  const markets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
    // eg: finish initial setup (get all pairs, etc. about 10k different calls)
    //      got all markets across different exchanges (narrowed down to 2k)
    //       'get the data'

  // eg: provider (Ethereum RPC) event handler (on new block)
  //    'evaluate the data' received, to understand what parameters will be executes 'on chain'
  provider.on('block', async (blockNumber) => {
    await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
    
    // eg: use arb object to eval diff markets and keep pumping data into it for new blocks
    const bestCrossedMarkets = await arbitrage.evaluateMarkets(markets.marketsByToken);
    if (bestCrossedMarkets.length === 0) {
      console.log("No crossed markets")
      return
    }
    bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);
    arbitrage.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE).then(healthcheck).catch(console.error)
  })
}

main();
