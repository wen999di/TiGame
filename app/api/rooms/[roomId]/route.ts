import { roomFetch, roomStub } from "../../_lib/room-env";
import { ROOM_ID_PATTERN, normalizeRoomId } from "../../../game/room-id";

export async function GET(request: Request, context: { params: Promise<{ roomId: string }> }) {
  const { roomId: rawRoomId } = await context.params;
  const roomId = normalizeRoomId(rawRoomId);
  if (!ROOM_ID_PATTERN.test(roomId)) {
    return Response.json({ error: "房间号格式不正确" }, { status: 400 });
  }
  const stub = await roomStub(roomId);
  // playerId 不是秘密可以放查询参数；长期 token 只走 Authorization 头（B021）。
  const url = new URL(request.url);
  const playerId = url.searchParams.get("playerId") ?? "";
  const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
  const auth = request.headers.get("authorization") ?? "";
  return roomFetch(
    stub,
    `http://room/api/rooms/${roomId}${qs}`,
    auth ? { headers: { authorization: auth } } : undefined,
  );
}