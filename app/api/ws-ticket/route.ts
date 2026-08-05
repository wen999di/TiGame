import { roomFetch, roomStub } from "../_lib/room-env";
import { ROOM_ID_PATTERN, normalizeRoomId } from "../../game/room-id";

// 认证 HTTP：用长期 token（Authorization: Bearer）换取 30 秒、单次使用的 WebSocket ticket（B021）。
export async function POST(request: Request) {
  const url = new URL(request.url);
  const roomId = normalizeRoomId(url.searchParams.get("roomId"));
  const playerId = url.searchParams.get("playerId") ?? "";
  if (!ROOM_ID_PATTERN.test(roomId) || !playerId) {
    return Response.json({ error: "invalid-session" }, { status: 403 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!auth) {
    return Response.json({ error: "invalid-session" }, { status: 403 });
  }
  const stub = await roomStub(roomId);
  // 只转发 Authorization，不透传 Cookie/Host 等客户端信息（B032）。
  return roomFetch(
    stub,
    `http://room/api/ws-ticket?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(playerId)}`,
    {
      method: "POST",
      headers: { authorization: auth },
    },
  );
}