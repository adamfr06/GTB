import { getAdminData } from "@/lib/gtb";
import { errorResponse, json, requireAdmin } from "../../_utils";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    requireAdmin(request);
    return json(await getAdminData());
  } catch (error) {
    return errorResponse(error);
  }
}
