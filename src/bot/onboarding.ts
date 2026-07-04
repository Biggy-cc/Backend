import type { Context } from "grammy";
import {
  replyStartPaywalled,
  replyStartWithAccess,
} from "./subscribe-offer.js";
import { hasAccess, upsertUser } from "../db/users.js";

/** One welcome bubble with trial status + today's tier menu. */
export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const user = await upsertUser(ctx.from.id, ctx.from.username, ctx.from.first_name);

  if (!hasAccess(user)) {
    await replyStartPaywalled(ctx, user);
    return;
  }

  await replyStartWithAccess(ctx, user);
}
