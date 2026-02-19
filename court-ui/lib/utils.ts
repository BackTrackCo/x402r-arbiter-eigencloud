import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function truncateHash(hash: string): string {
  if (hash.length < 16) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

export function formatAmount(amount: string | bigint, decimals = 6): string {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 2);
  return `${whole}.${fractionStr}`;
}

export function statusLabel(status: number): string {
  switch (status) {
    case 0:
      return "PENDING";
    case 1:
      return "APPROVED";
    case 2:
      return "DENIED";
    case 3:
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

export function roleLabel(role: number): string {
  switch (role) {
    case 0:
      return "PAYER";
    case 1:
      return "RECEIVER";
    case 2:
      return "ARBITER";
    default:
      return "UNKNOWN";
  }
}
