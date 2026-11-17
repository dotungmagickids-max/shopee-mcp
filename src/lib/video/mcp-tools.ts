import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApiKeyContext } from "../api-keys";
import { listVideoUsers, resolveVideoUser, videoConfig, videoConfigured } from "./client";
import { createShopeeVideo, listVideos, publishShopeeVideo } from "./ops";

const text = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

function safe<A>(fn: (a: A) => Promise<CallToolResult>) {
  return async (a: A): Promise<CallToolResult> => {
    try {
      if (!videoConfigured()) return { isError: true, content: [{ type: "text", text: "Shopee Video chưa cấu hình trên máy chủ." }] };
      return await fn(a);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  };
}

const info = {
  user_id: z.number().int().optional().describe("Shopee Video user_id; omit when only one account is authorized"),
  caption: z.string().max(2000).optional(),
  item_ids: z.array(z.number().int()).max(6).optional().describe("Shopee item_id to link (max 6)"),
  scheduled_post_time: z.number().int().optional().describe("Unix MILLISECONDS to post at (needs post=true)"),
  post: z
    .boolean()
    .default(false)
    .describe("false = save as draft for review (default); true = post now or at scheduled_post_time. Confirm with the owner first."),
  aigc_label: z.boolean().default(false).describe("true if the video has AI-generated content"),
};

/** Shopee Video tools (separate "Magickids Video" app, user-level token). */
export function registerShopeeVideoTools(server: McpServer, ctx: ApiKeyContext): void {
  const by = `mcp:${ctx.label ?? ctx.id}`;

  server.registerTool(
    "shopee_video_list",
    {
      title: "Shopee Video: list",
      description: "Shopee Video account status and its draft or posted videos (views, likes, linked items).",
      inputSchema: {
        list_type: z.enum(["draft", "post"]).default("post"),
        page: z.number().int().min(1).default(1),
        user_id: info.user_id,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ list_type, page, user_id }) => {
      const users = await listVideoUsers();
      if (!users.length) return text({ env: videoConfig().env, users: [], note: "Chưa ủy quyền. Mở /video để ủy quyền." });
      const id = await resolveVideoUser(user_id);
      return text({ env: videoConfig().env, user_id: id, ...(await listVideos(id, list_type, page)) });
    })
  );

  if (ctx.access !== "read_write") return;

  server.registerTool(
    "shopee_video_create",
    {
      title: "Shopee Video: upload and post",
      description:
        "Upload an MP4 (1–180s) from a public https URL to Shopee Video, set caption / up to 6 products / schedule. " +
        "Default saves a DRAFT; post=true publishes (or schedules). If Shopee is still transcoding, returns the " +
        "video_upload_id: call shopee_video_publish with it a few minutes later.",
      inputSchema: {
        video_url: z.string().describe("Public https URL of the video file"),
        duration_seconds: z.number().int().min(1).max(180).optional().describe("Only needed if not an MP4/MOV"),
        ...info,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (a) => text(await createShopeeVideo({ ...a, created_by: by })))
  );

  server.registerTool(
    "shopee_video_publish",
    {
      title: "Shopee Video: finish / post",
      description:
        "For an uploaded video (video_upload_id): set caption, products, cover, schedule; post=true publishes. " +
        "Use after shopee_video_create returned step 'transcoding', or to post a draft.",
      inputSchema: {
        video_upload_id: z.string(),
        cover_image_url: z.string().optional().describe("Default: first frame Shopee suggests"),
        ...info,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (a) => text(await publishShopeeVideo({ ...a, created_by: by })))
  );
}
