/** AgentSettings singleton (id = 1): the pricing rules. */
import type { AgentSettings } from "@prisma/client";
import { db, type Tx } from "../../db";

export async function getSettings(client: Tx | typeof db = db): Promise<AgentSettings> {
  // Created with schema defaults if the seed never ran (e.g. a fresh production database).
  return client.agentSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}
