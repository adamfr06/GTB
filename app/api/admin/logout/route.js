import { clearAdminSessionCookie, errorResponse } from "../../_utils";

export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(
      { ok: true },
      {
        status: 200,
        headers: {
          "Set-Cookie": clearAdminSessionCookie()
        }
      }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
