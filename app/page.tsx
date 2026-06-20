import { buildPayload } from "@/lib/queries";
import Home from "./Home";

// Always read fresh from the database (data is refreshed by the cron pipeline).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const payload = await buildPayload();
  return <Home payload={payload} />;
}
