import express from "express";
import dotenv from "dotenv";
import { type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, sepolia } from "viem/chains";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { EscrowServerScheme } from "@x402r/evm/escrow/server";
import { refundable } from "@x402r/helpers";
import { HTTPFacilitatorClient } from "@x402/core/server";

dotenv.config();

const PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS as `0x${string}` | undefined;
const OPERATOR_ADDRESS = (process.env.OPERATOR_ADDRESS ??
  "0xAfD051239DE540D7B51Aa514eb795a2D43C8fCb0") as `0x${string}`;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const MERCHANT_PORT = parseInt(process.env.PORT ?? process.env.MERCHANT_PORT ?? "4021", 10);

if (!MERCHANT_ADDRESS && !PRIVATE_KEY) {
  console.error("MERCHANT_ADDRESS or MERCHANT_PRIVATE_KEY or PRIVATE_KEY is required");
  process.exit(1);
}
if (!FACILITATOR_URL) {
  console.error("FACILITATOR_URL is required");
  process.exit(1);
}

const CHAINS: Record<number, Chain> = {
  84532: baseSepolia,
  8453: base,
  11155111: sepolia,
};
const chain = CHAINS[CHAIN_ID];
if (!chain) {
  console.error(`Unsupported CHAIN_ID: ${CHAIN_ID}`);
  process.exit(1);
}

const networkId = `eip155:${CHAIN_ID}` as const;
const payTo = MERCHANT_ADDRESS ?? privateKeyToAccount(PRIVATE_KEY as `0x${string}`).address;
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          refundable(
            {
              scheme: "escrow",
              price: "$0.01",
              network: networkId,
              payTo,
            },
            OPERATOR_ADDRESS,
          ),
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      networkId,
      new EscrowServerScheme(),
    ),
  ),
);

app.get("/weather", (_req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(MERCHANT_PORT, () => {
  console.log(
    `x402r Merchant Server listening at http://localhost:${MERCHANT_PORT}`,
  );
  console.log(`  Merchant address: ${payTo}`);
  console.log(`  Operator: ${OPERATOR_ADDRESS}`);
  console.log(`  Network: ${networkId}`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
});
