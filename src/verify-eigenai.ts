/**
 * Verify EigenAI endpoint works with wallet-based grant auth.
 * Run: npx ts-node src/verify-eigenai.ts
 */
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const PRIVATE_KEY = '0x0ad88bf30b3f2ca3007519c028a0e1fcce184cce76ec7299428184f96515a5d4';
const GRANT_SERVER = 'https://determinal-api.eigenarcade.com';
const EIGENAI_ENDPOINT = 'https://eigenai-sepolia.eigencloud.xyz/v1/chat/completions';

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log('Wallet:', account.address);

  // Step 1: Get grant message
  const msgRes = await fetch(`${GRANT_SERVER}/message?address=${account.address}`);
  const msgData = await msgRes.json() as { success: boolean; message: string };
  console.log('Grant message:', msgData.message);

  // Step 2: Sign the message
  const signature = await account.signMessage({ message: msgData.message });
  console.log('Signature:', signature.slice(0, 20) + '...');

  // Step 3: Check grant balance
  const grantRes = await fetch(`${GRANT_SERVER}/checkGrant?address=${account.address}`);
  const grantData = await grantRes.json() as { tokenCount: number; hasGrant: boolean };
  console.log('Token balance:', grantData.tokenCount);

  // Step 4: Test EigenAI inference with grant auth
  console.log('\nTesting EigenAI inference (seed=42)...');
  const chatRes = await fetch(`${GRANT_SERVER}/api/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-oss-120b-f16',
      max_tokens: 50,
      seed: 42,
      messages: [{ role: 'user', content: 'Say "Hello from EigenAI" and nothing else.' }],
      grantMessage: msgData.message,
      grantSignature: signature,
      walletAddress: account.address,
    }),
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    console.error('EigenAI request failed:', chatRes.status, errText);
    process.exit(1);
  }

  const chatData = await chatRes.json() as any;
  console.log('Response:', chatData.choices?.[0]?.message?.content);
  console.log('\nEigenAI verification successful!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
