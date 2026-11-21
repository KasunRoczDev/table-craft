import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { streamAccess } from "@table-craft/desktop/engine/routes/streamAccess.js";

/** The topics of a `topics` datasource (plan 164): reads on the helper, writes on the admin session. */
export function topicsRoutes(connection: ConnectionContext): RoutesFor<"topics"> {
  const { read, prepare, write } = streamAccess(connection);
  const tails = () => connection.keyOperations.topicTails;
  return {
    "topics.list": ({ glob, internal }) => read("topics", (topics) => topics.list({ glob, internal })),
    "topics.describe": ({ topic }) => read("topics", (topics) => topics.describe(topic)),
    "topics.open": (request) => connection.openTopic(request),
    "topics.message": (request) => connection.topicMessage(request),
    "topics.produce": ({ record }) => write("topics", (topics) => topics.produce(record)),
    "topics.create": ({ request, validateOnly }) =>
      write("topics", async (topics) => {
        await topics.create(request, { validateOnly });
        return null;
      }),
    "topics.alterConfigs": ({ topic, changes, validateOnly }) =>
      write("topics", async (topics) => {
        await topics.alterConfigs(topic, changes, { validateOnly });
        return null;
      }),
    "topics.addPartitions": ({ topic, total, validateOnly }) =>
      write("topics", async (topics) => {
        await topics.addPartitions(topic, total, { validateOnly });
        return null;
      }),
    "topics.prepareDeleteRecords": ({ topic, partitions, before }) =>
      prepare("topics", (topics) => topics.prepareDeleteRecords(topic, partitions, before)),
    "topics.deleteRecords": ({ token }) =>
      write("topics", async (topics) => {
        await topics.deleteRecordsPrepared(token);
        return null;
      }),
    "topics.delete": ({ topic }) =>
      write("topics", async (topics) => {
        await topics.remove(topic);
        return null;
      }),
    "topics.tailStart": (request) => tails().start(request),
    "topics.tailWindow": (request) => Promise.resolve(tails().window(request)),
    "topics.tailStop": async ({ tailId }) => {
      await tails().stop(tailId);
      return null;
    },
    "topics.tailClear": ({ tailId }) => {
      tails().clear(tailId);
      return Promise.resolve(null);
    },
    "topics.tailList": () => Promise.resolve(tails().list()),
    "topics.tailMessage": ({ tailId, sequence }) => tails().message(tailId, sequence),
  };
}
