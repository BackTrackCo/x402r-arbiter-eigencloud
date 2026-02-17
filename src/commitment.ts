import { keccak256, toBytes, encodePacked, type Hex } from "viem";

export interface Commitment {
  promptHash: Hex;
  responseHash: Hex;
  commitmentHash: Hex;
  seed: number;
}

export function createCommitment(
  prompt: string,
  seed: number,
  response: string,
): Commitment {
  const promptHash = keccak256(toBytes(prompt));
  const responseHash = keccak256(toBytes(response));
  const commitmentHash = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint256"],
      [promptHash, responseHash, BigInt(seed)],
    ),
  );

  return { promptHash, responseHash, commitmentHash, seed };
}
