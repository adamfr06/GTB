import { decideReport } from "@/lib/gtb";
import { errorResponse, json, readBody, requireAdmin } from "../../../_utils";

export const runtime = "nodejs";

export async function POST(request, { params }) {
  try {
    const session = requireAdmin(request);
    const { id } = await params;
    const body = await readBody(request);
    return json(await decideReport(id, body.decision, session.username));
  } catch (error) {
    return errorResponse(error);
  }
}
