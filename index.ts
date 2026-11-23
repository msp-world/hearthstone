import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { HearthstoneWorld } from "./world.ts";

export async function startHearthstoneNode(): Promise<{ node: MSPNode; world: HearthstoneWorld }> {
  const node = new MSPNode(process.env.HS_NODE_ID || "hearthstone", mspOptionsFromEnv("HS"));
  const world = new HearthstoneWorld({ logPath: process.env.HS_POWER_LOG || "" });
  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[hearthstone] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startHearthstoneNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
