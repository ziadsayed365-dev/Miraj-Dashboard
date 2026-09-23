import "server-only";

const SHOPIFY_API_VERSION = "2026-04";

export async function getShopifyAccessToken(): Promise<string> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) {
    throw new Error("Missing Shopify environment variables");
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token as string;
}

export async function shopifyGraphQL<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`Shopify GraphQL error: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data as T;
}
