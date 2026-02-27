import { NextRequest, NextResponse } from "next/server";

const PINATA_JWT = process.env.PINATA_JWT;

export async function POST(req: NextRequest) {
  try {
    if (!PINATA_JWT) {
      return NextResponse.json(
        { error: "PINATA_JWT not configured on court-ui" },
        { status: 503 },
      );
    }

    const data = await req.json();
    if (!data || typeof data !== "object") {
      return NextResponse.json(
        { error: "JSON body required" },
        { status: 400 },
      );
    }

    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataMetadata: {
          name: `x402r-court-evidence-${Date.now()}`,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Pinata failed (${res.status}): ${errText}` },
        { status: 502 },
      );
    }

    const result = (await res.json()) as { IpfsHash: string };
    return NextResponse.json({ cid: result.IpfsHash });
  } catch (err) {
    console.error("Pin error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
