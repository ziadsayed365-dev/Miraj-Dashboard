import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getProductCatalog } from "@/lib/products/catalog";
import { ProductListPage } from "../product-list-page";

export const dynamic = "force-dynamic";

export default async function ProductList() {
  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);

  if (role !== "owner") {
    return <p className="text-sm text-gray-500">Owner access only.</p>;
  }

  const { products } = await getProductCatalog();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Product List</h1>
        <p className="text-xs text-gray-400">
          Name, SKU and price are synced from Shopify on every Sync. Set each product&apos;s Category, Sub Category and
          unit cost below.
        </p>
      </div>
      <ProductListPage products={products} />
    </div>
  );
}
