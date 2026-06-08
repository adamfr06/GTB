import { adminSessionCookie, createAdminSession, errorResponse, readBody, verifyAdminCredentials } from "../../_utils";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await readBody(request);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const admin = verifyAdminCredentials(body.username, body.password, ip);
    const token = createAdminSession(admin.username);
    return Response.json(
      { admin },
      {
        status: 200,
        headers: {
          "Set-Cookie": adminSessionCookie(token)
        }
      }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
