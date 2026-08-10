import { Zero } from "@rocicorp/zero";
import { createBindings } from "@nipakke/zero-vue";
import { schema } from "./schema.ts";

export const zero = new Zero({ server: null, userID: "playground-user", schema, kvStore: "idb" });

export const { useQuery } = createBindings(zero);
