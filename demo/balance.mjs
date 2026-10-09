// Read the Payment Vault's USDC balance and owner (read-only simulation, no key needed).
// Usage: node balance.mjs [VAULT_C_ADDRESS]
import {
  rpc, Contract, Address, TransactionBuilder, Networks, Account, Keypair, scValToNative,
} from "@stellar/stellar-sdk";

const VAULT = process.argv[2] ?? process.env.VAULT_ADDRESS
  ?? "CDGZHCOHFAM4UCIF5PQZSYK7WXPYD77BNT2YZNSHZRUTOY42EQUPNJ65";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // Circle Testnet USDC SAC
const server = new rpc.Server(process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org");
const source = new Account(Keypair.random().publicKey(), "0");

async function read(contract, fn, ...args) {
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (sim.error) throw new Error(`${fn}: ${sim.error.split("\n")[0]}`);
  return scValToNative(sim.result.retval);
}

const units = await read(VAULT, "balance", new Address(USDC).toScVal());
console.log(`vault ${VAULT}`);
console.log(`USDC: ${units} units (${(Number(units) / 1e7).toFixed(7)} USDC)`);
console.log(`owner: ${await read(VAULT, "owner")}`);
