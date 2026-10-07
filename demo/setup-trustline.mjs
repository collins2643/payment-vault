// Create a USDC trustline on Stellar for a demo payer.
// Testnet (default):
//   node setup-trustline.mjs                      (generates + funds a new payer via Friendbot)
//   PAYER_SECRET=S... node setup-trustline.mjs    (uses existing payer account)
// Mainnet (Circle USDC; account must already exist and hold >= 1.5 XLM):
//   STELLAR_NETWORK=mainnet PAYER_SECRET=S... node setup-trustline.mjs
import {
  Keypair, Horizon, TransactionBuilder, Operation, Asset, Networks, BASE_FEE,
} from "@stellar/stellar-sdk";

const raw = (process.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
const MAINNET = ["mainnet", "pubnet", "public", "stellar:pubnet"].includes(raw);
if (!MAINNET && !["testnet", "stellar:testnet", ""].includes(raw)) {
  console.error(`Unknown STELLAR_NETWORK "${process.env.STELLAR_NETWORK}". Use "testnet" or "mainnet".`);
  process.exit(1);
}
const HORIZON_URL = MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const EXPLORER = `https://stellar.expert/explorer/${MAINNET ? "public" : "testnet"}`;
// Circle USDC issuers. Mainnet issuer must start with GA5ZSEJY.
const USDC_ISSUER = MAINNET
  ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const server = new Horizon.Server(HORIZON_URL);

async function accountExists(pub) {
  try { await server.loadAccount(pub); return true; }
  catch (e) { if (e?.response?.status === 404) return false; throw e; }
}

// Step 1: fund with Friendbot (10,000 XLM) to cover base reserve (2 x 0.5 XLM)
// plus 0.5 XLM subentry reserve for the trustline and fees.
async function fundWithFriendbot(pub) {
  if (MAINNET) {
    if (!(await accountExists(pub))) throw new Error("Mainnet account not found. Send it at least 1.5 XLM from an exchange or wallet first.");
    const xlm = Number((await server.loadAccount(pub)).balances.find((b) => b.asset_type === "native").balance);
    if (xlm < 1.5) throw new Error(`Mainnet account has ${xlm} XLM; need at least 1.5 XLM for reserves + trustline.`);
    return;
  }
  if (await accountExists(pub)) { console.log("Account already exists; skipping Friendbot."); return; }
  console.log("Funding via Friendbot...");
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  console.log("Friendbot tx:", body.hash ?? body.id);
}

// Step 2+3: build ChangeTrust op, sign, submit.
async function createTrustline(keypair) {
  const account = await server.loadAccount(keypair.publicKey());
  const existing = account.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  if (existing) { console.log("Trustline already exists; skipping."); return null; }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE, networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC })) // default limit = max
    .setTimeout(60)
    .build();
  tx.sign(keypair);

  try {
    const result = await server.submitTransaction(tx);
    console.log("ChangeTrust submitted. Hash:", result.hash);
    console.log(`Explorer: ${EXPLORER}/tx/${result.hash}`);
    return result.hash;
  } catch (e) {
    console.error("Submit failed:", JSON.stringify(e?.response?.data?.extras?.result_codes ?? e.message));
    throw e;
  }
}

// Step 4: verify trustline is active with zero balance.
async function verify(pub) {
  const account = await server.loadAccount(pub);
  const line = account.balances.find(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  if (!line) throw new Error("Verification failed: USDC trustline not found");
  const authorized = line.is_authorized !== false;
  console.log("\nTrustline verified:");
  console.log({ asset: `USDC:${USDC_ISSUER}`, balance: line.balance, limit: line.limit,
    authorized, subentry_count: account.subentry_count });
  const xlm = account.balances.find((b) => b.asset_type === "native");
  console.log("XLM balance:", xlm.balance);
  if (!MAINNET && Number(line.balance) !== 0) throw new Error(`Expected zero balance, got ${line.balance}`);
  if (!authorized) throw new Error("Trustline exists but is not authorized");
  console.log(`OK: active USDC trustline on ${MAINNET ? "Mainnet" : "Testnet"}.`);
}

async function main() {
  if (MAINNET && !(process.env.PAYER_SECRET || process.env.STELLAR_SECRET)) {
    throw new Error("Mainnet needs PAYER_SECRET for an existing funded account (no Friendbot on Mainnet).");
  }
  const keypair = (process.env.PAYER_SECRET || process.env.STELLAR_SECRET)
    ? Keypair.fromSecret((process.env.PAYER_SECRET || process.env.STELLAR_SECRET)) : Keypair.random();
  console.log("Public key:", keypair.publicKey());
  if (!(process.env.PAYER_SECRET || process.env.STELLAR_SECRET)) console.log("Secret (testnet only, save it):", keypair.secret());
  await fundWithFriendbot(keypair.publicKey());
  await createTrustline(keypair);
  await verify(keypair.publicKey());
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
