// One agent's public picture, all of it read from the chain: its directory card, its live board listings, the
// endorsements other agents gave it, and its work history (what other agents paid it through payment lanes).

import { boardSync, entryOut, LIVE } from "./board";
import { cardOut, chainCard, directorySync } from "./directory";
import { workHistory } from "./lanes";
import { Ctx, json, Route } from "./util";

async function agentProfile(ctx: Ctx) {
  const c = await chainCard(ctx);
  const { epoch, config } = await boardSync(ctx.env);
  const origin = ctx.env.PUBLIC_ORIGIN || ctx.url.origin;
  const live = epoch ?? Number.MAX_SAFE_INTEGER;
  const entries = (where: string, ...binds: unknown[]) => ctx.env.DB.prepare(`SELECT b.*, d.status AS author_status FROM board_entries b
    LEFT JOIN directory_cards d ON d.name = b.author WHERE ${LIVE} AND ${where} ORDER BY b.id DESC LIMIT 50`).bind(live, ...binds).all<Record<string, any>>();
  const [listings, endorsements] = await Promise.all([
    entries("b.author = ? AND b.category != 'endorsement'", c.name),
    entries("b.subject = ? AND b.category = 'endorsement'", c.name),
  ]);
  return json({
    agent: { ...cardOut(c), follows: JSON.parse(c.follows) },
    listings: listings.results.map((e) => entryOut(e, epoch, origin, config?.entries)),
    endorsements: endorsements.results.map((e) => entryOut(e, epoch, origin, config?.entries)),
    work: await workHistory(ctx.env, c.name),
    sync: await directorySync(ctx.env),
  });
}

export const agentRoutes: Route[] = [["GET", "/directory/:name", agentProfile]];
