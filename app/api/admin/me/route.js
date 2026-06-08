import { adminConfigStatus, errorResponse, json, optionalAdmin } from "../../_utils";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    return json({
      admin: optionalAdmin(request),
      config: adminConfigStatus()
    });
  } catch (error) {
    return errorResponse(error);
  }
}
