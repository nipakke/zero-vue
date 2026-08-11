import { describe, expect, test } from "vite-plus/test";
import { nextTick, shallowRef, watchEffect } from "vue";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { useConnectionState } from "../src/connection-state.ts";
import { createBindings } from "../src/create-bindings.ts";
import { Zero, createSchema, table, string, number } from "@rocicorp/zero";

const schema = createSchema({
  tables: [table("item").columns({ id: number(), name: string() }).primaryKey("id")],
  enableLegacyMutators: true,
});

// Silence Zero's "no server URL" startup log (each test spins up a Zero).
const silentLogSink = { log: () => {} };

describe("useConnectionState", () => {
  test("returns a connection state object on mount", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
    });

    let capturedState: unknown;

    const Child = defineComponent({
      setup() {
        const state = useConnectionState(z);
        watchEffect(() => {
          capturedState = { ...state.value };
        });
        return () => null;
      },
    });
    mount(Child);
    await nextTick();

    expect(capturedState).toBeDefined();
    expect(typeof capturedState).toBe("object");
    expect(capturedState).toHaveProperty("name");
  });

  test("reacts to a swapped reactive zero", async () => {
    // useConnectionState should unsubscribe from the old Zero and subscribe
    // to the new one when the reactive zero changes.
    const zeroA = new Zero({
      server: null,
      userID: "a",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
    });
    const zeroB = new Zero({
      server: null,
      userID: "b",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
    });
    const zeroRef = shallowRef(zeroA);

    let capturedName: string | undefined;

    const Child = defineComponent({
      setup() {
        const state = useConnectionState(zeroRef);
        watchEffect(() => {
          capturedName = state.value.name;
        });
        return () => null;
      },
    });
    mount(Child);
    await nextTick();

    const nameA = capturedName;
    expect(nameA).toBeDefined();

    // Swap to zeroB — the subscription should rebind.
    zeroRef.value = zeroB;
    await nextTick();

    // Both zeros have server: null, so connection state should be the same
    // type, but the ref should still reflect the new instance's state.
    expect(capturedName).toBeDefined();
    expect(capturedName).toBe(nameA); // same "disconnected" state name
  });

  test("createBindings exposes bound useConnectionState and useZero", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
    });
    const { useConnectionState, useZero } = createBindings(z);

    let capturedState: unknown;
    let capturedZeroId: unknown;

    const Child = defineComponent({
      setup() {
        const state = useConnectionState();
        const zRef = useZero();
        watchEffect(() => {
          capturedState = state.value.name;
          capturedZeroId = zRef.value.userID;
        });
        return () => null;
      },
    });
    mount(Child);
    await nextTick();

    // Bound useConnectionState tracks the shared zero.
    expect(capturedState).toBeTypeOf("string");
    // Bound useZero resolves the shared zero's value.
    expect(capturedZeroId).toBe("test");
  });
});
