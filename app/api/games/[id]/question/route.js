import { askQuestion } from "@/lib/gtb";
import { errorResponse, json, readBody } from "../../../_utils";

export const runtime = "nodejs";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await readBody(request);
    return json(await askQuestion(id, body.question));
  } catch (error) {
    return errorResponse(error);
  }
}
