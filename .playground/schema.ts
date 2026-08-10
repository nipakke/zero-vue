import { createSchema, table, string, number, boolean } from "@rocicorp/zero";

export const schema = createSchema({
  tables: [
    table("item")
      .columns({
        id: number(),
        title: string(),
        done: boolean(),
        createdAt: number(),
      })
      .primaryKey("id"),
  ],
  enableLegacyMutators: true,
});

export type ItemRow = {
  id: number;
  title: string;
  done: boolean;
  createdAt: number;
};
