import { createGame } from "@/lib/gtb";
import { errorResponse, json, readBody } from "../_utils";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await readBody(request);
    return json(await createGame(body.blockId), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
