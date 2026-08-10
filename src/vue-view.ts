import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import {
  type Change,
  type Entry,
  type ErroredQuery,
  type Format,
  type HumanReadable,
  type Input,
  type Output,
  type Query,
  type Schema,
  type Stream,
  type TTL,
} from "@rocicorp/zero";
import { applyChange, skipYields, type ViewChange } from "@rocicorp/zero/bindings";

/** Completeness/error state of a query result. `"disabled"` when the query is off (falsy signal). */
export type QueryStatus = "complete" | "unknown" | "error" | "disabled";

/** Error payload surfaced when `status` is `"error"`. */
export type QueryError = {
  type: string;
  message: string;
  details?: unknown;
  /** Re-materializes the current query. */
  retry: () => void;
};

/** Error payload held on the view, before `retry` is attached. */
type ViewError = Omit<QueryError, "retry">;
/** Statuses a live view can report (no `"disabled"` — that's the no-view state). */
type ViewStatus = Exclude<QueryStatus, "disabled">;
/** The schema type `Input` hands out (not publicly exported by Zero). */
type SourceSchema = ReturnType<Input["getSchema"]>;

/** Maps a raw IVM `Change` tuple to the `ViewChange` shape `applyChange` consumes. */
function changeToViewChange(change: Change): ViewChange {
  switch (change[0]) {
    case 0: // ADD
      return { type: "add", node: change[1] };
    case 1: // REMOVE
      return { type: "remove", node: change[1] };
    case 2: // EDIT
      return { type: "edit", node: change[1], oldNode: change[2] };
    case 3: // CHILD
      return {
        type: "child",
        node: change[1],
        child: {
          relationshipName: change[2].relationshipName,
          change: changeToViewChange(change[2].change),
        },
      };
    default: {
      const _exhaustive: never = change[0];
      throw new Error(`Unknown change type: ${String(_exhaustive)}`);
    }
  }
}

function toViewError(error: ErroredQuery): ViewError {
  const message = error.message ?? "An unknown error occurred";
  return {
    type: error.error,
    message,
    ...(error.details ? { details: error.details } : {}),
  };
}

/**
 * A Vue-reactive materialized view, produced by `zero.materialize(query,
 * vueViewFactory, options)`.
 *
 * Implements Zero's `Output` view contract (the same pattern as its built-in
 * `ArrayView`): it reads the initial result via `input.fetch()`, applies
 * incremental `push()` changes, and flushes on transaction commit. Instead of
 * listeners, it exposes the materialized result as Vue reactive refs:
 * `data`, `status` (`'complete' | 'unknown' | 'error'`), and `error`.
 */
export class VueView<TReturn> implements Output {
  readonly #input: Input;
  readonly #schema: SourceSchema;
  readonly #format: Format;
  #root: Entry;
  #dirty = false;
  #txnDirty = new WeakSet<object>();
  readonly #onDestroy: () => void;
  readonly #updateTTL: (ttl: TTL) => void;

  /** Reactive query rows. `undefined` for an empty singular result. */
  readonly data: ShallowRef<HumanReadable<TReturn> | undefined>;
  /** Reactive completeness/error state. */
  readonly status: Ref<ViewStatus>;
  /** Reactive error payload (set when `status` is `"error"`). */
  readonly error: ShallowRef<ViewError | undefined>;

  constructor(
    input: Input,
    format: Format,
    onDestroy: () => void,
    onTransactionCommit: (cb: () => void) => void,
    queryComplete: true | ErroredQuery | Promise<true>,
    updateTTL: (ttl: TTL) => void,
  ) {
    this.#input = input;
    this.#schema = input.getSchema();
    this.#format = format;
    this.#onDestroy = onDestroy;
    this.#updateTTL = updateTTL;
    // Synthetic "root" entry with a single "" relationship, mirroring ArrayView.
    this.#root = { "": format.singular ? undefined : [] };

    this.data = shallowRef(this.#root[""]) as ShallowRef<HumanReadable<TReturn> | undefined>;
    this.status = ref<ViewStatus>("unknown");
    this.error = shallowRef<ViewError | undefined>(undefined);

    input.setOutput(this);
    onTransactionCommit(() => this.#flush());

    this.#handleQueryComplete(queryComplete);
    this.#hydrate();
  }

  #handleQueryComplete(queryComplete: true | ErroredQuery | Promise<true>): void {
    if (queryComplete === true) {
      this.status.value = "complete";
    } else if ("error" in queryComplete) {
      this.status.value = "error";
      this.error.value = toViewError(queryComplete);
    } else {
      void queryComplete
        .then(() => {
          this.status.value = "complete";
          this.error.value = undefined;
        })
        .catch((e: ErroredQuery) => {
          this.status.value = "error";
          this.error.value = toViewError(e);
        });
    }
  }

  #hydrate(): void {
    this.#dirty = true;
    for (const node of skipYields(this.#input.fetch({}))) {
      this.#root = applyChange(
        this.#root,
        { type: "add", node },
        this.#schema,
        "",
        this.#format,
        false /* withIDs */,
        true /* mutate: fresh root not yet observed by any consumer */,
      );
    }
    this.#flush();
  }

  push(change: Change): Stream<"yield"> {
    this.#dirty = true;
    this.#root = applyChange(
      this.#root,
      changeToViewChange(change),
      this.#schema,
      "",
      this.#format,
      false /* withIDs */,
      this.#txnDirty /* mutate: copy-on-write within this transaction */,
    );
    return [] as Stream<"yield">;
  }

  #flush(): void {
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;
    this.data.value = this.#root[""] as HumanReadable<TReturn> | undefined;
    this.#txnDirty = new WeakSet();
  }

  updateTTL(ttl: TTL): void {
    this.#updateTTL(ttl);
  }

  destroy(): void {
    this.#onDestroy();
  }
}

/**
 * View factory for `zero.materialize(query, vueViewFactory, options)` that
 * produces a {@link VueView}.
 */
export function vueViewFactory<
  TTable extends keyof TSchema["tables"] & string,
  TSchema extends Schema,
  TReturn,
>(
  _query: Query<TTable, TSchema, TReturn>,
  input: Input,
  format: Format,
  onDestroy: () => void,
  onTransactionCommit: (cb: () => void) => void,
  queryComplete: true | ErroredQuery | Promise<true>,
  updateTTL: (ttl: TTL) => void,
): VueView<TReturn> {
  return new VueView(input, format, onDestroy, onTransactionCommit, queryComplete, updateTTL);
}
