import { getPublicGame } from "@/lib/gtb";
import { errorResponse, json } from "../../_utils";

export const runtime = "nodejs";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    return json(await getPublicGame(id));
  } catch (error) {
    return errorResponse(error);
  }
}
