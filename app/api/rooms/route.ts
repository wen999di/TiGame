import { roomFetch, roomStub } from "../_lib/room-env";
import { ROOM_ID_PATTERN, normalizeRoomId } from "../../game/room-id";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as { roomId?: string } | null;
  const roomId = normalizeRoomId(payload?.roomId);
  if (!ROOM_ID_PATTERN.test(roomId)) {
    return Response.json({ error: "房间信息不完整" }, { status: 400 });
  }
  const stub = await roomStub(roomId);
  // 只转发必要的 Header，不透传 Cookie/Host 等客户端信息（B032）。
  return roomFetch(stub, "http://room/api/rooms", {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    body: JSON.stringify(payload),
  });
}