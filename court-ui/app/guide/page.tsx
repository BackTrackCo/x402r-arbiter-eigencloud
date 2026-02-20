"use client";

import { Separator } from "@/components/ui/separator";

const MERCHANT_URL = "https://x402r-test-merchant-production.up.railway.app";
const OPERATOR = "0xAfD051239DE540D7B51Aa514eb795a2D43C8fCb0";

export default function GuidePage() {
  return (
    <div className="space-y-6">
      {/* Merchant Server */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          TEST MERCHANT
        </h2>
        <div className="border border-border p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <Field label="ENDPOINT" value={`${MERCHANT_URL}/weather`} mono />
            <Field label="PRICE" value="$0.01 USDC (escrow)" />
            <Field label="OPERATOR" value={OPERATOR} mono />
            <Field label="NETWORK" value="Base Sepolia (eip155:84532)" />
          </div>
          <p className="text-xs text-muted-foreground">
            Returns weather data behind an x402r escrow paywall.
            A merchant dispute bot automatically submits evidence when
            refund requests are filed.
          </p>
        </div>
      </section>

      <Separator />

      {/* Quick Test */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          QUICK TEST
        </h2>
        <div className="border border-border p-4 space-y-2 text-xs">
          <p className="text-muted-foreground mb-2">
            Verify the merchant is online and returns payment requirements:
          </p>
          <Code>{`curl ${MERCHANT_URL}/weather`}</Code>
          <p className="text-muted-foreground mt-2">
            Should return HTTP 402 with escrow payment options.
          </p>
        </div>
      </section>

      <Separator />

      {/* OpenClaw Tutorial */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          OPENCLAW BOT GUIDE
        </h2>
        <div className="border border-border p-4 space-y-6 text-xs">
          <p className="text-muted-foreground">
            Use the <span className="text-foreground">x402r-dispute</span> OpenClaw
            skill to act as a client — pay the merchant, file disputes, and
            track arbitration.
          </p>

          <Step n={1} title="Configure the CLI">
            <p className="text-muted-foreground mb-2">
              Set up your wallet, operator, and arbiter server:
            </p>
            <Code>{`x402r config \\
  --key <your-private-key> \\
  --operator ${OPERATOR} \\
  --arbiter-url <arbiter-server-url> \\
  --network eip155:84532`}</Code>
            <p className="text-muted-foreground mt-2">
              Config is saved to <span className="text-foreground">~/.x402r/config.json</span>.
              You only need to do this once.
            </p>
          </Step>

          <Step n={2} title="Make a payment">
            <p className="text-muted-foreground mb-2">
              Use <span className="text-foreground">@x402/fetch</span> to buy
              from the merchant. The escrow scheme handles the 402 flow
              automatically:
            </p>
            <Code>{`import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerEscrowScheme } from "@x402r/evm/escrow/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerEscrowScheme(client, {
  signer: privateKeyToAccount("0x..."),
  networks: "eip155:84532",
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPayment("${MERCHANT_URL}/weather");
console.log(await res.json());`}</Code>
            <p className="text-muted-foreground mt-2">
              Save the payment response — you&apos;ll need the payment info
              JSON for the dispute.
            </p>
          </Step>

          <Step n={3} title="File a dispute">
            <p className="text-muted-foreground mb-2">
              If the service was unsatisfactory, file a refund request.
              The OpenClaw bot runs this via the x402r-dispute skill:
            </p>
            <Code>{`x402r dispute "Weather data was inaccurate" \\
  --evidence "Endpoint returned sunny but it was raining"`}</Code>
            <p className="text-muted-foreground mt-2">
              This creates an on-chain refund request and submits your
              evidence in one step. State is saved for follow-up commands.
            </p>
          </Step>

          <Step n={4} title="Merchant auto-responds">
            <p className="text-muted-foreground mb-2">
              The merchant dispute bot detects the refund request on-chain
              and automatically submits counter-evidence. No action needed —
              just wait a few seconds.
            </p>
          </Step>

          <Step n={5} title="Check status">
            <p className="text-muted-foreground mb-2">
              Monitor the dispute resolution:
            </p>
            <Code>{`x402r status        # check ruling status
x402r show          # view all evidence (payer + merchant + arbiter)
x402r verify        # replay the AI evaluation to verify determinism`}</Code>
          </Step>

          <Step n={6} title="View on dashboard">
            <p className="text-muted-foreground mb-2">
              The dispute appears on the{" "}
              <a href="/" className="text-foreground underline underline-offset-2">
                disputes page
              </a>{" "}
              where you can inspect evidence, the arbiter&apos;s ruling,
              and verify the commitment hash.
            </p>
          </Step>
        </div>
      </section>

      <Separator />

      {/* Flow Diagram */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          END-TO-END FLOW
        </h2>
        <div className="border border-border p-4">
          <pre className="text-xs text-muted-foreground leading-relaxed overflow-x-auto">{`Client (OpenClaw bot)          Merchant Server          Merchant Bot          Arbiter
       |                            |                       |                    |
       |--- GET /weather ---------->|                       |                    |
       |<-- 402 (payment required) -|                       |                    |
       |--- GET /weather + payment->|                       |                    |
       |<-- 200 (weather data) -----|                       |                    |
       |                            |                       |                    |
       |--- x402r dispute -------> [on-chain: RefundRequested]                   |
       |                            |                       |                    |
       |                            |    (watches events)   |                    |
       |                            |<-- auto-evidence -----|                    |
       |                            |                       |                    |
       |                            |              [arbiter evaluates both sides] |
       |                            |                       |<--- ruling --------|
       |                            |                       |                    |
       |--- x402r status / verify ->|                       |                    |`}</pre>
        </div>
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-xs">
      <p className="text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-medium ${mono ? "break-all" : ""}`}>{value}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-foreground mb-2">
        {n}. {title}
      </h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-muted/50 border border-border rounded px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap">
      {children}
    </pre>
  );
}
