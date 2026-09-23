// One-off: exchange a TikTok for Business auth_code for a long-lived advertiser
// access token, and list the advertiser ids that token can read.
//
// 1. Open the app's "Advertiser authorization URL" (TikTok developer portal >
//    My Apps > the app), log in as the Miraj ads owner, tick the ad accounts.
// 2. TikTok redirects to the app's redirect URL with ?auth_code=... - copy it.
//    It is single-use and expires within ~1 hour.
// 3. TIKTOK_APP_ID=... TIKTOK_APP_SECRET=... node scripts/tiktok-get-token.mjs <auth_code>
//
// Put the printed token in TIKTOK_ACCESS_TOKEN and the Miraj advertiser ids in
// TIKTOK_ADVERTISER_IDS (in .env.local and on Vercel).
const appId = process.env.TIKTOK_APP_ID;
const secret = process.env.TIKTOK_APP_SECRET;
const authCode = process.argv[2];
if (!appId || !secret || !authCode) {
  console.error("Usage: TIKTOK_APP_ID=... TIKTOK_APP_SECRET=... node scripts/tiktok-get-token.mjs <auth_code>");
  process.exit(1);
}

const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
});
const body = await res.json();
if (body.code !== 0) {
  console.error("TikTok refused the exchange:", JSON.stringify(body));
  process.exit(1);
}

const { access_token, advertiser_ids } = body.data;
console.log("TIKTOK_ACCESS_TOKEN=" + access_token);

// Names, so it is obvious which ids are Miraj's (the token may see other
// brands' accounts too - list only Miraj's).
const info = await fetch(
  "https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?" +
    new URLSearchParams({
      advertiser_ids: JSON.stringify(advertiser_ids),
      fields: JSON.stringify(["advertiser_id", "name", "currency", "timezone"]),
    }),
  { headers: { "Access-Token": access_token } }
).then((r) => r.json());

console.log("\nAdvertisers this token can read:");
for (const a of info.data?.list ?? advertiser_ids.map((id) => ({ advertiser_id: id }))) {
  console.log(`  ${a.advertiser_id}  ${a.name ?? ""}  ${a.currency ?? ""}  ${a.timezone ?? ""}`);
}
