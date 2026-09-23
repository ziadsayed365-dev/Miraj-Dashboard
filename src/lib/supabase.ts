import "server-only";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variables");
}

// Which Postgres schema to use. Miraj has its own dedicated Supabase project,
// so its tables live in "public" and SUPABASE_SCHEMA can be left unset. The
// override exists for sibling dashboards that co-locate in a shared project
// under a named schema of their own.
const schema = process.env.SUPABASE_SCHEMA || "public";

export const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false },
  // The real schema is applied at runtime; the `as "public"` keeps the client's
  // compile-time type identical to the default so every existing query/helper
  // (all typed against the standard client) still accepts it.
  db: { schema: schema as "public" },
});
