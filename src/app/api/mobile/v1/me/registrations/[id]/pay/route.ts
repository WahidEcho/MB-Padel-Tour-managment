import { ownAction } from "../action";

/** POST → MRegistrationResult (see ../action.ts). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return ownAction(request, id, "pay");
}
