import "server-only";

export type BostaDelivery = {
  trackingNumber: string;
  businessReference?: string;
  type: { code: number; value: string };
  state: { value: string; receivedAtWarehouse?: { time?: string } };
  cod: number;
  attemptsCount: number;
  dropOffAddress?: { city?: { name: string } };
  specs?: { packageDetails?: { description?: string; itemsCount?: number } };
  updatedAt: string;
  createdAt: string;
  collectedFromBusiness?: string;
};

export async function bostaSearchByBusinessReference(businessReference: string): Promise<BostaDelivery[]> {
  const apiKey = process.env.BOSTA_API_KEY;
  if (!apiKey) throw new Error("Missing BOSTA_API_KEY environment variable");

  const res = await fetch("https://app.bosta.co/api/v0/deliveries/search", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pageNumber: 1, pageLimit: 20, businessReference }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Bosta search failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.deliveries ?? [];
}
