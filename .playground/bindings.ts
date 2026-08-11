import { Zero } from "@rocicorp/zero";
import { createBindings } from "@nipakke/zero-vue";
import { schema } from "./schema.ts";
import { mutators } from "./mutators.ts";

export const zero = new Zero({
  server: null,
  userID: "playground-user",
  schema,
  kvStore: "idb",
  mutators,
});

export const { useQuery, useMutator } = createBindings(zero, { mutators });
