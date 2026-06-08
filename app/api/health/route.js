import { health } from "@/lib/gtb";
import { errorResponse, json } from "../_utils";

export const runtime = "nodejs";

export async function GET() {
  try {
    return json(await health());
  } catch (error) {
    return errorResponse(error);
  }
}
