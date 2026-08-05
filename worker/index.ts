/** Cloudflare Worker entry point for the vinext-starter template. */
import handler from "vinext/server/app-router-entry";
import { GameRoom } from "./game-room";
import { ROOM_ID_PATTERN, normalizeRoomId } from "../app/game/room-id.ts";

export { GameRoom };

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}

interface Env {
  ASSETS: { fetch(request: Request): Response | Promise<Response> };
  ROOM: DurableObjectNamespaceLike;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      const roomId = normalizeRoomId(url.searchParams.get("roomId"));
      if (!ROOM_ID_PATTERN.test(roomId)) {
        return Response.json({ error: "invalid room" }, { status: 400 });
      }
      return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
    }

    // 项目未使用 next/image，/ _vinext/image 分支已移除（B045）：
    // 当前 wrangler.jsonc 没有 IMAGES 绑定，保留该分支会在命中时缺少绑定而报错。
    return handler.fetch(request, env, ctx);
  },
};

export default worker;