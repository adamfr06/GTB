import { listBlocks } from "@/lib/gtb";
import { errorResponse, json } from "../_utils";

export const runtime = "nodejs";

export async function GET() {
  try {
    return json({ blocks: await listBlocks() });
  } catch (error) {
    return errorResponse(error);
  }
}
