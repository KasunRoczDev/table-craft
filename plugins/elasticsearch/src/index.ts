import { definePlugin, type CommandLanguage } from "@table-craft/plugin-api";
import { complete } from "./complete.js";
import { connectionSchema } from "./config.js";
import { classify, split } from "./language.js";
import { CAPABILITIES, ElasticSession } from "./session.js";

const PLUGIN_ID = "elasticsearch";

const commandLanguage: CommandLanguage = { split, classify, complete };

export default definePlugin({
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  commandLanguage,
  connectionSchema,
  connect: (config, options) => ElasticSession.open(connectionSchema.parse(config), options),
});
